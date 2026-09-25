import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { uuid, type EntityEdge, type EntityNode } from '../src/model/types.js';
import { runStoreConformance } from './store-conformance.js';

runStoreConformance('memory', async () => new MemoryGraphStore());

const node = (name: string, nameEmbedding?: number[]): EntityNode => ({
  type: 'entity',
  uuid: uuid(),
  groupId: 'g',
  name,
  labels: [],
  summary: '',
  attributes: {},
  createdAt: new Date(),
  nameEmbedding,
});

test('[memory] the first stored vector pins the dimension; another length is rejected like in Postgres', async () => {
  const s = new MemoryGraphStore();
  assert.equal(s.embeddingDims, undefined);
  const a = node('Alice', [1, 0, 0, 0]);
  const b = node('Acme');
  await s.upsertEntity(a);
  await s.upsertEntity(b);
  assert.equal(s.embeddingDims, 4);

  await assert.rejects(s.upsertEntity(node('Bad', [1, 2])), /embedding dimension mismatch: store expects 4, got 2/);
  const edge: EntityEdge = {
    type: 'fact',
    uuid: uuid(),
    groupId: 'g',
    sourceNodeUuid: a.uuid,
    targetNodeUuid: b.uuid,
    name: 'WORKS_AT',
    fact: 'Alice works at Acme',
    episodes: [],
    createdAt: new Date(),
    attributes: {},
    factEmbedding: new Array(256).fill(0.1),
  };
  await assert.rejects(s.addFact(edge), /store expects 4, got 256/);
  assert.equal((await s.getFacts('g')).length, 0);
});

test('[memory] a loaded snapshot pins the dimension it was written with', async () => {
  const src = new MemoryGraphStore();
  await src.upsertEntity(node('Alice', [1, 0, 0]));
  const s = new MemoryGraphStore();
  s.loadJSON(src.toJSON());
  assert.equal(s.embeddingDims, 3);
  await assert.rejects(s.upsertEntity(node('Bob', [1, 0])), /dimension mismatch/);
});

test('[memory] a snapshot holding mixed vector lengths pins the most common one', async () => {
  const snapshot = JSON.stringify({
    episodes: [],
    // a legacy record comes first; the majority decides
    entities: [node('Legacy', [1, 0]), node('Alice', [1, 0, 0]), node('Acme', [0, 1, 0])],
    facts: [],
  });
  const s = new MemoryGraphStore();
  s.loadJSON(snapshot);
  assert.equal(s.embeddingDims, 3);
});
