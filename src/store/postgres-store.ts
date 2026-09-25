import { Pool, type PoolClient } from 'pg';
import { isFactActive, type EntityEdge, type EntityNode, type EpisodicNode, type UUID } from '../model/types.js';
import { tokenize } from '../search/retrieval.js';
import type { GraphStore } from './memory-store.js';

export interface PostgresStoreOptions {
  connectionString?: string;
  /** embedding dimension — must match the configured embedder */
  embeddingDims?: number;
  /**
   * Postgres schema to keep this graph in. Tests use a separate schema so they
   * cannot pollute (or be broken by) the production tables.
   */
  schema?: string;
}

const DEFAULT_URL = process.env.MINIZEP_DATABASE_URL ?? 'postgres://minizep@127.0.0.1:5433/minizep';

/**
 * Postgres + pgvector backend.
 *
 * Design notes:
 *  - `entities (group_id, lower(name))` is UNIQUE, so concurrent ingestion can
 *    never produce the duplicate-entity bug at the storage layer either.
 *  - embedding columns are `vector(N)` with N pinned at schema time. A mismatch
 *    is a hard error rather than a silently-wrong similarity score.
 *  - facts reference entities with ON DELETE CASCADE.
 */
export class PostgresStore implements GraphStore {
  private pool: Pool;
  readonly embeddingDims: number;
  private ready: Promise<void> | null = null;

  constructor(opts: PostgresStoreOptions = {}) {
    this.embeddingDims = opts.embeddingDims ?? Number(process.env.MINIZEP_EMBED_DIMS ?? 1024);
    this.schema = opts.schema ?? process.env.MINIZEP_DB_SCHEMA ?? 'public';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.schema)) {
      throw new Error(`invalid schema name: ${this.schema}`);
    }
    this.pool = new Pool({
      connectionString: opts.connectionString ?? DEFAULT_URL,
      max: 10,
      // fail fast: an unreachable database must not hang a request for a minute
      connectionTimeoutMillis: Number(process.env.MINIZEP_DB_TIMEOUT_MS ?? 3000),
      // Applied by the server on connect. `public` must stay on the path: the
      // pgvector `vector` type and its operators live where the extension was
      // created. Doing this here (rather than in a connect handler) avoids
      // racing an unawaited SET against the first real query.
      options: `-c search_path=${this.schema},public`,
    });
  }

  readonly schema: string;

  /** Idempotent schema creation; awaited by every public method via ensure(). */
  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const dims = this.embeddingDims;
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        if (!Number.isInteger(dims) || dims < 1 || dims > 16000) {
          throw new Error(`invalid embeddingDims: ${dims}`);
        }
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS episodes (
            uuid UUID PRIMARY KEY,
            group_id TEXT NOT NULL,
            name TEXT NOT NULL,
            source TEXT NOT NULL,
            source_description TEXT NOT NULL,
            content TEXT NOT NULL,
            valid_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            status TEXT,
            error TEXT,
            content_hash TEXT
          );
          CREATE INDEX IF NOT EXISTS episodes_group_hash ON episodes (group_id, content_hash);

          CREATE TABLE IF NOT EXISTS entities (
            uuid UUID PRIMARY KEY,
            group_id TEXT NOT NULL,
            name TEXT NOT NULL,
            labels TEXT[] NOT NULL DEFAULT '{}',
            summary TEXT NOT NULL DEFAULT '',
            attributes JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL,
            name_embedding vector(${dims})
          );
          CREATE UNIQUE INDEX IF NOT EXISTS entities_group_name ON entities (group_id, lower(name));

          CREATE TABLE IF NOT EXISTS facts (
            uuid UUID PRIMARY KEY,
            group_id TEXT NOT NULL,
            source_node_uuid UUID NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
            target_node_uuid UUID NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
            name TEXT NOT NULL,
            fact TEXT NOT NULL,
            episodes UUID[] NOT NULL DEFAULT '{}',
            valid_at TIMESTAMPTZ,
            invalid_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL,
            expired_at TIMESTAMPTZ,
            attributes JSONB NOT NULL DEFAULT '{}',
            fact_embedding vector(${dims})
          );
          CREATE INDEX IF NOT EXISTS facts_group ON facts (group_id);
          CREATE INDEX IF NOT EXISTS facts_source ON facts (source_node_uuid);
          CREATE INDEX IF NOT EXISTS facts_target ON facts (target_node_uuid);
        `);
        // HNSW indexes need a fixed dimension; created separately so a missing
        // pgvector version does not break the whole schema step.
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS entities_name_embedding_hnsw
            ON entities USING hnsw (name_embedding vector_cosine_ops);
          CREATE INDEX IF NOT EXISTS facts_fact_embedding_hnsw
            ON facts USING hnsw (fact_embedding vector_cosine_ops);
        `);
        // keyword search index. 'simple' is deliberate: it needs no language
        // dictionary, so it behaves predictably on mixed-language content.
        // (CJK still tokenises poorly — see README, pg_bigm/zhparser required.)
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS facts_fts
            ON facts USING gin (to_tsvector('simple', name || ' ' || fact));
        `);

        // CREATE TABLE IF NOT EXISTS silently keeps an existing column's vector
        // dimension, so a model change would otherwise surface as a confusing
        // per-write error. Detect it here, once, with a fix in the message.
        const actual = await this.columnDims();
        if (actual !== null && actual !== dims) {
          throw new Error(
            `embedding dimension mismatch: schema "${this.schema}" stores vector(${actual}) ` +
              `but the configured embedder produces ${dims} dimensions. ` +
              `Re-index with: npm run migrate -- <snapshot.json> --reembed ` +
              `(or DROP the tables to start empty).`,
          );
        }
      })();
    }
    return this.ready;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Dimension of the existing embedding column, or null when the table is new. */
  private async columnDims(): Promise<number | null> {
    const r = await this.pool.query(
      `SELECT atttypmod FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attname = 'name_embedding'`,
      [`${this.schema}.entities`],
    );
    const typmod = r.rows[0]?.atttypmod;
    return typmod == null || typmod < 0 ? null : Number(typmod);
  }

  /** Server-side truth check, used by tests and health endpoints. */
  async health(): Promise<{ ok: boolean; dims: number; facts: number }> {
    await this.ensure();
    const r = await this.pool.query('SELECT count(*)::int AS n FROM facts');
    return { ok: true, dims: this.embeddingDims, facts: r.rows[0].n };
  }

  /**
   * Drop all graph data (schema stays). Used by tests and by a re-index after
   * changing embedding models.
   */
  async reset(): Promise<void> {
    await this.ensure();
    await this.pool.query('TRUNCATE facts, entities, episodes CASCADE');
  }

  private vec(embedding?: number[]): string | null {
    if (!embedding || embedding.length === 0) return null;
    if (embedding.length !== this.embeddingDims) {
      throw new Error(
        `embedding dimension mismatch: store expects ${this.embeddingDims}, got ${embedding.length}. ` +
          `Changing the embedding model requires re-indexing (see README).`,
      );
    }
    return `[${embedding.join(',')}]`;
  }

  /* ---------------- episodes ---------------- */

  async addEpisode(ep: EpisodicNode): Promise<void> {
    await this.ensure();
    await this.pool.query(
      `INSERT INTO episodes (uuid, group_id, name, source, source_description, content,
                             valid_at, created_at, status, error, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (uuid) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, error = EXCLUDED.error,
         content_hash = EXCLUDED.content_hash`,
      [
        ep.uuid,
        ep.groupId,
        ep.name,
        ep.source,
        ep.sourceDescription,
        ep.content,
        ep.validAt,
        ep.createdAt,
        ep.status ?? null,
        ep.error ?? null,
        ep.contentHash ?? null,
      ],
    );
  }

  async getEpisode(uuid: UUID): Promise<EpisodicNode | undefined> {
    // the column is UUID-typed: anything else would be a query error, not a miss
    if (!UUID_RE.test(uuid)) return undefined;
    await this.ensure();
    const r = await this.pool.query('SELECT * FROM episodes WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToEpisode(r.rows[0]) : undefined;
  }

  async getEpisodes(groupId?: string): Promise<EpisodicNode[]> {
    await this.ensure();
    const r = groupId
      ? await this.pool.query('SELECT * FROM episodes WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.pool.query('SELECT * FROM episodes ORDER BY created_at');
    return r.rows.map(rowToEpisode);
  }

  async removeEpisode(uuid: UUID): Promise<void> {
    await this.ensure();
    await this.pool.query('DELETE FROM episodes WHERE uuid=$1', [uuid]);
  }

  /* ---------------- entities ---------------- */

  async upsertEntity(node: EntityNode): Promise<void> {
    await this.ensure();
    await this.pool.query(
      `INSERT INTO entities (uuid, group_id, name, labels, summary, attributes, created_at, name_embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (group_id, lower(name)) DO UPDATE SET
         labels = EXCLUDED.labels, summary = EXCLUDED.summary,
         attributes = EXCLUDED.attributes, name_embedding = EXCLUDED.name_embedding`,
      [
        node.uuid,
        node.groupId,
        node.name,
        node.labels,
        node.summary,
        JSON.stringify(node.attributes ?? {}),
        node.createdAt,
        this.vec(node.nameEmbedding),
      ],
    );
  }

  async getEntity(uuid: UUID): Promise<EntityNode | undefined> {
    await this.ensure();
    const r = await this.pool.query('SELECT * FROM entities WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToEntity(r.rows[0]) : undefined;
  }

  async findEntityByName(groupId: string, name: string): Promise<EntityNode | undefined> {
    await this.ensure();
    const r = await this.pool.query(
      'SELECT * FROM entities WHERE group_id=$1 AND lower(name)=lower($2) LIMIT 1',
      [groupId, name],
    );
    return r.rows[0] ? rowToEntity(r.rows[0]) : undefined;
  }

  async getEntities(groupId?: string): Promise<EntityNode[]> {
    await this.ensure();
    const r = groupId
      ? await this.pool.query('SELECT * FROM entities WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.pool.query('SELECT * FROM entities ORDER BY created_at');
    return r.rows.map(rowToEntity);
  }

  /* ---------------- facts ---------------- */

  async addFact(edge: EntityEdge): Promise<void> {
    await this.ensure();
    await this.pool.query(
      `INSERT INTO facts (uuid, group_id, source_node_uuid, target_node_uuid, name, fact, episodes,
                          valid_at, invalid_at, created_at, expired_at, attributes, fact_embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (uuid) DO UPDATE SET
         name = EXCLUDED.name, fact = EXCLUDED.fact, episodes = EXCLUDED.episodes,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at, attributes = EXCLUDED.attributes,
         fact_embedding = EXCLUDED.fact_embedding`,
      [
        edge.uuid,
        edge.groupId,
        edge.sourceNodeUuid,
        edge.targetNodeUuid,
        edge.name,
        edge.fact,
        edge.episodes,
        edge.validAt ?? null,
        edge.invalidAt ?? null,
        edge.createdAt,
        edge.expiredAt ?? null,
        JSON.stringify(edge.attributes ?? {}),
        this.vec(edge.factEmbedding),
      ],
    );
  }

  async updateFact(edge: EntityEdge): Promise<void> {
    await this.addFact(edge);
  }

  async getFact(uuid: UUID): Promise<EntityEdge | undefined> {
    await this.ensure();
    const r = await this.pool.query('SELECT * FROM facts WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToFact(r.rows[0]) : undefined;
  }

  async getFacts(groupId?: string): Promise<EntityEdge[]> {
    await this.ensure();
    const r = groupId
      ? await this.pool.query('SELECT * FROM facts WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.pool.query('SELECT * FROM facts ORDER BY created_at');
    return r.rows.map(rowToFact);
  }

  async getFactsForEntity(uuid: UUID): Promise<EntityEdge[]> {
    await this.ensure();
    const r = await this.pool.query(
      'SELECT * FROM facts WHERE source_node_uuid=$1 OR target_node_uuid=$1',
      [uuid],
    );
    return r.rows.map(rowToFact);
  }

  async getFactsBetween(a: UUID, b: UUID): Promise<EntityEdge[]> {
    // same contract as the in-memory backend: only currently-true facts
    return (await this.getFactsForEntity(a)).filter(
      (f) => (f.sourceNodeUuid === b || f.targetNodeUuid === b) && isFactActive(f),
    );
  }

  /**
   * Keyword search pushed down to Postgres full-text search instead of
   * scoring every fact in Node.
   */
  async searchFactsByText(
    query: string,
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date } = {},
  ): Promise<{ edge: EntityEdge; score: number }[]> {
    await this.ensure();
    // websearch_to_tsquery("alice works at acme") means alice AND works AND at
    // AND acme, which matches almost nothing (the document holds "WORKS_AT" as
    // one token). Ranking on OR-ed terms is both far more useful and closer to
    // what the in-process BM25 path does.
    const terms = [...new Set(tokenize(query).filter((t) => t.length > 1))];
    const tsQuery = terms.length > 0 ? terms.join(' OR ') : query;
    const params: unknown[] = [tsQuery];
    let sql = `
      SELECT *, ts_rank_cd(to_tsvector('simple', name || ' ' || fact),
                           websearch_to_tsquery('simple', $1)) AS score
        FROM facts
       WHERE to_tsvector('simple', name || ' ' || fact) @@ websearch_to_tsquery('simple', $1)`;
    if (opts.groupId) {
      params.push(opts.groupId);
      sql += ` AND group_id = $${params.length}`;
    }
    sql += this.temporalPredicate(params, opts.activeAt, ' AND ', opts.asOf);
    params.push(opts.limit ?? 20);
    sql += ` ORDER BY score DESC LIMIT $${params.length}`;
    const r = await this.pool.query(sql, params);
    return r.rows.map((row) => ({ edge: rowToFact(row), score: Number(row.score) }));
  }

  /** Fetch a specific set of edges — used to materialise fused rankings. */
  async getFactsByUuids(uuids: UUID[]): Promise<EntityEdge[]> {
    if (uuids.length === 0) return [];
    await this.ensure();
    const r = await this.pool.query('SELECT * FROM facts WHERE uuid = ANY($1::uuid[])', [uuids]);
    return r.rows.map(rowToFact);
  }

  /**
   * Appends the bi-temporal validity predicate, binding parameters as it goes.
   * Mirrors isFactActive(fact, activeAt, asOf) exactly:
   *   known  : created_at <= asOf
   *   started: valid_at IS NULL OR valid_at <= at
   *   ended  : invalid_at <= at, with the end known by asOf
   *            (expired_at, or created_at when the end came with the fact),
   *            or a retraction (expired, no invalid_at) known by asOf
   * activeAt === null means "history too": only the knowledge-time cut applies.
   */
  private temporalPredicate(
    params: unknown[],
    activeAt: Date | null | undefined,
    sep: string,
    asOf?: Date,
  ): string {
    if (activeAt === null) {
      if (!asOf) return ''; // caller wants all of history
      params.push(asOf);
      return `${sep}created_at <= $${params.length}`;
    }
    params.push(activeAt ?? new Date());
    const at = `$${params.length}`;
    params.push(asOf ?? new Date());
    const known = `$${params.length}`;
    return (
      `${sep}created_at <= ${known}` +
      ` AND (valid_at IS NULL OR valid_at <= ${at})` +
      ` AND NOT (` +
      `(invalid_at IS NOT NULL AND invalid_at <= ${at} AND COALESCE(expired_at, created_at) <= ${known})` +
      ` OR (invalid_at IS NULL AND expired_at IS NOT NULL AND expired_at <= ${known}))`
    );
  }

  /**
   * Vector search pushed down to pgvector — the reason to run a database at
   * all. Used by the search layer when available.
   */
  async searchFactsByVector(
    embedding: number[],
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date } = {},
  ): Promise<{ edge: EntityEdge; distance: number }[]> {
    await this.ensure();
    const params: unknown[] = [this.vec(embedding)];
    let sql = `SELECT *, fact_embedding <=> $1::vector AS distance FROM facts WHERE fact_embedding IS NOT NULL`;
    if (opts.groupId) {
      params.push(opts.groupId);
      sql += ` AND group_id = $${params.length}`;
    }
    sql += this.temporalPredicate(params, opts.activeAt, ' AND ', opts.asOf);
    params.push(opts.limit ?? 20);
    sql += ` ORDER BY fact_embedding <=> $1::vector LIMIT $${params.length}`;
    const r = await this.pool.query(sql, params);
    return r.rows.map((row) => ({ edge: rowToFact(row), distance: Number(row.distance) }));
  }
}

/* ---------------- row mapping ---------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowToEpisode(r: Record<string, unknown>): EpisodicNode {
  return {
    type: 'episode',
    uuid: r.uuid as string,
    groupId: r.group_id as string,
    name: r.name as string,
    source: r.source as EpisodicNode['source'],
    sourceDescription: r.source_description as string,
    content: r.content as string,
    validAt: r.valid_at as Date,
    createdAt: r.created_at as Date,
    status: (r.status ?? undefined) as EpisodicNode['status'],
    error: (r.error ?? undefined) as string | undefined,
    contentHash: (r.content_hash ?? undefined) as string | undefined,
  };
}

function rowToEntity(r: Record<string, unknown>): EntityNode {
  return {
    type: 'entity',
    uuid: r.uuid as string,
    groupId: r.group_id as string,
    name: r.name as string,
    labels: (r.labels ?? []) as string[],
    summary: (r.summary ?? '') as string,
    attributes: (r.attributes ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date,
    nameEmbedding: parseVector(r.name_embedding),
  };
}

function rowToFact(r: Record<string, unknown>): EntityEdge {
  return {
    type: 'fact',
    uuid: r.uuid as string,
    groupId: r.group_id as string,
    sourceNodeUuid: r.source_node_uuid as string,
    targetNodeUuid: r.target_node_uuid as string,
    name: r.name as string,
    fact: r.fact as string,
    episodes: (r.episodes ?? []) as string[],
    validAt: (r.valid_at ?? undefined) as Date | undefined,
    invalidAt: (r.invalid_at ?? undefined) as Date | undefined,
    createdAt: r.created_at as Date,
    expiredAt: (r.expired_at ?? undefined) as Date | undefined,
    attributes: (r.attributes ?? {}) as Record<string, unknown>,
    factEmbedding: parseVector(r.fact_embedding),
  };
}

function parseVector(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v as number[];
  // pgvector returns the text form "[1,2,3]" unless a type parser is registered
  return String(v)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter((s) => s.length > 0)
    .map(Number);
}

export type { PoolClient };
