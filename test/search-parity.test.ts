import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Minizep } from '../src/index.js';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { PostgresStore } from '../src/store/postgres-store.js';
import { HashEmbedder } from '../src/provider/interfaces.js';
import { ScriptedLLM, SlowEmbedder, entity, fact, invalidation } from './helpers.js';
import type { ExtractionResult } from '../src/provider/interfaces.js';

const DIMS = 64;
const TEST_SCHEMA = 'minizep_test_search';

function resolveUrl(): string | undefined {
  if (process.env.MINIZEP_TEST_DATABASE_URL) return process.env.MINIZEP_TEST_DATABASE_URL;
  if (process.env.MINIZEP_DATABASE_URL) return process.env.MINIZEP_DATABASE_URL;
  try {
    return readFileSync('/var/tmp/minizep-pg/url', 'utf8').trim();
  } catch {
    return undefined;
  }
}
const URL = resolveUrl();

/** A corpus with one clearly-relevant fact per natural-language query. */
const CORPUS: Array<{ content: string; result: ExtractionResult }> = [
  {
    content: 'alice works at acme',
    result: { entities: [entity('Alice'), entity('Acme', ['Organization'])], facts: [fact('Alice', 'Acme', 'WORKS_AT')], invalidations: [] },
  },
  {
    content: 'bob likes pizza',
    result: { entities: [entity('Bob'), entity('Pizza', ['Concept'])], facts: [fact('Bob', 'Pizza', 'LIKES')], invalidations: [] },
  },
  {
    content: 'carol works at globex',
    result: { entities: [entity('Carol'), entity('Globex', ['Organization'])], facts: [fact('Carol', 'Globex', 'WORKS_AT')], invalidations: [] },
  },
  {
    content: 'dave manages the platform team',
    result: { entities: [entity('Dave'), entity('Platform Team', ['Organization'])], facts: [fact('Dave', 'Platform Team', 'MANAGES')], invalidations: [] },
  },
];

/** One Chinese sentence whose single fact keeps the sentence as its text. */
function zh(content: string, source: string, target: string, relation: string, targetLabels: string[]) {
  return {
    content,
    result: {
      entities: [entity(source), entity(target, targetLabels)],
      facts: [{ ...fact(source, target, relation), fact: content }],
      invalidations: [],
    } satisfies ExtractionResult,
  };
}

/** Chinese corpus: the words queried sit inside sentences, with no spaces around them. */
const ZH_CORPUS = [
  zh('张伟在阿里巴巴做高级产品经理', '张伟', '阿里巴巴', 'WORKS_AT', ['Organization']),
  zh('李娜在腾讯做产品经理，负责微信支付', '李娜', '腾讯', 'WORKS_AT', ['Organization']),
  zh('王芳喜欢吃四川火锅', '王芳', '四川火锅', 'LIKES', ['Concept']),
  zh('陈明在Google做机器学习工程师', '陈明', 'Google', 'WORKS_AT', ['Organization']),
  zh('赵磊每天在B站看视频', '赵磊', 'B站', 'WATCHES', ['Organization']),
  zh('孙丽2024年3月入职字节跳动', '孙丽', '字节跳动', 'WORKS_AT', ['Organization']),
];

/** Chinese (and mixed) queries with the fact each must return first. */
const ZH_QUERIES: Array<[query: string, expected: string]> = [
  ['阿里巴巴的产品经理', '张伟在阿里巴巴做高级产品经理'],
  ['高级产品经理', '张伟在阿里巴巴做高级产品经理'],
  ['微信支付', '李娜在腾讯做产品经理，负责微信支付'],
  ['火锅', '王芳喜欢吃四川火锅'],
  ['Google 机器学习', '陈明在Google做机器学习工程师'],
  // a letter or digit next to one CJK character: the only token that can match
  ['B站', '赵磊每天在B站看视频'],
  ['3月', '孙丽2024年3月入职字节跳动'],
];

/**
 * A question whose common bigrams (公司, 工作) fill the other facts while the
 * rare one (the name 张伟) is in the fact it asks about. Ranking without idf
 * put that fact last.
 */
const NAME_CORPUS = [
  zh('张伟在阿里巴巴做高级产品经理', '张伟', '阿里巴巴', 'WORKS_AT', ['Organization']),
  zh('李娜在腾讯公司工作，公司总部在深圳', '李娜', '腾讯', 'WORKS_AT', ['Organization']),
  zh('王芳在华为公司工作', '王芳', '华为', 'WORKS_AT', ['Organization']),
];
const NAME_QUERY = '张伟在哪家公司工作';

function makeZep(store: MemoryGraphStore | PostgresStore, embedder = new HashEmbedder(DIMS)) {
  const byContent = new Map([...CORPUS, ...ZH_CORPUS, ...NAME_CORPUS].map((c) => [c.content, c.result]));
  const llm = new ScriptedLLM(
    (content) => byContent.get(content) ?? { entities: [], facts: [], invalidations: [] },
    false,
    0,
  );
  return new Minizep({ store, llm, embedder });
}

async function seed(zep: Minizep, group: string, corpus: Array<{ content: string }> = CORPUS) {
  for (const c of corpus) await zep.ingest.addEpisode({ groupId: group, content: c.content });
}

test('search parity: memory backend (in-process scoring)', async () => {
  const zep = makeZep(new MemoryGraphStore());
  await seed(zep, 'g');

  const hits = await zep.searchFacts('Bob likes Pizza', { groupId: 'g' });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].sourceName, 'Bob');
  assert.equal(hits[0].fact.name, 'LIKES');
});

test('search parity: memory backend finds words inside Chinese sentences', async () => {
  const zep = makeZep(new MemoryGraphStore());
  await seed(zep, 'zh', ZH_CORPUS);

  for (const [query, expected] of ZH_QUERIES) {
    const hits = await zep.searchFacts(query, { groupId: 'zh' });
    assert.equal(hits[0]?.fact.fact, expected, `wrong top hit for "${query}"`);
  }

  await seed(zep, 'zh-names', NAME_CORPUS);
  const hits = await zep.searchFacts(NAME_QUERY, { groupId: 'zh-names' });
  assert.equal(hits[0]?.fact.fact, NAME_CORPUS[0].content);
});

if (!URL) {
  test('search parity: postgres backend (skipped: no database)', { skip: true }, () => {});
} else {
  test('search parity: postgres backend returns the same top hit as memory', async () => {
    // 1. memory baseline
    const mem = makeZep(new MemoryGraphStore());
    await seed(mem, 'g');

    // 2. postgres, same corpus and embedder
    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      const dbz = makeZep(pg);
      await seed(dbz, 'g');

      for (const query of ['Bob likes Pizza', 'who works at Acme', 'Dave manages']) {
        const fromMemory = await mem.searchFacts(query, { groupId: 'g' });
        const fromPostgres = await dbz.searchFacts(query, { groupId: 'g' });
        assert.ok(fromPostgres.length > 0, `postgres returned nothing for "${query}"`);
        // the two stores ingested the same corpus independently, so uuids
        // differ by construction — compare what the user actually sees
        assert.equal(
          fromPostgres[0].fact.fact,
          fromMemory[0].fact.fact,
          `top hit differs for "${query}": memory=${fromMemory[0].fact.fact} postgres=${fromPostgres[0].fact.fact}`,
        );
      }
    } finally {
      await pg.close();
    }
  });

  test('search parity: postgres finds the same Chinese facts as memory', async () => {
    const mem = makeZep(new MemoryGraphStore());
    await seed(mem, 'zh', ZH_CORPUS);

    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      const dbz = makeZep(pg);
      await seed(dbz, 'zh', ZH_CORPUS);

      for (const [query, expected] of ZH_QUERIES) {
        // the keyword path on its own: fused results could hide a dead text
        // index behind the vector ranking
        const byText = await pg.searchFactsByText(query, { groupId: 'zh' });
        assert.equal(byText[0]?.edge.fact, expected, `full-text top hit for "${query}"`);

        const fromMemory = await mem.searchFacts(query, { groupId: 'zh' });
        const fromPostgres = await dbz.searchFacts(query, { groupId: 'zh' });
        assert.equal(fromMemory[0]?.fact.fact, expected, `memory top hit for "${query}"`);
        assert.equal(fromPostgres[0]?.fact.fact, expected, `postgres top hit for "${query}"`);
      }
    } finally {
      await pg.close();
    }
  });

  test('search parity: postgres weighs a rare name over common bigrams, as memory does', async () => {
    const mem = makeZep(new MemoryGraphStore());
    await seed(mem, 'zh-names', NAME_CORPUS);

    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      const dbz = makeZep(pg);
      await seed(dbz, 'zh-names', NAME_CORPUS);
      const expected = NAME_CORPUS[0].content;

      // ts_rank_cd (occurrences, no idf) put this fact last on the keyword path
      const byText = await pg.searchFactsByText(NAME_QUERY, { groupId: 'zh-names' });
      assert.equal(byText[0]?.edge.fact, expected);
      assert.equal((await mem.searchFacts(NAME_QUERY, { groupId: 'zh-names' }))[0]?.fact.fact, expected);
      assert.equal((await dbz.searchFacts(NAME_QUERY, { groupId: 'zh-names' }))[0]?.fact.fact, expected);
    } finally {
      await pg.close();
    }
  });

  test('search_text: updating a fact re-indexes its new text', async () => {
    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      await seed(makeZep(pg), 'zh', ZH_CORPUS);
      const [before] = await pg.searchFactsByText('火锅', { groupId: 'zh' });
      assert.ok(before, 'found before the update');

      await pg.updateFact({ ...before.edge, fact: '王芳喜欢吃广东早茶' });
      assert.equal((await pg.searchFactsByText('火锅', { groupId: 'zh' })).length, 0, 'old text is out of the index');
      assert.equal((await pg.searchFactsByText('早茶', { groupId: 'zh' }))[0]?.edge.uuid, before.edge.uuid);
    } finally {
      await pg.close();
    }
  });

  /**
   * Rewind TEST_SCHEMA to the schema before search_text: the Chinese corpus,
   * no search_text column (its indexes go with it), the old expression index
   * back, and more legacy rows than one backfill batch holds.
   */
  async function rewindToOldSchema(raw: Pool): Promise<void> {
    const old = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    try {
      await old.reset();
      await seed(makeZep(old), 'zh', ZH_CORPUS);
    } finally {
      await old.close();
    }
    await raw.query(`
      ALTER TABLE facts DROP COLUMN search_text;
      CREATE INDEX IF NOT EXISTS facts_fts ON facts USING gin (to_tsvector('simple', name || ' ' || fact));
    `);
    const entityUuid = (await raw.query('SELECT uuid FROM entities LIMIT 1')).rows[0].uuid;
    await raw.query(
      `INSERT INTO facts (uuid, group_id, source_node_uuid, target_node_uuid, name, fact, created_at)
       SELECT md5('legacy' || i)::uuid, 'legacy', $1, $1, 'NOTE', '第' || i || '条会议纪要',
              timestamptz '2020-01-01 00:00:00+00'
         FROM generate_series(1, 1200) AS i`,
      [entityUuid],
    );
  }

  /** Every row filled, the new indexes present and the old one gone. */
  async function assertUpgraded(raw: Pool): Promise<void> {
    const missing = await raw.query('SELECT count(*)::int AS n FROM facts WHERE search_text IS NULL');
    assert.equal(missing.rows[0].n, 0, 'every row is backfilled, across several batches');

    const indexes = await raw.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'facts'`,
      [TEST_SCHEMA],
    );
    const names = indexes.rows.map((r) => r.indexname as string);
    assert.ok(names.includes('facts_search_text'), 'the search_text index is created');
    assert.ok(names.includes('facts_search_text_missing'), 'the index behind the start-up check is created');
    assert.ok(!names.includes('facts_fts'), 'the unused expression index is dropped');
  }

  test('search_text: a table from before the column existed is upgraded and backfilled', async () => {
    const raw = new Pool({ connectionString: URL, options: `-c search_path=${TEST_SCHEMA},public` });
    try {
      await rewindToOldSchema(raw);
      // a new process starting against the old table
      const upgraded = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
      try {
        const hits = await upgraded.searchFactsByText('阿里巴巴', { groupId: 'zh' });
        assert.equal(hits[0]?.edge.fact, '张伟在阿里巴巴做高级产品经理');
        assert.equal((await upgraded.searchFactsByText('会议纪要', { groupId: 'legacy', limit: 5 })).length, 5);
        await assertUpgraded(raw);
      } finally {
        await upgraded.close();
      }

      // an older build writes a fact without search_text; the next start fills it
      const entityUuid = (await raw.query('SELECT uuid FROM entities LIMIT 1')).rows[0].uuid;
      await raw.query(
        `INSERT INTO facts (uuid, group_id, source_node_uuid, target_node_uuid, name, fact, created_at)
         VALUES (md5('old-build')::uuid, 'legacy', $1, $1, 'NOTE', '旧版写入的纪要', now())`,
        [entityUuid],
      );
      const restarted = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
      try {
        const hits = await restarted.searchFactsByText('旧版写入', { groupId: 'legacy' });
        assert.equal(hits[0]?.edge.fact, '旧版写入的纪要');
      } finally {
        await restarted.close();
      }
    } finally {
      await raw.end();
    }
  });

  test('search_text: processes starting together on an old table all come up (regression: CREATE INDEX race)', async () => {
    const raw = new Pool({ connectionString: URL, options: `-c search_path=${TEST_SCHEMA},public` });
    const stores = Array.from(
      { length: 3 },
      () => new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA }),
    );
    try {
      await rewindToOldSchema(raw);
      // before the advisory lock, the second CREATE INDEX IF NOT EXISTS failed
      // on pg_class_relname_nsp_index and that process's store stayed broken
      await Promise.all(stores.map((s) => s.searchFactsByText('阿里巴巴', { groupId: 'zh' })));
      await assertUpgraded(raw);
    } finally {
      await Promise.all(stores.map((s) => s.close()));
      await raw.end();
    }
  });

  test('search push-down: a large corpus is not loaded into Node', async () => {
    // proves the native path is actually taken: the in-process fallback would
    // need every fact, and this store refuses to hand them over
    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      const dbz = makeZep(pg);
      await seed(dbz, 'g');

      let bulkReads = 0;
      const original = pg.getFacts.bind(pg);
      pg.getFacts = async (...args: Parameters<typeof original>) => {
        bulkReads++;
        return original(...args);
      };

      const hits = await dbz.searchFacts('Alice Acme', { groupId: 'g' });
      assert.ok(hits.length > 0, 'search still returns results');
      assert.equal(bulkReads, 0, 'searchFacts must not read the whole fact table');
    } finally {
      await pg.close();
    }
  });

  test('search push-down: time filtering happens in the database', async () => {
    const pg = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await pg.reset();
    try {
      const dbz = makeZep(pg);
      await seed(dbz, 'h');
      // close the Acme relation
      const bye = new ScriptedLLM(() => ({
        entities: [entity('Alice'), entity('Acme', ['Organization'])],
        facts: [],
        invalidations: [invalidation('Alice', 'Acme', 'WORKS_AT')],
      }));
      const closer = new Minizep({ store: pg, llm: bye, embedder: new HashEmbedder(DIMS) });
      await closer.ingest.addEpisode({ groupId: 'h', content: 'alice left acme' });

      // NB: test the specific Alice->Acme fact, not the relation name —
      // "Carol --WORKS_AT--> Globex" is still legitimately true
      const isAliceAcme = (r: { fact: { fact: string } }) => r.fact.fact.includes('Alice') && r.fact.fact.includes('Acme');

      const current = await dbz.searchFacts('Alice works at Acme', { groupId: 'h' });
      assert.ok(!current.some(isAliceAcme), 'the closed Alice->Acme fact must not appear as current');

      const historical = await dbz.searchFacts('Alice works at Acme', { groupId: 'h', includeHistorical: true });
      assert.ok(historical.some(isAliceAcme), 'it must still be reachable with include_historical');
    } finally {
      await pg.close();
    }
  });
}
