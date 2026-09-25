import { MemoryGraphStore, isSnapshotable, type GraphStore } from './store/memory-store.js';
import { IngestPipeline } from './pipeline/ingest.js';
import { bm25Scores, cosineSimilarity, rrfFuseScored } from './search/retrieval.js';
import { HashEmbedder, MockLLMProvider, type Embedder, type LLMProvider } from './provider/index.js';
import type { EntityEdge, EntityNode, FactWithContext } from './model/types.js';
import { isFactActive, isFactKnown } from './model/types.js';

/**
 * A store that can run retrieval itself (pgvector + Postgres full-text search).
 * When present, search no longer loads every fact into Node.
 */
export interface SearchCapableStore extends GraphStore {
  /** activeAt null = no valid-time filter; asOf = knowledge-time cut (default now) */
  searchFactsByVector(
    embedding: number[],
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date },
  ): Promise<{ edge: EntityEdge; distance: number }[]>;
  searchFactsByText(
    query: string,
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date },
  ): Promise<{ edge: EntityEdge; score: number }[]>;
  getFactsByUuids(uuids: string[]): Promise<EntityEdge[]>;
}

function isSearchCapable(store: GraphStore): store is SearchCapableStore {
  const s = store as Partial<SearchCapableStore>;
  return (
    typeof s.searchFactsByVector === 'function' &&
    typeof s.searchFactsByText === 'function' &&
    typeof s.getFactsByUuids === 'function'
  );
}

export interface SearchOptions {
  groupId?: string;
  limit?: number;
  /** time travel: only facts true at this instant (valid time, default now) */
  at?: Date;
  /** what the graph knew at this instant (knowledge time, default now) */
  asOf?: Date;
  /** include facts that were true once but no longer */
  includeHistorical?: boolean;
}

/** Search results plus whether they came from a reduced (keyword-only) ranking. */
export interface SearchResult {
  results: FactWithContext[];
  /** true when the query could not be embedded and only keyword ranking ran */
  degraded: boolean;
}

/** factsAbout with the entity it resolved to and the other plausible matches. */
export interface FactsAboutResult {
  /** the best match for the name, whose facts are returned */
  entity?: EntityNode;
  facts: FactWithContext[];
  /** other entities the name could refer to, best first */
  candidates: EntityNode[];
}

/** name-embedding similarity needed for findEntities' last tier */
const ENTITY_NAME_COSINE = 0.75;

/**
 * Minizep — a minimal temporal knowledge-graph memory for AI agents.
 *
 * Layers (mirroring Graphiti):
 *   L0 episodes  — raw ingested data, full provenance
 *   L1 entities  — extracted nodes with evolving summaries
 *   L1 facts     — edges with validity windows; superseded, never deleted
 *
 * Retrieval: BM25 + cosine, fused with RRF, filtered by temporal validity.
 */
export class Minizep {
  readonly store: GraphStore;
  readonly ingest: IngestPipeline;
  /** the embedder used for BOTH document and query vectors — they must match */
  readonly embedder: Embedder;

  constructor(opts?: { store?: GraphStore; llm?: LLMProvider; embedder?: Embedder }) {
    this.store = opts?.store ?? new MemoryGraphStore();
    this.embedder = opts?.embedder ?? new HashEmbedder();
    this.ingest = new IngestPipeline(
      this.store,
      opts?.llm ?? new MockLLMProvider(),
      this.embedder,
    );
  }

  /** Hybrid search over facts (edges). Returns facts with resolved names. */
  async searchFacts(query: string, opts: SearchOptions = {}): Promise<FactWithContext[]> {
    return (await this.searchFactsDetailed(query, opts)).results;
  }

  /**
   * Hybrid search that also reports degradation. Search degrades instead of
   * failing: when the query cannot be embedded (embedding service down), the
   * keyword ranking alone is returned with `degraded: true`.
   */
  async searchFactsDetailed(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const { groupId, limit = 10, at, asOf, includeHistorical = false } = opts;
    // Prefer a store that can run retrieval itself: it avoids loading the whole
    // graph into memory, which is the difference between working at a thousand
    // facts and at a million.
    if (isSearchCapable(this.store)) {
      return this.searchNatively(query, { groupId, limit, at, asOf, includeHistorical });
    }

    const all = await this.store.getFacts(groupId);
    const facts = all.filter((f) => (includeHistorical ? isFactKnown(f, asOf) : isFactActive(f, at, asOf)));
    if (facts.length === 0) return { results: [], degraded: false };

    // the query MUST be embedded by the same model that embedded the facts,
    // otherwise the two vectors live in different spaces and the scores are noise
    const queryVec = await this.embedQuery(query);

    // ranking 1: BM25 over fact text + entity names
    const nameOf = new Map((await this.store.getEntities(groupId)).map((e) => [e.uuid, e.name]));
    const docOf = (f: EntityEdge) => ({
      id: f.uuid,
      text: `${f.name} ${f.fact} ${nameOf.get(f.sourceNodeUuid) ?? ''} ${nameOf.get(f.targetNodeUuid) ?? ''}`,
    });
    const bm25 = bm25Scores(query, facts.map(docOf));
    const bm25Ranking = [...bm25.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    // ranking 2: cosine over fact embeddings (skipped when the query has no vector)
    const cosRanking = queryVec
      ? facts
          .map((f) => ({ id: f.uuid, score: f.factEmbedding ? cosineSimilarity(f.factEmbedding, queryVec) : 0 }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.id)
      : [];

    // RRF fusion
    const fused = rrfFuseScored([bm25Ranking, cosRanking]).slice(0, limit);
    const byId = new Map(facts.map((f) => [f.uuid, f]));
    return { results: withContext(fused, byId, nameOf), degraded: !queryVec };
  }

  /** The query vector, or undefined when the embedder is unavailable. */
  private async embedQuery(query: string): Promise<number[] | undefined> {
    try {
      const v = await this.embedder.embed(query);
      return v?.length ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Database-side hybrid retrieval: BM25-ish full-text + pgvector cosine,
   * fused with RRF. Only the fused candidates are fetched back.
   */
  private async searchNatively(
    query: string,
    opts: Required<Pick<SearchOptions, 'limit'>> & SearchOptions,
  ): Promise<SearchResult> {
    const store = this.store as SearchCapableStore;
    const { groupId, limit, at, asOf, includeHistorical } = opts;
    // null activeAt means "do not filter by valid time" (history requested)
    const activeAt = includeHistorical ? null : at;
    const depth = Math.max(limit * 4, 50);

    const queryVec = await this.embedQuery(query);
    const [byText, byVector] = await Promise.all([
      store.searchFactsByText(query, { groupId, limit: depth, activeAt, asOf }),
      queryVec ? store.searchFactsByVector(queryVec, { groupId, limit: depth, activeAt, asOf }) : [],
    ]);

    const fused = rrfFuseScored([byText.map((r) => r.edge.uuid), byVector.map((r) => r.edge.uuid)]).slice(0, limit);
    const edges = await store.getFactsByUuids(fused.map((r) => r.id));
    const byId = new Map(edges.map((e) => [e.uuid, e]));
    const nameOf = new Map((await this.store.getEntities(groupId)).map((e) => [e.uuid, e.name]));
    return { results: withContext(fused, byId, nameOf), degraded: !queryVec };
  }

  /**
   * Entities a (possibly partial) name refers to, best first: exact
   * case-insensitive matches, then names starting with it (or with a word
   * starting with it), then names containing it, then the nearest names by
   * embedding (cosine >= 0.75).
   */
  async findEntities(name: string, opts: { groupId?: string; limit?: number } = {}): Promise<EntityNode[]> {
    const limit = opts.limit ?? 10;
    const q = name.trim().toLowerCase();
    if (!q) return [];
    const all = await this.store.getEntities(opts.groupId);

    const tier = (e: EntityNode): number => {
      const n = e.name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q) || n.split(/[\s_\-.]+/).some((w) => w.startsWith(q))) return 1;
      if (n.includes(q)) return 2;
      return 3;
    };
    const lexical = all
      .map((e) => ({ e, t: tier(e) }))
      .filter((r) => r.t < 3)
      .sort((a, b) => a.t - b.t || a.e.name.length - b.e.name.length)
      .map((r) => r.e);
    if (lexical.length >= limit) return lexical.slice(0, limit);

    // semantic tier: other spellings, transliterations, abbreviations
    const rest = all.filter((e) => e.nameEmbedding?.length && !lexical.includes(e));
    if (rest.length === 0) return lexical;
    const qVec = await this.embedQuery(name.trim());
    if (!qVec) return lexical;
    const semantic = rest
      .map((e) => ({ e, score: cosineSimilarity(e.nameEmbedding!, qVec) }))
      .filter((r) => r.score >= ENTITY_NAME_COSINE)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.e);
    return [...lexical, ...semantic].slice(0, limit);
  }

  /** All facts about one entity, time-filtered. */
  async factsAbout(entityName: string, opts: SearchOptions = {}): Promise<FactWithContext[]> {
    return (await this.factsAboutDetailed(entityName, opts)).facts;
  }

  /**
   * Facts about the entity `entityName` refers to best (resolved with
   * findEntities, so "Alice" finds "Alice Chen"), newest first, plus the other
   * candidates so a caller can disambiguate.
   */
  async factsAboutDetailed(entityName: string, opts: SearchOptions = {}): Promise<FactsAboutResult> {
    const matches = await this.findEntities(entityName, { groupId: opts.groupId, limit: 10 });
    const best = matches[0];
    if (!best) return { facts: [], candidates: [] };
    // without a group, the same name may exist in several groups: all of them
    // are the best match
    const chosen = matches.filter((e) => e.name.toLowerCase() === best.name.toLowerCase());
    const nameOf = new Map((await this.store.getEntities(opts.groupId)).map((e) => [e.uuid, e.name]));
    const seen = new Set<string>();
    const facts: FactWithContext[] = [];
    for (const e of chosen) {
      for (const f of await this.store.getFactsForEntity(e.uuid)) {
        if (seen.has(f.uuid)) continue;
        seen.add(f.uuid);
        const visible = opts.includeHistorical ? isFactKnown(f, opts.asOf) : isFactActive(f, opts.at, opts.asOf);
        if (!visible) continue;
        facts.push({
          fact: f,
          sourceName: nameOf.get(f.sourceNodeUuid) ?? '',
          targetName: nameOf.get(f.targetNodeUuid) ?? '',
        });
      }
    }
    facts.sort((a, b) => factTime(b.fact) - factTime(a.fact));
    return {
      entity: best,
      facts: facts.slice(0, opts.limit ?? 50),
      candidates: matches.filter((e) => !chosen.includes(e)),
    };
  }

  /** Time travel: what was true at instant T (as known at `asOf`, default now)? */
  async factsAt(
    at: Date,
    groupId?: string,
    opts: { asOf?: Date; limit?: number } = {},
  ): Promise<FactWithContext[]> {
    const nameOf = new Map((await this.store.getEntities(groupId)).map((e) => [e.uuid, e.name]));
    return (await this.store.getFacts(groupId))
      .filter((f) => isFactActive(f, at, opts.asOf))
      .slice(0, opts.limit ?? Infinity)
      .map((f) => ({
        fact: f,
        sourceName: nameOf.get(f.sourceNodeUuid) ?? '',
        targetName: nameOf.get(f.targetNodeUuid) ?? '',
      }));
  }

  /** Dump the whole graph as JSON. Only in-memory stores can do this. */
  snapshot(): string {
    if (!isSnapshotable(this.store)) {
      throw new Error('this store is not snapshotable (a database backend persists itself)');
    }
    return this.store.toJSON();
  }

  /** Restore a JSON snapshot. Only in-memory stores can do this. */
  load(json: string): void {
    if (!isSnapshotable(this.store)) {
      throw new Error('this store does not support snapshot loading');
    }
    this.store.loadJSON(json);
  }
}

/** Fused ids -> facts with names and scores, dropping ids that did not resolve. */
function withContext(
  fused: { id: string; score: number }[],
  byId: Map<string, EntityEdge>,
  nameOf: Map<string, string>,
): FactWithContext[] {
  const out: FactWithContext[] = [];
  for (const { id, score } of fused) {
    const f = byId.get(id);
    if (!f) continue;
    out.push({
      fact: f,
      sourceName: nameOf.get(f.sourceNodeUuid) ?? f.sourceNodeUuid,
      targetName: nameOf.get(f.targetNodeUuid) ?? f.targetNodeUuid,
      score,
    });
  }
  return out;
}

/** when a fact starts (or was learned, when its start is unknown) */
function factTime(f: EntityEdge): number {
  return (f.validAt ?? f.createdAt).getTime();
}

export { MemoryGraphStore, isSnapshotable } from './store/memory-store.js';
export type { Snapshotable } from './store/memory-store.js';
export { PostgresStore } from './store/postgres-store.js';
export type { PostgresStoreOptions } from './store/postgres-store.js';
export type { GraphStore } from './store/memory-store.js';
export { FilePersistence } from './store/persistence.js';
export { IngestPipeline } from './pipeline/ingest.js';
export type { IngestResult, IngestOptions, EpisodeInput } from './pipeline/ingest.js';
export * from './model/types.js';
export * from './provider/index.js';
