import { Pool, type PoolClient } from 'pg';
import { isFactActive, type EntityEdge, type EntityNode, type EpisodicNode, type UUID } from '../model/types.js';
import { bm25TermScores, tokenize, type Bm25Corpus } from '../search/retrieval.js';
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

/** Most facts one keyword search re-ranks in Node (the best-covered ones win). */
const KEYWORD_CANDIDATES = 1000;
/**
 * Most facts read for BM25's collection size and mean length. Up to this many
 * the ranking equals the in-memory backend's; past it idf is computed as if
 * the scope held this many facts, which keeps each search's cost bounded.
 */
const KEYWORD_STATS_SAMPLE = 10_000;

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
  /** set only on the view transaction() hands out: its queries share one connection */
  private client?: PoolClient;

  /** where data statements go: the transaction's connection, else the pool */
  private get db(): Pick<Pool, 'query'> {
    return this.client ?? this.pool;
  }
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
        await this.migrateSearchText();

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
      })().catch((err: unknown) => {
        // a transient failure (a restart, a lock timeout) must not break this
        // store for the life of the process: the next call tries again
        this.ready = null;
        throw err;
      });
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

  /**
   * Keyword search reads facts.search_text, tokenize()'s output (CJK bigrams,
   * see retrieval.ts), because Postgres' own parser keeps a CJK sentence as
   * one word. A GIN index on to_tsvector('simple', search_text) serves it;
   * 'simple' needs no language dictionary and leaves the tokens alone.
   *
   * A usual start finds everything in place with two cheap reads and takes no
   * lock. Otherwise the table is brought up to date: the column added, rows
   * without search_text filled (facts from before the column, or written by
   * an older build since), the indexes built and the old facts_fts index
   * dropped. That runs on one connection holding an advisory lock, so
   * processes starting together (a server and several stdio MCP clients)
   * cannot race on the same DDL; the ones that waited re-check and find
   * nothing left to do.
   */
  private async migrateSearchText(): Promise<void> {
    if ((await this.searchTextState(this.pool)).ready) return;
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('minizep.migrate'), hashtext($1))`, [this.schema]);
      try {
        const state = await this.searchTextState(client);
        if (state.ready) return;
        // ADD COLUMN and DROP INDEX lock facts exclusively, and every other
        // query on it queues behind a request waiting for that lock: give up
        // after a few seconds (the next call retries) rather than stall the table
        const exclusive = async (sql: string) => {
          await client.query(`SET lock_timeout = '5s'`);
          await client.query(sql);
          await client.query('RESET lock_timeout');
        };
        if (!state.column) await exclusive('ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_text TEXT');
        // backfill first: the index builds faster over filled rows
        await this.backfillSearchText(client);
        await client.query(`
          CREATE INDEX IF NOT EXISTS facts_search_text
            ON facts USING gin (to_tsvector('simple', search_text))
        `);
        // keeps the "any row left to fill?" check at start an index probe;
        // nearly empty, since only an older build writes such rows
        await client.query(`
          CREATE INDEX IF NOT EXISTS facts_search_text_missing
            ON facts (uuid) WHERE search_text IS NULL
        `);
        // The old facts_fts index (on name || ' ' || fact) is no longer queried
        // and only slowed down writes. Dropped by schema-qualified name, so a
        // test schema can never reach an index in public. An older build that
        // is rolled back to recreates it on start, which also tells the next
        // start of this one to fill the rows that build wrote.
        await exclusive(`DROP INDEX IF EXISTS ${this.schema}.facts_fts`);
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('minizep.migrate'), hashtext($1))`, [this.schema]);
      }
    } catch (err) {
      // closing the session also drops the lock if the unlock never ran
      broken = true;
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /** Whether search_text is complete; `column` says if it exists at all. */
  private async searchTextState(db: Pool | PoolClient): Promise<{ ready: boolean; column: boolean }> {
    const q = (name: string) => `${this.schema}.${name}`;
    const r = await db.query(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute
                       WHERE attrelid = to_regclass($1) AND attname = 'search_text'
                         AND NOT attisdropped) AS has_column,
              to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL
                AND to_regclass($4) IS NULL AS indexes_done`,
      [q('facts'), q('facts_search_text'), q('facts_search_text_missing'), q('facts_fts')],
    );
    const column = r.rows[0].has_column === true;
    if (!column || r.rows[0].indexes_done !== true) return { ready: false, column };
    const missing = await db.query('SELECT 1 FROM facts WHERE search_text IS NULL LIMIT 1');
    return { ready: missing.rows.length === 0, column };
  }

  /**
   * Fill search_text where it is NULL, in batches. Keyset pagination on the
   * primary key walks the table once. The IS NULL guard on the UPDATE keeps a
   * value that a concurrent write stored in the meantime.
   */
  private async backfillSearchText(db: PoolClient, batchSize = 500): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const r = await db.query(
        `SELECT uuid, name, fact FROM facts
          WHERE search_text IS NULL AND ($1::uuid IS NULL OR uuid > $1::uuid)
          ORDER BY uuid LIMIT $2`,
        [after, batchSize],
      );
      if (r.rows.length === 0) return;
      await db.query(
        `UPDATE facts AS f SET search_text = v.search_text
           FROM unnest($1::uuid[], $2::text[]) AS v(uuid, search_text)
          WHERE f.uuid = v.uuid AND f.search_text IS NULL`,
        [r.rows.map((row) => row.uuid), r.rows.map((row) => searchTextOf(row.name, row.fact))],
      );
      after = r.rows[r.rows.length - 1].uuid as string;
    }
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

  /**
   * Writes in `fn` commit together: a view of this store bound to one
   * connection inside BEGIN/COMMIT, rolled back when `fn` throws.
   */
  async transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // already inside one
    await this.ensure();
    const client = await this.pool.connect();
    const tx = Object.create(this) as PostgresStore;
    tx.client = client;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addEpisode(ep: EpisodicNode): Promise<void> {
    await this.ensure();
    await this.db.query(
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
    const r = await this.db.query('SELECT * FROM episodes WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToEpisode(r.rows[0]) : undefined;
  }

  async getEpisodes(groupId?: string): Promise<EpisodicNode[]> {
    await this.ensure();
    const r = groupId
      ? await this.db.query('SELECT * FROM episodes WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.db.query('SELECT * FROM episodes ORDER BY created_at');
    return r.rows.map(rowToEpisode);
  }

  async removeEpisode(uuid: UUID): Promise<void> {
    await this.ensure();
    await this.db.query('DELETE FROM episodes WHERE uuid=$1', [uuid]);
  }

  /* ---------------- entities ---------------- */

  async upsertEntity(node: EntityNode): Promise<void> {
    await this.ensure();
    await this.db.query(
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
    const r = await this.db.query('SELECT * FROM entities WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToEntity(r.rows[0]) : undefined;
  }

  async findEntityByName(groupId: string, name: string): Promise<EntityNode | undefined> {
    await this.ensure();
    const r = await this.db.query(
      'SELECT * FROM entities WHERE group_id=$1 AND lower(name)=lower($2) LIMIT 1',
      [groupId, name],
    );
    return r.rows[0] ? rowToEntity(r.rows[0]) : undefined;
  }

  async getEntities(groupId?: string): Promise<EntityNode[]> {
    await this.ensure();
    const r = groupId
      ? await this.db.query('SELECT * FROM entities WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.db.query('SELECT * FROM entities ORDER BY created_at');
    return r.rows.map(rowToEntity);
  }

  /* ---------------- facts ---------------- */

  async addFact(edge: EntityEdge): Promise<void> {
    await this.ensure();
    await this.db.query(
      `INSERT INTO facts (uuid, group_id, source_node_uuid, target_node_uuid, name, fact, episodes,
                          valid_at, invalid_at, created_at, expired_at, attributes, fact_embedding,
                          search_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (uuid) DO UPDATE SET
         name = EXCLUDED.name, fact = EXCLUDED.fact, episodes = EXCLUDED.episodes,
         valid_at = EXCLUDED.valid_at, invalid_at = EXCLUDED.invalid_at,
         expired_at = EXCLUDED.expired_at, attributes = EXCLUDED.attributes,
         fact_embedding = EXCLUDED.fact_embedding,
         search_text = EXCLUDED.search_text`,
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
        searchTextOf(edge.name, edge.fact),
      ],
    );
  }

  async updateFact(edge: EntityEdge): Promise<void> {
    await this.addFact(edge);
  }

  async getFact(uuid: UUID): Promise<EntityEdge | undefined> {
    await this.ensure();
    const r = await this.db.query('SELECT * FROM facts WHERE uuid=$1', [uuid]);
    return r.rows[0] ? rowToFact(r.rows[0]) : undefined;
  }

  async getFacts(groupId?: string): Promise<EntityEdge[]> {
    await this.ensure();
    const r = groupId
      ? await this.db.query('SELECT * FROM facts WHERE group_id=$1 ORDER BY created_at', [groupId])
      : await this.db.query('SELECT * FROM facts ORDER BY created_at');
    return r.rows.map(rowToFact);
  }

  async getFactsForEntity(uuid: UUID): Promise<EntityEdge[]> {
    await this.ensure();
    const r = await this.db.query(
      'SELECT * FROM facts WHERE source_node_uuid=$1 OR target_node_uuid=$1',
      [uuid],
    );
    return r.rows.map(rowToFact);
  }

  async listGroups(): Promise<string[]> {
    await this.ensure();
    const r = await this.db.query(
      'SELECT group_id FROM episodes UNION SELECT group_id FROM entities ORDER BY group_id',
    );
    return r.rows.map((row: { group_id: string }) => row.group_id);
  }

  async getFactsBetween(a: UUID, b: UUID): Promise<EntityEdge[]> {
    // same contract as the in-memory backend: only currently-true facts
    return (await this.getFactsForEntity(a)).filter(
      (f) => (f.sourceNodeUuid === b || f.targetNodeUuid === b) && isFactActive(f),
    );
  }

  /**
   * Keyword search. The GIN index finds the facts sharing a token with the
   * query; Node then ranks them with the in-memory backend's BM25. Postgres'
   * ts_rank has no idf, so common CJK bigrams (公司, 工作) would outrank the
   * rare name a question is about, and the two backends would disagree.
   */
  async searchFactsByText(
    query: string,
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date } = {},
  ): Promise<{ edge: EntityEdge; score: number }[]> {
    await this.ensure();
    // The same tokenize() produced search_text, so CJK bigrams line up. Every
    // token is kept, one letter or one CJK character included: idf decides
    // what matters, and "B站" or "3月" have nothing else to match on. OR, not
    // AND: "alice works at acme" must not require every word. A token is only
    // letters and digits, so quoting it is enough; to_tsquery, because
    // websearch_to_tsquery reads a query word "or" as an operator.
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    // one instant for both queries below: the candidates and the statistics
    // must describe the same set of facts
    const now = new Date();
    const covered = {
      groupId: opts.groupId,
      activeAt: opts.activeAt === undefined ? now : opts.activeAt,
      asOf: opts.asOf ?? (opts.activeAt === null ? undefined : now),
    };
    const params: unknown[] = [[...new Set(qTerms)].map((t) => `'${t}'`).join(' | ')];
    const scope = this.searchScope(params, covered);
    params.push(KEYWORD_CANDIDATES);
    // candidates in creation order, like getFacts(), so ties rank as in memory
    const found = await this.db.query(
      `SELECT uuid, search_text FROM (
         SELECT uuid, search_text, created_at FROM facts
          WHERE to_tsvector('simple', search_text) @@ to_tsquery('simple', $1)${scope}
          ORDER BY ts_rank(to_tsvector('simple', search_text), to_tsquery('simple', $1)) DESC
          LIMIT $${params.length}
       ) AS matched
       ORDER BY created_at, uuid`,
      params,
    );
    if (found.rows.length === 0) return [];

    const docs = found.rows.map((row) => ({ id: row.uuid as string, terms: (row.search_text as string).split(' ') }));
    const scores = bm25TermScores(qTerms, docs, { corpus: await this.keywordCorpus(covered) });
    const top = [...scores.entries()]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit ?? 20);
    const edges = new Map((await this.getFactsByUuids(top.map(([id]) => id))).map((e) => [e.uuid, e]));
    return top.flatMap(([id, score]) => {
      const edge = edges.get(id);
      return edge ? [{ edge, score }] : [];
    });
  }

  /**
   * BM25's collection statistics over the facts a search covers (group and
   * time window), as the in-memory backend computes them over every fact it
   * scores. Read from at most KEYWORD_STATS_SAMPLE rows.
   */
  private async keywordCorpus(opts: { groupId?: string; activeAt?: Date | null; asOf?: Date }): Promise<Bm25Corpus> {
    const params: unknown[] = [];
    const scope = this.searchScope(params, opts);
    params.push(KEYWORD_STATS_SAMPLE);
    // search_text is tokens joined by single spaces: tokens = spaces + 1
    const r = await this.db.query(
      `SELECT count(*)::int AS size,
              coalesce(avg(CASE WHEN search_text = '' THEN 0
                                ELSE length(search_text) - length(replace(search_text, ' ', '')) + 1 END),
                       0)::float8 AS avg_length
         FROM (SELECT search_text FROM facts
                WHERE search_text IS NOT NULL${scope}
                LIMIT $${params.length}) AS covered`,
      params,
    );
    return { size: Number(r.rows[0].size), avgLength: Number(r.rows[0].avg_length) };
  }

  /** Group and time-window predicates of a search, each starting with AND. */
  private searchScope(params: unknown[], opts: { groupId?: string; activeAt?: Date | null; asOf?: Date }): string {
    let sql = '';
    if (opts.groupId) {
      params.push(opts.groupId);
      sql += ` AND group_id = $${params.length}`;
    }
    return sql + this.temporalPredicate(params, opts.activeAt, ' AND ', opts.asOf);
  }

  /** Fetch a specific set of edges — used to materialise fused rankings. */
  async getFactsByUuids(uuids: UUID[]): Promise<EntityEdge[]> {
    if (uuids.length === 0) return [];
    await this.ensure();
    const r = await this.db.query('SELECT * FROM facts WHERE uuid = ANY($1::uuid[])', [uuids]);
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
    const r = await this.db.query(sql, params);
    return r.rows.map((row) => ({ edge: rowToFact(row), distance: Number(row.distance) }));
  }

  /**
   * Facts touching any of `entityUuids` (the graph neighbourhood a search adds
   * to its candidates), under the same group and time filter as the searches,
   * the most recently learned first. The source and target indexes can find
   * them; no vector is compared, and as nothing is ordered by one, pgvector's
   * HNSW index (which filters after its approximate scan) cannot serve this
   * query and cut it short.
   */
  async searchFactsByEntities(
    entityUuids: UUID[],
    opts: { groupId?: string; limit?: number; activeAt?: Date | null; asOf?: Date } = {},
  ): Promise<EntityEdge[]> {
    const ids = entityUuids.filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return [];
    await this.ensure();
    const params: unknown[] = [ids];
    const where = this.touching(params, opts);
    params.push(opts.limit ?? 200);
    const r = await this.db.query(
      `SELECT * FROM facts WHERE ${where} ORDER BY created_at DESC, uuid LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(rowToFact);
  }

  /**
   * Every entity linked to one of `entityUuids` by a fact visible under the
   * filter, without a limit: a search's graph distances must hold for any
   * candidate. No vector is read, and one row comes back per entity.
   */
  async getNeighbourIds(
    entityUuids: UUID[],
    opts: { groupId?: string; activeAt?: Date | null; asOf?: Date } = {},
  ): Promise<UUID[]> {
    const ids = entityUuids.filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return [];
    await this.ensure();
    const params: unknown[] = [ids];
    const where = this.touching(params, opts);
    const r = await this.db.query(
      `SELECT DISTINCT CASE WHEN source_node_uuid = ANY($1::uuid[]) THEN target_node_uuid
                            ELSE source_node_uuid END AS uuid
         FROM facts WHERE ${where}`,
      params,
    );
    return r.rows.map((row) => row.uuid as string);
  }

  /** WHERE clause for the facts touching the entities bound as $1, under a search's scope. */
  private touching(params: unknown[], opts: { groupId?: string; activeAt?: Date | null; asOf?: Date }): string {
    return `(source_node_uuid = ANY($1::uuid[]) OR target_node_uuid = ANY($1::uuid[]))${this.searchScope(params, opts)}`;
  }
}

/** The facts.search_text value: keyword tokens of the relation name and fact text. */
function searchTextOf(name: string, fact: string): string {
  return tokenize(`${name} ${fact}`).join(' ');
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
