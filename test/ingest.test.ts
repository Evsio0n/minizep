import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { IngestPipeline } from '../src/pipeline/ingest.js';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { ScriptedLLM, BrokenLLM, deterministicEmbedder, SlowEmbedder, entity, fact, invalidation } from './helpers.js';
import type { ExtractionResult } from '../src/provider/interfaces.js';

const scenario = (
  entities: ReturnType<typeof entity>[],
  facts: ReturnType<typeof fact>[] = [],
  invalidations: ReturnType<typeof invalidation>[] = [],
): ExtractionResult => ({ entities, facts, invalidations });

test('ingest: repeating the same statement reinforces the edge instead of duplicating it', async () => {
  const llm = new ScriptedLLM(() =>
    scenario([entity('Alice'), entity('Acme', ['Organization'])], [fact('Alice', 'Acme', 'WORKS_AT')]),
  );
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  const second = await zep.ingest.addEpisode({ groupId: 'g', content: 'ALICE WORKS AT ACME!' });

  assert.equal((await zep.store.getFacts('g')).length, 1, 'no duplicate edge');
  assert.equal(second.reinforced.length, 1, 'second statement reinforces the existing edge');
  assert.equal(second.facts.length, 0);
  assert.equal(second.reinforced[0].episodes.length, 2, 'both episodes are recorded as provenance');
});

test('ingest: identical content in the same group is ingested once (idempotency)', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('Alice')], []));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  const first = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice likes tea.' });
  const again = await zep.ingest.addEpisode({ groupId: 'g', content: '  alice   likes tea.  ' });

  assert.equal(again.duplicate, true, 'normalised whitespace/case still counts as a duplicate');
  assert.equal(again.episode.uuid, first.episode.uuid);
  assert.equal((await zep.store.getEpisodes('g')).length, 1);
  assert.equal(llm.calls.length, 1, 'the LLM must not be billed twice for the same text');
});

test('ingest: the same text in a different group is a distinct episode', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('Alice')], []));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  await zep.ingest.addEpisode({ groupId: 'a', content: 'Alice likes tea.' });
  const other = await zep.ingest.addEpisode({ groupId: 'b', content: 'Alice likes tea.' });

  assert.ok(!other.duplicate);
  assert.equal((await zep.store.getEpisodes()).length, 2);
});

test('ingest: idempotency can be disabled explicitly', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('Alice')], []));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice likes tea.' });
  const again = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice likes tea.' }, { idempotent: false });

  assert.ok(!again.duplicate);
  assert.equal((await zep.store.getEpisodes('g')).length, 2);
});

test('ingest: an extraction failure is isolated — raw text is preserved, nothing half-written', async () => {
  const llm = new BrokenLLM('deepseek returned empty content');
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'important note that must not be lost' });

  assert.equal(res.failed, true);
  assert.match(res.error ?? '', /empty content/);
  assert.equal(res.episode.status, 'failed');

  const episodes = await zep.store.getEpisodes('g');
  assert.equal(episodes.length, 1, 'the episode is still stored');
  assert.equal(episodes[0].content, 'important note that must not be lost');
  assert.equal((await zep.store.getEntities('g')).length, 0, 'no partial graph was written');
  assert.equal((await zep.store.getFacts('g')).length, 0);
});

test('ingest: a failed episode does not block re-ingesting the same text later', async () => {
  const store = new MemoryGraphStore();
  const broken = new IngestPipeline(store, new BrokenLLM(), deterministicEmbedder());
  await broken.addEpisode({ groupId: 'g', content: 'retry me' });

  const working = new IngestPipeline(
    store,
    new ScriptedLLM(() => scenario([entity('Retry')], [])),
    deterministicEmbedder(),
  );
  const res = await working.addEpisode({ groupId: 'g', content: 'retry me' });

  assert.ok(!res.duplicate, 'the earlier failure must not make this look like a duplicate');
  assert.equal(res.entities.length, 1);
  assert.equal((await store.getEntities('g')).length, 1);
});

test('ingest: concurrent episodes are serialised — no duplicate entities under interleaving', async () => {
  // every call introduces the SAME entity name; without serialisation two calls
  // both miss it in the lookup and each insert their own copy
  const llm = new ScriptedLLM(
    (content) => scenario([entity('Shared'), entity(`E-${content}`)], []),
    false,
    3, // forces real interleaving at the await point
  );
  // an embedder that yields at a macrotask boundary, like a real network call
  const zep = new Minizep({ llm, embedder: new SlowEmbedder(2) });

  const N = 10;
  await Promise.all(
    Array.from({ length: N }, (_, i) => zep.ingest.addEpisode({ groupId: 'g', content: `note-${i}` })),
  );

  const entities = await zep.store.getEntities('g');
  const shared = entities.filter((e) => e.name === 'Shared');
  assert.equal(shared.length, 1, `expected exactly one "Shared" entity, got ${shared.length}`);
  assert.equal(entities.length, N + 1, 'one unique entity per episode plus the shared one');
  assert.equal((await zep.store.getEpisodes('g')).length, N);
});

test('ingest: a rejected extraction does not break the lock for later callers', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('After')], []));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  // a duplicate short-circuits, a failure returns normally — neither may wedge
  // the mutex chain
  await Promise.all([
    zep.ingest.addEpisode({ groupId: 'g', content: 'first' }),
    zep.ingest.addEpisode({ groupId: 'g', content: 'second' }),
  ]);
  await zep.ingest.addEpisode({ groupId: 'g', content: 'third' });

  assert.equal((await zep.store.getEpisodes('g')).length, 3);
});

test('ingest: failed episodes can be retried once the LLM recovers', async () => {
  const store = new MemoryGraphStore();
  const broken = new IngestPipeline(store, new BrokenLLM(), deterministicEmbedder());
  await broken.addEpisode({ groupId: 'g', content: 'note one' });
  await broken.addEpisode({ groupId: 'g', content: 'note two' });
  assert.equal((await store.getEpisodes('g')).filter((e) => e.status === 'failed').length, 2);

  // same store, working LLM
  const healthy = new IngestPipeline(
    store,
    new ScriptedLLM((content) => scenario([entity(`E-${content}`)], [])),
    deterministicEmbedder(),
  );
  const outcome = await healthy.retryFailed('g');

  assert.deepEqual(outcome, { retried: 2, succeeded: 2, stillFailing: 0 });
  assert.equal((await store.getEpisodes('g')).filter((e) => e.status === 'failed').length, 0, 'no failed records left');
  assert.equal((await store.getEpisodes('g')).length, 2, 'exactly one processed episode per input');
  assert.equal((await store.getEntities('g')).length, 2);
});

test('ingest: a retry that fails again keeps one record with a fresh error', async () => {
  const store = new MemoryGraphStore();
  const broken = new IngestPipeline(store, new BrokenLLM('first failure'), deterministicEmbedder());
  await broken.addEpisode({ groupId: 'g', content: 'still broken' });

  const stillBroken = new IngestPipeline(store, new BrokenLLM('second failure'), deterministicEmbedder());
  const outcome = await stillBroken.retryFailed('g');

  assert.deepEqual(outcome, { retried: 1, succeeded: 0, stillFailing: 1 });
  const episodes = await store.getEpisodes('g');
  assert.equal(episodes.length, 1, 'retries must not pile up duplicate failed records');
  assert.match(episodes[0].error ?? '', /second failure/);
});
