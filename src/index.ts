import { MemoryGraphStore, isSnapshotable, type GraphStore } from './store/memory-store.js';
import { IngestPipeline, mentions } from './pipeline/ingest.js';
import { bm25Scores, cosineSimilarity } from './search/retrieval.js';
import { DEFAULT_MIN_COSINE, graphDistances, rerank, type SearchCandidate } from './search/rerank.js';
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
  /**
   * Facts touching any of `entityUuids`, under the same group and time filter
   * as the two searches, nearest to `embedding` first when one is given.
   */
  searchFactsByEntities(
    entityUuids: string[],
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date; embedding?: number[] },
  ): Promise<EntityEdge[]>;
}

function isSearchCapable(store: GraphStore): store is SearchCapableStore {
  const s = store as Partial<SearchCapableStore>;
  return (
    typeof s.searchFactsByVector === 'function' &&
    typeof s.searchFactsByText === 'function' &&
    typeof s.getFactsByUuids === 'function' &&
    typeof s.searchFactsByEntities === 'function'
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
  /**
   * Cosine a result needs when it shares no keyword with the query and is not
   * near an entity the query names (default: MINIZEP_SEARCH_MIN_COSINE, else
   * 0.4). Such results below it are dropped, so an unrelated query can return
   * nothing. -1 keeps everything.
   */
  minCosine?: number;
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
 * Query-to-name similarity for a search query to be about an entity it does
 * not name. Lower than ENTITY_NAME_COSINE: the question's other words pull a
 * whole query away from a bare name ("Who runs Acme?" and "Acme Corporation"
 * score about 0.72 on Qwen3-Embedding-0.6B).
 */
const QUERY_ENTITY_COSINE = 0.7;
/** most entities a query is matched to by name embedding */
const QUERY_ENTITY_MAX = 3;
/** most facts the graph neighbourhood adds to a database search's candidates */
const MAX_NEIGHBOURHOOD_FACTS = 200;

/**
 * Minizep — a minimal temporal knowledge-graph memory for AI agents.
 *
 * Layers (mirroring Graphiti):
 *   L0 episodes  — raw ingested data, full provenance
 *   L1 entities  — extracted nodes with evolving summaries
 *   L1 facts     — edges with validity windows; superseded, never deleted
 *
 * Retrieval: BM25 + cosine, fused with RRF, nudged towards facts near the
 * entities the query names, cut to the relevant ones, filtered by temporal
 * validity.
 */
export class Minizep {
  readonly store: GraphStore;
  readonly ingest: IngestPipeline;
  /** the embedder used for BOTH document and query vectors — they must match */
  readonly embedder: Embedder;

  /** default SearchOptions.minCosine: MINIZEP_SEARCH_MIN_COSINE, else DEFAULT_MIN_COSINE */
  readonly minCosine: number;

  constructor(opts?: { store?: GraphStore; llm?: LLMProvider; embedder?: Embedder }) {
    this.store = opts?.store ?? new MemoryGraphStore();
    this.embedder = opts?.embedder ?? new HashEmbedder();
    this.ingest = new IngestPipeline(
      this.store,
      opts?.llm ?? new MockLLMProvider(),
      this.embedder,
    );
    this.minCosine = envCosine('MINIZEP_SEARCH_MIN_COSINE', DEFAULT_MIN_COSINE);
  }

  /** Hybrid search over facts (edges). Returns facts with resolved names. */
  async searchFacts(query: string, opts: SearchOptions = {}): Promise<FactWithContext[]> {
    return (await this.searchFactsDetailed(query, opts)).results;
  }

  /**
   * Hybrid search that also reports degradation. Search degrades instead of
   * failing: when the query cannot be embedded (embedding service down), the
   * keyword ranking alone is returned with `degraded: true`.
   *
   * Both backends rank the same way (search/rerank.ts): keyword and vector
   * rankings fused with RRF, plus a bonus for facts on or next to an entity
   * the query names, then a relevance cut.
   */
  async searchFactsDetailed(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const { groupId, limit = 10, at, asOf, includeHistorical = false, minCosine = this.minCosine } = opts;
    // Prefer a store that can run retrieval itself: it avoids loading the whole
    // graph into memory, which is the difference between working at a thousand
    // facts and at a million.
    if (isSearchCapable(this.store)) {
      return this.searchNatively(query, { groupId, limit, at, asOf, includeHistorical, minCosine });
    }

    const all = await this.store.getFacts(groupId);
    const facts = all.filter((f) => (includeHistorical ? isFactKnown(f, asOf) : isFactActive(f, at, asOf)));
    if (facts.length === 0) return { results: [], degraded: false };

    // the query MUST be embedded by the same model that embedded the facts,
    // otherwise the two vectors live in different spaces and the scores are noise
    const queryVec = await this.embedQuery(query);

    // ranking 1: BM25 over fact text + entity names
    const entities = await this.store.getEntities(groupId);
    const nameOf = new Map(entities.map((e) => [e.uuid, e.name]));
    const docOf = (f: EntityEdge) => ({
      id: f.uuid,
      text: `${f.name} ${f.fact} ${nameOf.get(f.sourceNodeUuid) ?? ''} ${nameOf.get(f.targetNodeUuid) ?? ''}`,
    });
    const bm25 = bm25Scores(query, facts.map(docOf));
    const byText = facts
      .filter((f) => (bm25.get(f.uuid) ?? 0) > 0)
      .sort((a, b) => bm25.get(b.uuid)! - bm25.get(a.uuid)!);

    // ranking 2: cosine over fact embeddings (skipped when the query has no vector)
    const cosine = new Map<string, number>();
    if (queryVec) {
      for (const f of facts) {
        if (f.factEmbedding?.length) cosine.set(f.uuid, cosineSimilarity(f.factEmbedding, queryVec));
      }
    }
    const byVector = facts
      .filter((f) => (cosine.get(f.uuid) ?? 0) > 0)
      .sort((a, b) => cosine.get(b.uuid)! - cosine.get(a.uuid)!);

    // every visible fact is a candidate here, so the whole graph around the
    // query's entities is in reach
    const anchors = queryEntities(query, entities, queryVec);
    const distance = graphDistances(new Set(anchors.map((e) => e.uuid)), facts);
    const candidates = mergeCandidates(byText, byVector, facts, cosine);
    const ranked = rerank(candidates, distance, { limit, minCosine });
    return { results: withContext(ranked, nameOf), degraded: !queryVec };
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
   * Database-side hybrid retrieval: BM25-ish full-text and pgvector cosine
   * find the candidates, plus the facts around the entities the query names;
   * they are ranked in Node like the in-memory ones.
   */
  private async searchNatively(
    query: string,
    opts: Required<Pick<SearchOptions, 'limit' | 'minCosine'>> & SearchOptions,
  ): Promise<SearchResult> {
    const store = this.store as SearchCapableStore;
    const { groupId, limit, at, asOf, includeHistorical, minCosine } = opts;
    // null activeAt means "do not filter by valid time" (history requested)
    const scope = { groupId, activeAt: includeHistorical ? null : at, asOf };
    const depth = Math.max(limit * 4, 50);

    const queryVec = await this.embedQuery(query);
    const [byText, byVector, entities] = await Promise.all([
      store.searchFactsByText(query, { ...scope, limit: depth }),
      queryVec ? store.searchFactsByVector(queryVec, { ...scope, limit: depth }) : [],
      this.store.getEntities(groupId),
    ]);

    // the neighbourhood: facts touching a query entity, then facts touching
    // one of their other endpoints, the ones nearest the query first
    const anchors = new Set(queryEntities(query, entities, queryVec).map((e) => e.uuid));
    const around: EntityEdge[] = [];
    if (anchors.size > 0) {
      const near = { ...scope, embedding: queryVec };
      around.push(...(await store.searchFactsByEntities([...anchors], { ...near, limit: MAX_NEIGHBOURHOOD_FACTS })));
      const neighbours = new Set<string>();
      for (const f of around) {
        for (const id of [f.sourceNodeUuid, f.targetNodeUuid]) if (!anchors.has(id)) neighbours.add(id);
      }
      const room = MAX_NEIGHBOURHOOD_FACTS - around.length;
      if (neighbours.size > 0 && room > 0) {
        // the facts already found touch these neighbours too: ask for enough
        // that `room` new ones are left once they are skipped
        const seen = new Set(around.map((f) => f.uuid));
        const next = await store.searchFactsByEntities([...neighbours], { ...near, limit: room + seen.size });
        around.push(...next.filter((f) => !seen.has(f.uuid)).slice(0, room));
      }
    }

    // pgvector returned the `depth` nearest facts; any other candidate is
    // further away, so it ranks after them, by its own cosine
    const cosine = new Map<string, number>(byVector.map((r) => [r.edge.uuid, 1 - r.distance]));
    const vectorRanked = byVector.map((r) => r.edge);
    if (queryVec) {
      const extra = [...byText.map((r) => r.edge), ...around].filter(
        (f) => !cosine.has(f.uuid) && f.factEmbedding?.length,
      );
      for (const f of extra) cosine.set(f.uuid, cosineSimilarity(f.factEmbedding!, queryVec));
      vectorRanked.push(
        ...unique(extra)
          .filter((f) => cosine.get(f.uuid)! > 0)
          .sort((a, b) => cosine.get(b.uuid)! - cosine.get(a.uuid)!),
      );
    }

    const distance = graphDistances(anchors, around);
    const candidates = mergeCandidates(byText.map((r) => r.edge), vectorRanked, around, cosine);
    const ranked = rerank(candidates, distance, { limit, minCosine });
    const nameOf = new Map(entities.map((e) => [e.uuid, e.name]));
    return { results: withContext(ranked, nameOf), degraded: !queryVec };
  }

  /**
   * Entities a (possibly partial) name refers to, best first: exact
   * case-insensitive matches, then names starting with it (or with a word
   * starting with it), then names containing it, then the nearest names by
   * embedding (cosine >= 0.75). The embedding tier costs a call to the
   * embedding service, so it only runs when no name matches exactly: an exact
   * lookup stays a pure store read, and fast while that service is down.
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
    const exact = lexical.length > 0 && tier(lexical[0]) === 0;
    if (lexical.length >= limit || exact) return lexical.slice(0, limit);

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

/** Ranked facts with their endpoint names and scores. */
function withContext(ranked: { edge: EntityEdge; score: number }[], nameOf: Map<string, string>): FactWithContext[] {
  return ranked.map(({ edge: f, score }) => ({
    fact: f,
    sourceName: nameOf.get(f.sourceNodeUuid) ?? f.sourceNodeUuid,
    targetName: nameOf.get(f.targetNodeUuid) ?? f.targetNodeUuid,
    score,
  }));
}

/**
 * The entities a search query is about: those whose name it contains (the
 * rule ingestion uses for the entities a text mentions: whole words for Latin
 * names, anywhere for CJK ones, two characters at least), else the few whose
 * name embedding is nearest the query. As in findEntities, the embedding tier
 * only runs when no name matched: a name that merely shares words with the
 * question can score high by embedding without being what it asks about.
 */
function queryEntities(query: string, entities: EntityNode[], queryVec?: number[]): EntityNode[] {
  const text = fold(query);
  const named = entities.filter((e) => mentions(text, fold(e.name)));
  if (named.length > 0 || !queryVec) return named;
  return entities
    .filter((e) => e.nameEmbedding?.length)
    .map((e) => ({ e, score: cosineSimilarity(e.nameEmbedding!, queryVec) }))
    .filter((r) => r.score >= QUERY_ENTITY_COSINE)
    .sort((a, b) => b.score - a.score)
    .slice(0, QUERY_ENTITY_MAX)
    .map((r) => r.e);
}

/** Case- and width-insensitive form for name matching ("ＧＰＴ" is "gpt"). */
const fold = (s: string) => s.normalize('NFKC').toLowerCase();

/**
 * One candidate per fact, with its place in each ranking: keyword matches in
 * keyword order first, then the rest in vector order, then the others, so
 * equal scores keep the order the rankings gave.
 */
function mergeCandidates(
  byText: EntityEdge[],
  byVector: EntityEdge[],
  others: EntityEdge[],
  cosine: Map<string, number>,
): SearchCandidate[] {
  const keywordRank = new Map(byText.map((f, i) => [f.uuid, i + 1]));
  const vectorRank = new Map(byVector.map((f, i) => [f.uuid, i + 1]));
  return unique([...byText, ...byVector, ...others]).map((edge) => ({
    edge,
    keywordRank: keywordRank.get(edge.uuid),
    vectorRank: vectorRank.get(edge.uuid),
    cosine: cosine.get(edge.uuid),
  }));
}

/** The first fact of each uuid, in order. */
function unique(facts: EntityEdge[]): EntityEdge[] {
  const seen = new Set<string>();
  return facts.filter((f) => !seen.has(f.uuid) && seen.add(f.uuid));
}

/** A cosine threshold from the environment, or `fallback` when unset. */
function envCosine(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -1 || n > 1) throw new Error(`${name} must be a number from -1 to 1, got "${raw}"`);
  return n;
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
