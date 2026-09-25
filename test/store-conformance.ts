import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphStore } from '../src/store/memory-store.js';
import { isFactActive, uuid, type EntityEdge, type EntityNode, type EpisodicNode } from '../src/model/types.js';

/**
 * Backend conformance suite.
 *
 * Every GraphStore implementation must pass these, so a database backend can be
 * swapped in without the pipeline noticing. Run it for each backend.
 */
export function runStoreConformance(name: string, makeStore: () => Promise<GraphStore>, cleanup?: (s: GraphStore) => Promise<void>) {
  const withStore = async (fn: (s: GraphStore) => Promise<void>) => {
    const store = await makeStore();
    try {
      await fn(store);
    } finally {
      await cleanup?.(store);
    }
  };

  const episode = (over: Partial<EpisodicNode> = {}): EpisodicNode => ({
    type: 'episode',
    uuid: uuid(),
    groupId: 'g1',
    name: 'ep',
    source: 'text',
    sourceDescription: 'test',
    content: 'content',
    validAt: new Date('2024-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-02T00:00:00Z'),
    ...over,
  });

  const entity = (nm: string, over: Partial<EntityNode> = {}): EntityNode => ({
    type: 'entity',
    uuid: uuid(),
    groupId: 'g1',
    name: nm,
    labels: ['Person'],
    summary: `${nm} summary`,
    attributes: { note: 'x' },
    createdAt: new Date('2024-01-02T00:00:00Z'),
    ...over,
  });

  const fact = (src: string, tgt: string, over: Partial<EntityEdge> = {}): EntityEdge => ({
    type: 'fact',
    uuid: uuid(),
    groupId: 'g1',
    sourceNodeUuid: src,
    targetNodeUuid: tgt,
    name: 'WORKS_AT',
    fact: 'a --WORKS_AT--> b',
    episodes: [],
    createdAt: new Date('2024-01-02T00:00:00Z'),
    attributes: {},
    ...over,
  });

  test(`[${name}] episodes round-trip every field, including failure state`, async () => {
    await withStore(async (s) => {
      const ep = episode({ status: 'failed', error: 'llm down', contentHash: 'abc123' });
      await s.addEpisode(ep);
      const [got] = await s.getEpisodes('g1');
      assert.ok(got);
      assert.equal(got.uuid, ep.uuid);
      assert.equal(got.groupId, 'g1');
      assert.equal(got.content, 'content');
      assert.equal(got.source, 'text');
      assert.equal(got.status, 'failed');
      assert.equal(got.error, 'llm down');
      assert.equal(got.contentHash, 'abc123');
      assert.equal(got.validAt.getTime(), ep.validAt.getTime());
      assert.equal(got.createdAt.getTime(), ep.createdAt.getTime());
    });
  });

  test(`[${name}] an episode is fetched by uuid, and re-saving it updates its status in place`, async () => {
    await withStore(async (s) => {
      const ep = episode({ status: 'pending', contentHash: 'k@2024-01-01' });
      await s.addEpisode(ep);
      assert.equal((await s.getEpisode(ep.uuid))?.status, 'pending');

      await s.addEpisode({ ...ep, status: 'failed', error: 'embeddings API 502' });
      await s.addEpisode({ ...ep, status: 'processed', error: undefined });
      const got = await s.getEpisode(ep.uuid);
      assert.equal(got?.status, 'processed');
      assert.equal(got?.error, undefined, 'a cleared error is cleared in storage too');
      assert.equal((await s.getEpisodes('g1')).length, 1, 'still one record');
      assert.equal(await s.getEpisode(uuid()), undefined);
    });
  });

  test(`[${name}] episodes are scoped by group and removable`, async () => {
    await withStore(async (s) => {
      const a = episode({ groupId: 'g1' });
      const b = episode({ groupId: 'g2' });
      await s.addEpisode(a);
      await s.addEpisode(b);
      assert.equal((await s.getEpisodes()).length, 2);
      assert.equal((await s.getEpisodes('g1')).length, 1);
      await s.removeEpisode(a.uuid);
      assert.equal((await s.getEpisodes('g1')).length, 0);
      assert.equal((await s.getEpisodes('g2')).length, 1);
    });
  });

  test(`[${name}] entity lookup by name is case-insensitive and group-scoped`, async () => {
    await withStore(async (s) => {
      await s.upsertEntity(entity('Alice', { groupId: 'g1' }));
      await s.upsertEntity(entity('alice', { groupId: 'g2' }));

      const found = await s.findEntityByName('g1', 'ALICE');
      assert.ok(found, 'case-insensitive match within the group');
      assert.equal(found.name, 'Alice');
      assert.equal((await s.findEntityByName('g2', 'Alice'))?.name, 'alice');
      assert.equal(await s.findEntityByName('g3', 'Alice'), undefined);
    });
  });

  test(`[${name}] a second entity with the same name replaces the first (name uniqueness)`, async () => {
    await withStore(async (s) => {
      const first = entity('Alice');
      const second = entity('Alice', { summary: 'updated summary' });
      await s.upsertEntity(first);
      await s.upsertEntity(second);

      const all = await s.getEntities('g1');
      assert.equal(all.length, 1, 'the store must not hold two entities named Alice');
      assert.equal(all[0].summary, 'updated summary', 'the newer data wins');
      assert.equal(
        (await s.findEntityByName('g1', 'Alice'))?.uuid,
        first.uuid,
        'identity stays stable — existing facts keep pointing at the same entity',
      );
    });
  });

  test(`[${name}] entity attributes survive the round-trip`, async () => {
    await withStore(async (s) => {
      const withAttrs = entity('Bob', { attributes: { age: 42, tags: ['x', 'y'], nested: { a: 1 } } });
      await s.upsertEntity(withAttrs);
      const got = await s.getEntity(withAttrs.uuid);
      assert.deepEqual(got?.attributes, { age: 42, tags: ['x', 'y'], nested: { a: 1 } });
      assert.deepEqual(got?.labels, ['Person']);
    });
  });

  test(`[${name}] facts round-trip their temporal window`, async () => {
    await withStore(async (s) => {
      const a = entity('Alice');
      const b = entity('Acme', { labels: ['Organization'] });
      await s.upsertEntity(a);
      await s.upsertEntity(b);
      const f = fact(a.uuid, b.uuid, {
        validAt: new Date('2024-01-01T00:00:00Z'),
        invalidAt: new Date('2024-06-01T00:00:00Z'),
        expiredAt: new Date('2024-07-01T00:00:00Z'),
        episodes: [uuid()],
        attributes: { invalidatedBy: 'left' },
      });
      await s.addFact(f);

      const got = await s.getFact(f.uuid);
      assert.ok(got);
      assert.equal(got.validAt?.getTime(), f.validAt!.getTime());
      assert.equal(got.invalidAt?.getTime(), f.invalidAt!.getTime());
      assert.equal(got.expiredAt?.getTime(), f.expiredAt!.getTime());
      assert.deepEqual(got.episodes, f.episodes);
      assert.deepEqual(got.attributes, { invalidatedBy: 'left' });
      assert.equal(isFactActive(got), false);
    });
  });

  test(`[${name}] facts are reachable from both endpoints`, async () => {
    await withStore(async (s) => {
      const a = entity('Alice');
      const b = entity('Acme');
      await s.upsertEntity(a);
      await s.upsertEntity(b);
      const f = fact(a.uuid, b.uuid);
      await s.addFact(f);

      assert.equal((await s.getFactsForEntity(a.uuid)).length, 1);
      assert.equal((await s.getFactsForEntity(b.uuid)).length, 1);
      assert.equal((await s.getFactsBetween(a.uuid, b.uuid)).length, 1);
    });
  });

  test(`[${name}] getFactsBetween only returns currently-true facts`, async () => {
    await withStore(async (s) => {
      const a = entity('Alice');
      const b = entity('Acme');
      await s.upsertEntity(a);
      await s.upsertEntity(b);
      await s.addFact(fact(a.uuid, b.uuid, { uuid: uuid(), expiredAt: new Date('2024-07-01T00:00:00Z') }));
      assert.equal((await s.getFactsBetween(a.uuid, b.uuid)).length, 0, 'expired fact is filtered out');
    });
  });

  test(`[${name}] facts and entities are scoped by group`, async () => {
    await withStore(async (s) => {
      const a1 = entity('Alice', { groupId: 'g1' });
      const b1 = entity('Acme', { groupId: 'g1' });
      const a2 = entity('Alice', { groupId: 'g2' });
      await s.upsertEntity(a1);
      await s.upsertEntity(b1);
      await s.upsertEntity(a2);
      await s.addFact(fact(a1.uuid, b1.uuid, { groupId: 'g1' }));

      assert.equal((await s.getFacts('g1')).length, 1);
      assert.equal((await s.getFacts('g2')).length, 0);
      assert.equal((await s.getEntities('g1')).length, 2);
      assert.equal((await s.getEntities('g2')).length, 1);

      // groups holding an entity or only an episode, each once
      await s.addEpisode(episode({ groupId: 'g3' }));
      await s.addEpisode(episode({ groupId: 'g3' }));
      assert.ok(s.listGroups, 'both backends list their groups');
      assert.deepEqual((await s.listGroups()).sort(), ['g1', 'g2', 'g3']);
    });
  });

  test(`[${name}] updateFact persists validity changes`, async () => {
    await withStore(async (s) => {
      const a = entity('Alice');
      const b = entity('Acme');
      await s.upsertEntity(a);
      await s.upsertEntity(b);
      const f = fact(a.uuid, b.uuid);
      await s.addFact(f);

      const end = new Date('2024-05-05T00:00:00Z');
      await s.updateFact({ ...f, invalidAt: end, expiredAt: end });
      const got = await s.getFact(f.uuid);
      assert.equal(got?.invalidAt?.getTime(), end.getTime());
      assert.equal(isFactActive(got!), false);
    });
  });
}
