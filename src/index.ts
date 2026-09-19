import { MemoryGraphStore, isSnapshotable, type GraphStore } from './store/memory-store.js';
import { IngestPipeline } from './pipeline/ingest.js';
import { bm25Scores, cosineSimilarity, rrfFuse } from './search/retrieval.js';
import { HashEmbedder, MockLLMProvider, type Embedder, type LLMProvider } from './provider/index.js';
import type { EntityEdge, EntityNode, FactWithContext } from './model/types.js';
import { isFactActive } from './model/types.js';

/**
 * A store that can run retrieval itself (pgvector + Postgres full-text search).
 * When present, search no longer loads every fact into Node.
 */
export interface SearchCapableStore extends GraphStore {
  searchFactsByVector(
    embedding: number[],
    opts: { groupId?: string; limit?: number; activeAt?: Date | null },
  ): Promise<{ edge: EntityEdge; distance: number }[]>;
  searchFactsByText(
    query: string,
    opts: { groupId?: string; limit?: number; activeAt?: Date | null },
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
  /** time travel: only facts true at this instant */
  at?: Date;
  /** include facts that were true once but no longer */
  includeHistorical?: boolean;
}

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
    const { groupId, limit = 10, at, includeHistorical = false } = opts;
    // Prefer a store that can run retrieval itself: it avoids loading the whole
    // graph into memory, which is the difference between working at a thousand
    // facts and at a million.
    if (isSearchCapable(this.store)) {
      return this.searchNatively(query, { groupId, limit, at, includeHistorical });
    }

    const all = await this.store.getFacts(groupId);
    const facts = all.filter((f) => (includeHistorical ? true : isFactActive(f, at)));
    if (facts.length === 0) return [];

    // the query MUST be embedded by the same model that embedded the facts,
    // otherwise the two vectors live in different spaces and the scores are noise
    const queryVec = await this.embedder.embed(query);

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

    // ranking 2: cosine over fact embeddings
    const cosRanking = facts
      .map((f) => ({
        id: f.uuid,
        score: f.factEmbedding && queryVec ? cosineSimilarity(f.factEmbedding, queryVec) : 0,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.id);

    // RRF fusion
    const fused = rrfFuse([bm25Ranking, cosRanking]).slice(0, limit);
    const byId = new Map(facts.map((f) => [f.uuid, f]));
    return fused
      .map((id) => byId.get(id))
      .filter((f): f is EntityEdge => !!f)
      .map((f) => ({
        fact: f,
        sourceName: nameOf.get(f.sourceNodeUuid) ?? f.sourceNodeUuid,
        targetName: nameOf.get(f.targetNodeUuid) ?? f.targetNodeUuid,
      }));
  }

  /**
   * Database-side hybrid retrieval: BM25-ish full-text + pgvector cosine,
   * fused with RRF. Only the fused candidates are fetched back.
   */
  private async searchNatively(query: string, opts: Required<Pick<SearchOptions, 'limit'>> & SearchOptions): Promise<FactWithContext[]> {
    const store = this.store as SearchCapableStore;
    const { groupId, limit, at, includeHistorical } = opts;
    // null activeAt means "do not filter by time" (history requested)
    const activeAt = includeHistorical ? null : at;

    const queryVec = await this.embedder.embed(query);
    const [byText, byVector] = await Promise.all([
      store.searchFactsByText(query, { groupId, limit: Math.max(limit * 4, 50), activeAt }),
      store.searchFactsByVector(queryVec, { groupId, limit: Math.max(limit * 4, 50), activeAt }),
    ]);

    const fused = rrfFuse([byText.map((r) => r.edge.uuid), byVector.map((r) => r.edge.uuid)]).slice(0, limit);
    const edges = await store.getFactsByUuids(fused);
    const byId = new Map(edges.map((e) => [e.uuid, e]));
    const nameOf = new Map((await this.store.getEntities(groupId)).map((e) => [e.uuid, e.name]));

    return fused
      .map((id) => byId.get(id))
      .filter((f): f is EntityEdge => !!f)
      .map((f) => ({
        fact: f,
        sourceName: nameOf.get(f.sourceNodeUuid) ?? f.sourceNodeUuid,
        targetName: nameOf.get(f.targetNodeUuid) ?? f.targetNodeUuid,
      }));
  }

  /** All facts about one entity, time-filtered. */
  async factsAbout(entityName: string, opts: SearchOptions = {}): Promise<FactWithContext[]> {
    const allEntities = await this.store.getEntities(opts.groupId);
    const entities = allEntities.filter(
      (e: EntityNode) => e.name.toLowerCase() === entityName.toLowerCase(),
    );
    const nameOf = new Map(allEntities.map((e) => [e.uuid, e.name]));
    const out: FactWithContext[] = [];
    for (const e of entities) {
      for (const f of await this.store.getFactsForEntity(e.uuid)) {
        if (!opts.includeHistorical && !isFactActive(f, opts.at)) continue;
        out.push({
          fact: f,
          sourceName: nameOf.get(f.sourceNodeUuid) ?? '',
          targetName: nameOf.get(f.targetNodeUuid) ?? '',
        });
      }
    }
    return out.slice(0, opts.limit ?? 50);
  }

  /** Time travel: what did we believe was true at instant T? */
  async factsAt(at: Date, groupId?: string): Promise<FactWithContext[]> {
    const nameOf = new Map((await this.store.getEntities(groupId)).map((e) => [e.uuid, e.name]));
    return (await this.store.getFacts(groupId))
      .filter((f) => isFactActive(f, at))
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

export { MemoryGraphStore, isSnapshotable } from './store/memory-store.js';
export type { Snapshotable } from './store/memory-store.js';
export { PostgresStore } from './store/postgres-store.js';
export type { PostgresStoreOptions } from './store/postgres-store.js';
export type { GraphStore } from './store/memory-store.js';
export { FilePersistence } from './store/persistence.js';
export type { IngestResult } from './pipeline/ingest.js';
export * from './model/types.js';
export * from './provider/index.js';
