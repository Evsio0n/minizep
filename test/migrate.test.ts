import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Minizep } from '../src/index.js';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { PostgresStore } from '../src/store/postgres-store.js';
import { migrateSnapshot } from '../src/store/migrate.js';
import { isFactActive } from '../src/model/types.js';
import { ScriptedLLM, entity, fact, invalidation } from './helpers.js';
import { HashEmbedder } from '../src/provider/interfaces.js';
import type { ExtractionResult } from '../src/provider/interfaces.js';

const DIMS = 8;
/** Tests own a dedicated schema: they must not disturb real data, and a
 *  leftover vector(N) column from another run must not break them. */
const TEST_SCHEMA = 'minizep_test_migrate';
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

const scenario = (entities: ReturnType<typeof entity>[], facts: ReturnType<typeof fact>[], invs: ReturnType<typeof invalidation>[]): ExtractionResult => ({
  entities,
  facts,
  invalidations: invs,
});

/** Build a small but semantically rich graph in an in-memory store. */
async function buildSourceGraph(): Promise<MemoryGraphStore> {
  const store = new MemoryGraphStore();
  const zep = new Minizep({
    store,
    embedder: new HashEmbedder(DIMS),
    llm: new ScriptedLLM((content) => {
      if (content.includes('left')) {
        return scenario([entity('Alice'), entity('Acme', ['Organization'])], [], [invalidation('Alice', 'Acme', 'WORKS_AT')]);
      }
      if (content.includes('bob')) {
        return scenario([entity('Bob'), entity('Globex', ['Organization'])], [fact('Bob', 'Globex', 'WORKS_AT')], []);
      }
      return scenario(
        [entity('Alice'), entity('Acme', ['Organization'])],
        [fact('Alice', 'Acme', 'WORKS_AT', { validAt: new Date('2024-01-01T00:00:00Z') })],
        [],
      );
    }),
  });
  await zep.ingest.addEpisode({ groupId: 'mig', content: 'alice works at acme' });
  await zep.ingest.addEpisode({ groupId: 'mig', content: 'bob works at globex' });
  await zep.ingest.addEpisode({ groupId: 'mig', content: 'alice left acme' });
  return store;
}

if (!URL) {
  test('migration (skipped: no database reachable)', { skip: true }, () => {});
} else {
  test('migration: a JSON snapshot moves into Postgres without losing temporal state', async () => {
    const source = await buildSourceGraph();
    const snapshot = source.toJSON();

    const target = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await target.reset();
    try {
      const report = await migrateSnapshot(snapshot, target);

      assert.equal(report.episodes, 3);
      assert.equal(report.entities, 4, 'Alice, Acme, Bob, Globex');
      assert.equal(report.facts, 2);
      assert.equal(report.skippedFacts.length, 0);
      assert.equal(report.mergedEntities.length, 0);

      // the termination must still be a closed edge, not a new one
      const alice = await target.findEntityByName('mig', 'Alice');
      const acme = await target.findEntityByName('mig', 'Acme');
      assert.ok(alice && acme);
      const aliceFacts = await target.getFactsForEntity(alice.uuid);
      assert.equal(aliceFacts.length, 1, 'no redundant LEFT edge was created');
      const worksAt = aliceFacts[0];
      assert.equal(worksAt.name, 'WORKS_AT');
      assert.equal(worksAt.validAt?.getTime(), new Date('2024-01-01T00:00:00Z').getTime());
      assert.ok(worksAt.invalidAt, 'validity window survived the migration');
      assert.ok(worksAt.expiredAt);
      assert.equal(isFactActive(worksAt), false);

      // and the still-true fact is still true
      const bob = await target.findEntityByName('mig', 'Bob');
      const bobFacts = await target.getFactsForEntity(bob!.uuid);
      assert.equal(bobFacts.length, 1);
      assert.equal(isFactActive(bobFacts[0]), true);
    } finally {
      await target.close();
    }
  });

  test('migration: re-running is idempotent (same uuids, same counts)', async () => {
    const source = await buildSourceGraph();
    const snapshot = source.toJSON();
    const target = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await target.reset();
    try {
      await migrateSnapshot(snapshot, target);
      const second = await migrateSnapshot(snapshot, target);

      assert.equal(second.episodes, 3, 'the upsert path re-writes rather than duplicating');
      assert.equal((await target.getEpisodes('mig')).length, 3);
      assert.equal((await target.getEntities('mig')).length, 4);
      assert.equal((await target.getFacts('mig')).length, 2);
    } finally {
      await target.close();
    }
  });
}
