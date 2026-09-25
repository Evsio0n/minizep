import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/store/postgres-store.js';
import { runStoreConformance } from './store-conformance.js';
import type { GraphStore } from '../src/store/memory-store.js';
import { isFactActive, isFactKnown, type EntityEdge, type EntityNode } from '../src/model/types.js';

import { readFileSync } from 'node:fs';

/** Prefer an explicit env var; fall back to the URL written by infra/postgres/setup.sh. */
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
const DIMS = 8;
/** Tests own a dedicated schema: they must not disturb real data, and a
 *  leftover vector(N) column from another run must not break them. */
const TEST_SCHEMA = 'minizep_test_store'; // own schema: parallel test files must not truncate each other

/** Reachable? Postgres-backed tests skip (not fail) when no database is up. */
async function reachable(): Promise<boolean> {
  if (!URL) return false;
  try {
    const probe = new PostgresStore({ connectionString: URL, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await probe.health();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const available = await reachable();
if (!available) {
  test('postgres conformance (skipped: no database reachable)', { skip: true }, () => {});
} else {
  // each test starts from a clean schema so counts are deterministic
  const fresh = async (): Promise<GraphStore> => {
    const s = new PostgresStore({ connectionString: URL!, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await s.reset();
    return s;
  };
  runStoreConformance('postgres', fresh, async (s) => {
    await (s as PostgresStore).close();
  });

  test('[postgres] vector search returns nearest facts in distance order', async () => {
    const s = new PostgresStore({ connectionString: URL!, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await s.reset();
    try {
      const a: EntityNode = { type: 'entity', uuid: crypto.randomUUID(), groupId: 'v', name: 'Alice', labels: [], summary: '', attributes: {}, createdAt: new Date(), nameEmbedding: [1, 0, 0, 0, 0, 0, 0, 0] };
      const b: EntityNode = { type: 'entity', uuid: crypto.randomUUID(), groupId: 'v', name: 'Acme', labels: [], summary: '', attributes: {}, createdAt: new Date(), nameEmbedding: [0, 1, 0, 0, 0, 0, 0, 0] };
      await s.upsertEntity({ ...a });
      await s.upsertEntity({ ...b });

      const mk = (vec: number[], factText: string) => ({
        type: 'fact' as const, uuid: crypto.randomUUID(), groupId: 'v',
        sourceNodeUuid: a.uuid, targetNodeUuid: b.uuid, name: 'R', fact: factText,
        episodes: [], createdAt: new Date(), attributes: {}, factEmbedding: vec,
      });
      await s.addFact(mk([1, 0, 0, 0, 0, 0, 0, 0], 'exact match'));
      await s.addFact(mk([0, 1, 0, 0, 0, 0, 0, 0], 'orthogonal'));

      const hits = await s.searchFactsByVector([1, 0, 0, 0, 0, 0, 0, 0], { groupId: 'v', limit: 5 });
      assert.equal(hits.length, 2);
      assert.equal(hits[0].edge.fact, 'exact match');
      assert.ok(hits[0].distance < hits[1].distance, 'nearest first');
    } finally {
      await s.close();
    }
  });

  test('[postgres] a wrong-dimension embedding fails loudly instead of scoring garbage', async () => {
    const s = new PostgresStore({ connectionString: URL!, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await s.reset();
    try {
      await assert.rejects(
        () => s.upsertEntity({
          type: 'entity', uuid: crypto.randomUUID(), groupId: 'x', name: 'Bad',
          labels: [], summary: '', attributes: {}, createdAt: new Date(),
          nameEmbedding: [1, 2, 3], // 3 dims, schema expects 8
        }),
        /dimension mismatch/,
      );
    } finally {
      await s.close();
    }
  });

  test('[postgres] the temporal predicate matches isFactActive for every (at, asOf)', async () => {
    const s = new PostgresStore({ connectionString: URL!, embeddingDims: DIMS, schema: TEST_SCHEMA });
    await s.reset();
    try {
      const D = (x: string) => new Date(x);
      const vec = [1, 0, 0, 0, 0, 0, 0, 0];
      const mkEntity = (name: string): EntityNode => ({
        type: 'entity', uuid: crypto.randomUUID(), groupId: 'tp', name, labels: [], summary: '', attributes: {}, createdAt: D('2024-03-01'),
      });
      const a = mkEntity('Alice');
      const b = mkEntity('Acme');
      await s.upsertEntity(a);
      await s.upsertEntity(b);

      const windows: Partial<EntityEdge>[] = [
        {}, // no window at all
        { validAt: D('2024-01-01') },
        { validAt: D('2024-01-01'), invalidAt: D('2025-01-01'), expiredAt: D('2025-06-01') }, // end learned later
        { validAt: D('2024-01-01'), invalidAt: D('2025-01-01') }, // end came with the fact
        { validAt: D('2024-01-01'), invalidAt: D('2030-01-01'), expiredAt: D('2025-06-01') }, // scheduled end
        { validAt: D('2024-01-01'), expiredAt: D('2025-06-01') }, // retracted
        { validAt: D('2024-06-01'), invalidAt: D('2024-06-01'), expiredAt: D('2025-06-01') }, // empty window
        { validAt: D('2029-01-01') }, // starts in the future
      ];
      const facts: EntityEdge[] = windows.map((w, i) => ({
        type: 'fact', uuid: crypto.randomUUID(), groupId: 'tp', sourceNodeUuid: a.uuid, targetNodeUuid: b.uuid,
        name: 'R', fact: `fact ${i}`, episodes: [], createdAt: D('2024-03-01'), attributes: {}, factEmbedding: vec, ...w,
      }));
      for (const f of facts) await s.addFact(f);

      const instants = ['2023-01-01', '2024-02-01', '2024-04-01', '2024-06-01', '2025-03-01', '2025-09-01', '2029-06-01', '2031-01-01'].map(D);
      const ids = (rows: { edge: EntityEdge }[]) => rows.map((r) => r.edge.fact).sort();
      for (const at of instants) {
        for (const asOf of [...instants, undefined]) {
          const expected = facts.filter((f) => isFactActive(f, at, asOf)).map((f) => f.fact).sort();
          const got = ids(await s.searchFactsByVector(vec, { groupId: 'tp', limit: 100, activeAt: at, asOf }));
          assert.deepEqual(got, expected, `at=${at.toISOString()} asOf=${asOf?.toISOString() ?? 'now'}`);
        }
      }
      for (const asOf of instants) {
        const expected = facts.filter((f) => isFactKnown(f, asOf)).map((f) => f.fact).sort();
        const got = ids(await s.searchFactsByVector(vec, { groupId: 'tp', limit: 100, activeAt: null, asOf }));
        assert.deepEqual(got, expected, `history asOf=${asOf.toISOString()}`);
      }
    } finally {
      await s.close();
    }
  });
}
