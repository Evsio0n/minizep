import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from '../src/store/postgres-store.js';
import { bm25Scores, tokenize } from '../src/search/retrieval.js';
import type { EntityEdge } from '../src/model/types.js';

/*
 * PostgresStore's keyword search and search_text migration, checked without a
 * database: the store's pool is swapped for a stand-in that records every
 * statement and answers the few this code path sends. What the SQL itself
 * does is covered by search-parity.test.ts against a real database.
 */

interface Row {
  uuid: string;
  group_id: string;
  name: string;
  fact: string;
  search_text: string | null;
  created_at: Date;
}

interface Logged {
  sql: string;
  params: unknown[];
  /** 'pool' or the dedicated connection the statement ran on */
  on: string;
}

/** Session-level advisory lock, shared by every store on one FakeDatabase. */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;
  async acquire(): Promise<void> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await before;
    this.release = release;
  }
  unlock(): void {
    this.release?.();
    this.release = null;
  }
}

/** The state several processes share: one facts table and its catalog. */
class FakeDatabase {
  rows: Row[] = [];
  hasColumn = true;
  /** episodes.attempts, the retry counter */
  hasAttempts = true;
  indexes = new Set(['facts_search_text', 'facts_search_text_missing']);
  /** indexes being built and not yet committed, as Postgres' race needs */
  private building = new Set<string>();
  readonly lock = new Lock();
  readonly log: Logged[] = [];

  /** A database from before search_text: no column, the old facts_fts index. */
  static legacy(rows: number): FakeDatabase {
    const db = new FakeDatabase();
    db.hasColumn = false;
    db.hasAttempts = false;
    db.indexes = new Set(['facts_fts']);
    for (let i = 0; i < rows; i++) {
      db.rows.push({
        uuid: randomUUID(),
        group_id: 'legacy',
        name: 'NOTE',
        fact: `第${i}条会议纪要`,
        search_text: null,
        created_at: new Date(Date.UTC(2020, 0, 1, 0, 0, i)),
      });
    }
    return db;
  }

  statements(re: RegExp): Logged[] {
    return this.log.filter((l) => re.test(l.sql));
  }

  async query(on: string, rawSql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    this.log.push({ sql, params, on });
    const param = (re: RegExp) => {
      const m = sql.match(re);
      return m ? params[Number(m[1]) - 1] : undefined;
    };

    if (sql.includes('pg_advisory_lock(')) {
      await this.lock.acquire();
      return { rows: [{}] };
    }
    if (sql.includes('pg_advisory_unlock(')) {
      this.lock.unlock();
      return { rows: [{}] };
    }
    if (sql.includes('AS has_column')) {
      const has = (name: string) => this.indexes.has(name);
      return {
        rows: [
          {
            has_column: this.hasColumn,
            indexes_done: has('facts_search_text') && has('facts_search_text_missing') && !has('facts_fts'),
          },
        ],
      };
    }
    if (sql.startsWith('SELECT 1 FROM facts WHERE search_text IS NULL')) {
      if (!this.hasColumn) throw new Error('column "search_text" does not exist');
      return { rows: this.rows.some((r) => r.search_text === null) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.startsWith('ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_text')) {
      this.hasColumn = true;
      return { rows: [] };
    }
    if (sql.includes("attname = 'attempts'")) return { rows: this.hasAttempts ? [{ '?column?': 1 }] : [] };
    if (sql.startsWith('ALTER TABLE episodes ADD COLUMN IF NOT EXISTS attempts')) {
      this.hasAttempts = true;
      return { rows: [] };
    }
    if (sql.startsWith('SELECT uuid, name, fact FROM facts WHERE search_text IS NULL')) {
      const [after, limit] = params as [string | null, number];
      const page = this.rows
        .filter((r) => r.search_text === null && (after === null || r.uuid > after))
        .sort((a, b) => (a.uuid < b.uuid ? -1 : 1))
        .slice(0, limit);
      return { rows: page.map(({ uuid, name, fact }) => ({ uuid, name, fact })) };
    }
    if (sql.startsWith('UPDATE facts AS f SET search_text')) {
      const [uuids, texts] = params as [string[], string[]];
      uuids.forEach((uuid, i) => {
        const row = this.rows.find((r) => r.uuid === uuid);
        if (row && row.search_text === null) row.search_text = texts[i];
      });
      return { rows: [] };
    }
    const index = sql.match(/^CREATE INDEX IF NOT EXISTS (facts_search_text\w*)/);
    if (index) {
      const name = index[1];
      // Two uncommitted builds of one index both pass IF NOT EXISTS; the
      // second then fails on the catalog's unique index.
      if (this.building.has(name)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "pg_class_relname_nsp_index"'), {
          code: '23505',
        });
      }
      if (!this.indexes.has(name)) {
        this.building.add(name);
        await new Promise((r) => setTimeout(r, 5));
        this.building.delete(name);
        this.indexes.add(name);
      }
      return { rows: [] };
    }
    const dropped = sql.match(/^DROP INDEX IF EXISTS \w+\.(\w+)/);
    if (dropped) {
      this.indexes.delete(dropped[1]);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT atttypmod')) return { rows: [{ atttypmod: 8 }] };
    if (sql.startsWith('SELECT count(*)::int AS n FROM facts')) return { rows: [{ n: this.rows.length }] };
    if (sql.startsWith('INSERT INTO facts')) {
      const p = params as [string, string, string, string, string, string, ...unknown[]];
      const row: Row = {
        uuid: p[0],
        group_id: p[1],
        name: p[4],
        fact: p[5],
        created_at: p[9] as Date,
        search_text: p[13] as string,
      };
      this.rows = [...this.rows.filter((r) => r.uuid !== row.uuid), row];
      return { rows: [] };
    }
    if (sql.includes('AS matched')) {
      // the GIN pre-filter: facts sharing a token with the OR-ed tsquery
      const terms = new Set(String(params[0]).split(' | ').map((t) => t.slice(1, -1)));
      const group = param(/group_id = \$(\d+)/);
      const matched = this.rows
        .filter((r) => r.search_text !== null && (group === undefined || r.group_id === group))
        .filter((r) => r.search_text!.split(' ').some((t) => terms.has(t)))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.uuid < b.uuid ? -1 : 1));
      return { rows: matched.map(({ uuid, search_text }) => ({ uuid, search_text })) };
    }
    if (sql.includes('AS covered')) {
      const group = param(/group_id = \$(\d+)/);
      const covered = this.rows.filter((r) => r.search_text !== null && (group === undefined || r.group_id === group));
      const lengths = covered.map((r) => (r.search_text === '' ? 0 : r.search_text!.split(' ').length));
      const avg = lengths.length ? lengths.reduce((s, n) => s + n, 0) / lengths.length : 0;
      return { rows: [{ size: covered.length, avg_length: avg }] };
    }
    if (sql.startsWith('SELECT * FROM facts WHERE uuid = ANY')) {
      const wanted = new Set(params[0] as string[]);
      return {
        rows: this.rows
          .filter((r) => wanted.has(r.uuid))
          .map((r) => ({
            ...r,
            source_node_uuid: 'src',
            target_node_uuid: 'dst',
            episodes: [],
            attributes: {},
            valid_at: null,
            invalid_at: null,
            expired_at: null,
            fact_embedding: null,
          })),
      };
    }
    // CREATE SCHEMA/TABLE, the other indexes, SET/RESET: nothing to model
    return { rows: [] };
  }
}

let connections = 0;

/** A PostgresStore whose pool talks to `db`. */
function storeOn(db: FakeDatabase, failFirst?: RegExp): PostgresStore {
  const store = new PostgresStore({ embeddingDims: 8, schema: 'minizep_fake' });
  let failures = failFirst ? 1 : 0;
  const query = async (on: string, sql: string, params?: unknown[]) => {
    if (failures > 0 && failFirst!.test(sql)) {
      failures--;
      throw new Error('connection terminated unexpectedly');
    }
    return db.query(on, sql, params);
  };
  const pool = {
    query: (sql: string, params?: unknown[]) => query('pool', sql, params),
    async connect() {
      const on = `client#${++connections}`;
      return {
        query: (sql: string, params?: unknown[]) => query(on, sql, params),
        release(broken?: boolean) {
          db.log.push({ sql: `(release${broken ? ', destroyed' : ''})`, params: [], on });
        },
      };
    },
    async end() {},
  };
  (store as unknown as { pool: typeof pool }).pool = pool;
  return store;
}

function edge(groupId: string, name: string, fact: string, createdAt: Date): EntityEdge {
  return {
    type: 'fact',
    uuid: randomUUID(),
    groupId,
    sourceNodeUuid: randomUUID(),
    targetNodeUuid: randomUUID(),
    name,
    fact,
    episodes: [],
    createdAt,
    attributes: {},
  };
}

async function seeded(texts: Array<[name: string, fact: string]>, groupId = 'g') {
  const db = new FakeDatabase();
  const store = storeOn(db);
  const edges = texts.map(([name, fact], i) => edge(groupId, name, fact, new Date(Date.UTC(2024, 0, 1, 0, 0, i))));
  for (const e of edges) await store.addFact(e);
  return { db, store, edges };
}

/* ---------------- query terms ---------------- */

test('pg keyword search: every token is OR-ed into the tsquery, quoted', async () => {
  const { db, store } = await seeded([['NOTE', '占位']]);
  const tsqueryFor = async (query: string) => {
    const before = db.log.length;
    await store.searchFactsByText(query, { groupId: 'g' });
    return db.log.slice(before).find((l) => l.sql.includes('AS matched'))?.params[0];
  };
  assert.equal(await tsqueryFor('产品经理'), "'产品' | '品经' | '经理'");
  assert.equal(await tsqueryFor('猫'), "'猫'");
  assert.equal(await tsqueryFor('a'), "'a'");
  // a letter or digit split off a CJK word is kept: it is all there is to match
  assert.equal(await tsqueryFor('B站'), "'b' | '站'");
  assert.equal(await tsqueryFor('5楼'), "'5' | '楼'");
  // "or" is a word here, not websearch syntax
  assert.equal(await tsqueryFor('tea or coffee'), "'tea' | 'or' | 'coffee'");
  assert.equal(await tsqueryFor('巴巴巴'), "'巴巴'", 'repeated tokens appear once');

  const matched = db.statements(/AS matched/)[0].sql;
  assert.match(matched, /to_tsvector\('simple', search_text\) @@ to_tsquery\('simple', \$1\)/);
});

test('pg keyword search: a query without tokens sends no search at all', async () => {
  const { db, store } = await seeded([['NOTE', '占位']]);
  const before = db.log.length;
  assert.deepEqual(await store.searchFactsByText('', { groupId: 'g' }), []);
  assert.deepEqual(await store.searchFactsByText('，。！', { groupId: 'g' }), []);
  assert.equal(db.log.length, before);
});

test('pg addFact: search_text is tokenize(name + fact), on insert and on upsert', async () => {
  const { db, edges } = await seeded([['WORKS_AT', '张伟在Google做PM']]);
  const insert = db.statements(/^INSERT INTO facts/)[0];
  assert.equal(insert.params[13], tokenize('WORKS_AT 张伟在Google做PM').join(' '));
  assert.equal(insert.params[13], 'works at 张伟 伟在 google 做 pm');
  assert.match(insert.sql, /search_text = EXCLUDED\.search_text/);
  assert.equal(db.rows[0].uuid, edges[0].uuid);
});

/* ---------------- ranking ---------------- */

/** The in-memory backend's ranking of the same texts. */
function memoryRanking(query: string, texts: Array<{ id: string; text: string }>): string[] {
  return [...bm25Scores(query, texts).entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

const NAMES: Array<[string, string]> = [
  ['WORKS_AT', '张伟在阿里巴巴做高级产品经理'],
  ['WORKS_AT', '李娜在腾讯公司工作，公司总部在深圳'],
  ['WORKS_AT', '王芳在华为公司工作'],
];

test('pg keyword search: a rare name beats common bigrams, as in memory (regression: ts_rank_cd)', async () => {
  // ts_rank_cd counted occurrences with no idf: 公司 x2, 司工, 工作 put
  // Li Na's fact first and Zhang Wei's own fact last
  const { store, edges } = await seeded(NAMES);
  const hits = await store.searchFactsByText('张伟在哪家公司工作', { groupId: 'g', activeAt: null });
  assert.equal(hits[0]?.edge.fact, NAMES[0][1]);
  assert.deepEqual(
    hits.map((h) => h.edge.uuid),
    memoryRanking('张伟在哪家公司工作', edges.map((e) => ({ id: e.uuid, text: `${e.name} ${e.fact}` }))),
  );
});

test('pg keyword search: idf counts the facts that match nothing, as in memory', async () => {
  // with unrelated facts in the group, BM25 itself ranks differently; the
  // statistics must cover the whole group, not just the matching facts
  const fillers: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => ['NOTE', `第${i}次周会记录了项目进度`]);
  const texts: Array<[string, string]> = [
    ...NAMES,
    ...fillers,
    ['WATCHES', '赵磊每天在B站看视频'],
    ['WORKS_AT', '孙丽2024年3月入职字节跳动'],
    ['LOCATED_AT', '办公室在5楼'],
    ['WORKS_AT', 'alice works at a startup'],
  ];
  const { store, edges } = await seeded(texts);
  const docs = edges.map((e) => ({ id: e.uuid, text: `${e.name} ${e.fact}` }));
  for (const query of ['张伟在哪家公司工作', 'B站', '3月', '5楼', '周会', 'who works at a startup']) {
    const hits = await store.searchFactsByText(query, { groupId: 'g', activeAt: null, limit: 50 });
    assert.ok(hits.length > 0, `nothing found for "${query}"`);
    assert.deepEqual(hits.map((h) => h.edge.uuid), memoryRanking(query, docs), `ranking for "${query}"`);
    const memoryScores = bm25Scores(query, docs);
    for (const h of hits) assert.ok(Math.abs(h.score - memoryScores.get(h.edge.uuid)!) < 1e-9);
  }
});

test('pg keyword search: statistics and candidates cover the same group and instant', async () => {
  const { db, store } = await seeded([['NOTE', '会议纪要']]);
  await store.searchFactsByText('会议', { groupId: 'g' });
  const matched = db.statements(/AS matched/).at(-1)!;
  const covered = db.statements(/AS covered/).at(-1)!;
  // the group, then the valid-time and knowledge-time instants (one instant), then the limit
  assert.equal(matched.params[1], 'g');
  assert.equal(covered.params[0], 'g');
  const instants = [...matched.params.slice(2, 4), ...covered.params.slice(1, 3)] as Date[];
  assert.ok(instants.every((d) => d instanceof Date && d.getTime() === instants[0].getTime()));
});

/* ---------------- migration ---------------- */

test('pg migration: an old table is upgraded under the advisory lock and backfilled in batches', async () => {
  const db = FakeDatabase.legacy(1200);
  const store = storeOn(db);
  await store.health();

  // every legacy row is filled with the same text addFact would write
  for (const row of db.rows) assert.equal(row.search_text, tokenize(`${row.name} ${row.fact}`).join(' '));
  // 500, 500, 200, then an empty page ends it; each page starts after the last
  const pages = db.statements(/^SELECT uuid, name, fact FROM facts/);
  const updates = db.statements(/^UPDATE facts AS f/);
  assert.deepEqual(updates.map((u) => (u.params[0] as string[]).length), [500, 500, 200]);
  const sorted = db.rows.map((r) => r.uuid).sort();
  assert.deepEqual(pages.map((p) => p.params[0]), [null, sorted[499], sorted[999], sorted[1199]]);

  assert.ok(db.hasColumn);
  assert.deepEqual([...db.indexes].sort(), ['facts_search_text', 'facts_search_text_missing']);
  // the episodes' retry counter is added once, outside the facts migration
  assert.equal(db.statements(/^ALTER TABLE episodes ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0$/).length, 1);
  assert.ok(db.hasAttempts);

  // the schema work runs on one connection, between lock and unlock, in order
  const lock = db.statements(/pg_advisory_lock\(/)[0];
  const steps = db.log.slice(db.log.indexOf(lock)).map((l) => l.sql);
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
  assert.ok(at(/^SET lock_timeout/) < at(/^ALTER TABLE facts ADD COLUMN/));
  assert.ok(at(/^ALTER TABLE facts ADD COLUMN/) < at(/^UPDATE facts AS f/));
  assert.ok(at(/^RESET lock_timeout/) < at(/^UPDATE facts AS f/), 'the timeout only covers the ALTER');
  const lastUpdate = Math.max(...steps.flatMap((s, i) => (/^UPDATE facts AS f/.test(s) ? [i] : [])));
  assert.ok(lastUpdate < at(/^CREATE INDEX IF NOT EXISTS facts_search_text /), 'the index is built over filled rows');
  assert.ok(at(/facts_search_text_missing/) < at(/^DROP INDEX IF EXISTS minizep_fake\.facts_fts/));
  assert.match(steps[at(/^DROP INDEX/) - 1], /^SET lock_timeout/, 'DROP INDEX locks facts exclusively too');
  assert.ok(at(/^DROP INDEX/) < at(/pg_advisory_unlock\(/));
  const unlock = db.statements(/pg_advisory_unlock\(/)[0];
  const onClient = db.log.slice(db.log.indexOf(lock), db.log.indexOf(unlock) + 1);
  assert.ok(onClient.every((l) => l.on === lock.on), 'lock, migration and unlock share one connection');
  assert.ok(db.log.some((l) => l.sql === '(release)' && l.on === lock.on), 'the connection goes back to the pool');
});

test('pg migration: a start against an up-to-date table takes no lock and alters nothing', async () => {
  const db = new FakeDatabase();
  db.rows.push({ uuid: randomUUID(), group_id: 'g', name: 'NOTE', fact: '会议', search_text: 'note 会议', created_at: new Date() });
  await storeOn(db).health();
  assert.equal(db.statements(/pg_advisory_lock|ALTER TABLE|^SELECT uuid, name, fact|^CREATE INDEX IF NOT EXISTS facts_search_text/).length, 0);
  assert.ok(db.log.every((l) => l.on === 'pool'));
});

test('pg migration: rows an older build wrote without search_text are filled on the next start', async () => {
  const db = new FakeDatabase();
  db.rows.push(
    { uuid: randomUUID(), group_id: 'g', name: 'NOTE', fact: '新的纪要', search_text: 'note 新的 的纪 纪要', created_at: new Date() },
    { uuid: randomUUID(), group_id: 'g', name: 'NOTE', fact: '旧版写入', search_text: null, created_at: new Date() },
  );
  await storeOn(db).health();
  assert.equal(db.rows[1].search_text, 'note 旧版 版写 写入');
  assert.equal(db.statements(/^ALTER TABLE/).length, 0, 'the column exists: no exclusive lock');

  // a rolled-back older build recreated facts_fts: dropped again on start
  db.indexes.add('facts_fts');
  await storeOn(db).health();
  assert.ok(!db.indexes.has('facts_fts'));
});

test('pg migration: processes starting together migrate one at a time (regression: CREATE INDEX race)', async () => {
  const db = FakeDatabase.legacy(1200);
  const stores = [storeOn(db), storeOn(db), storeOn(db)];
  await Promise.all(stores.map((s) => s.health()));
  assert.equal(db.statements(/^ALTER TABLE facts ADD COLUMN/).length, 1);
  assert.equal(db.statements(/^CREATE INDEX IF NOT EXISTS facts_search_text /).length, 1);
  assert.ok(db.rows.every((r) => r.search_text !== null));
});

test('pg ensure: a failed schema step is retried by the next call instead of sticking', async () => {
  const db = FakeDatabase.legacy(3);
  const store = storeOn(db, /^ALTER TABLE facts ADD COLUMN/);
  await assert.rejects(store.health(), /connection terminated/);
  // the lock was released and the failed connection closed, not reused
  assert.equal(db.statements(/pg_advisory_unlock\(/).length, 1);
  assert.ok(db.log.some((l) => l.sql === '(release, destroyed)'));

  const health = await store.health();
  assert.equal(health.ok, true);
  assert.ok(db.rows.every((r) => r.search_text !== null));
});
