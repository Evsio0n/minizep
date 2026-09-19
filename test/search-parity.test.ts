import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function makeZep(store: MemoryGraphStore | PostgresStore, embedder = new HashEmbedder(DIMS)) {
  const byContent = new Map(CORPUS.map((c) => [c.content, c.result]));
  const llm = new ScriptedLLM(
    (content) => byContent.get(content) ?? { entities: [], facts: [], invalidations: [] },
    false,
    0,
  );
  return new Minizep({ store, llm, embedder });
}

async function seed(zep: Minizep, group: string) {
  for (const c of CORPUS) await zep.ingest.addEpisode({ groupId: group, content: c.content });
}

test('search parity: memory backend (in-process scoring)', async () => {
  const zep = makeZep(new MemoryGraphStore());
  await seed(zep, 'g');

  const hits = await zep.searchFacts('Bob likes Pizza', { groupId: 'g' });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].sourceName, 'Bob');
  assert.equal(hits[0].fact.name, 'LIKES');
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
