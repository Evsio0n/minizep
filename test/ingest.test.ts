import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep, FallbackEmbedder } from '../src/index.js';
import { IngestPipeline, mentions } from '../src/pipeline/ingest.js';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { contentHash } from '../src/util/hash.js';
import { HashEmbedder } from '../src/provider/interfaces.js';
import type { EpisodicNode, UUID } from '../src/model/types.js';
import { ScriptedLLM, BrokenLLM, deterministicEmbedder, SlowEmbedder, entity, fact, invalidation } from './helpers.js';
import type { Embedder, ExtractionResult, LLMProvider } from '../src/provider/interfaces.js';

const scenario = (
  entities: ReturnType<typeof entity>[],
  facts: ReturnType<typeof fact>[] = [],
  invalidations: ReturnType<typeof invalidation>[] = [],
): ExtractionResult => ({ entities, facts, invalidations });

/**
 * Keeps its own copy of each episode, like a database: a status change is
 * only visible after addEpisode() is called again (which is what Postgres
 * needs, and what the old pipeline forgot).
 */
class CopyingStore extends MemoryGraphStore {
  private rows = new Map<UUID, EpisodicNode>();
  override async addEpisode(ep: EpisodicNode): Promise<void> {
    this.rows.set(ep.uuid, structuredClone(ep));
  }
  override async getEpisode(uuid: UUID): Promise<EpisodicNode | undefined> {
    const row = this.rows.get(uuid);
    return row && structuredClone(row);
  }
  override async getEpisodes(groupId?: string): Promise<EpisodicNode[]> {
    return [...this.rows.values()].filter((e) => !groupId || e.groupId === groupId).map((e) => structuredClone(e));
  }
  override async removeEpisode(uuid: UUID): Promise<void> {
    this.rows.delete(uuid);
  }
}

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
  const zep = new Minizep({ store: new CopyingStore(), llm, embedder: deterministicEmbedder() });

  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'important note that must not be lost' });

  assert.equal(res.failed, true);
  assert.match(res.error ?? '', /empty content/);
  const stored = await zep.store.getEpisode(res.episode.uuid);
  assert.equal(stored?.status, 'failed', 'the failure is persisted, not only set in memory');
  assert.match(stored?.error ?? '', /empty content/);

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
  const store = new CopyingStore();
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
  const store = new CopyingStore();
  const broken = new IngestPipeline(store, new BrokenLLM('first failure'), deterministicEmbedder());
  await broken.addEpisode({ groupId: 'g', content: 'still broken' });

  const stillBroken = new IngestPipeline(store, new BrokenLLM('second failure'), deterministicEmbedder());
  const outcome = await stillBroken.retryFailed('g');

  assert.deepEqual(outcome, { retried: 1, succeeded: 0, stillFailing: 1 });
  const episodes = await store.getEpisodes('g');
  assert.equal(episodes.length, 1, 'retries must not pile up duplicate failed records');
  assert.equal(episodes[0].status, 'failed');
  assert.match(episodes[0].error ?? '', /second failure/);
});

/* ---------------- lifecycle, atomicity and recovery ---------------- */

const EMPTY: ExtractionResult = { entities: [], facts: [], invalidations: [] };

test('ingest: an episode is persisted as pending, and its final status is persisted too', async () => {
  const store = new CopyingStore();
  const seenDuringExtraction: (string | undefined)[] = [];
  const llm = new ScriptedLLM(async () => {
    seenDuringExtraction.push((await store.getEpisodes('g'))[0]?.status);
    return scenario([entity('Alice')]);
  });
  const res = await new IngestPipeline(store, llm, deterministicEmbedder()).addEpisode({ groupId: 'g', content: 'hi' });

  assert.deepEqual(seenDuringExtraction, ['pending']);
  assert.equal(res.status, 'processed');
  assert.equal((await store.getEpisode(res.episode.uuid))?.status, 'processed', 'the status survives a round-trip');
});

test('ingest: saveEpisode + processEpisode split the pipeline; recoverPending finds unprocessed work', async () => {
  const store = new MemoryGraphStore();
  const llm = new ScriptedLLM((content) => scenario([entity(`E-${content}`)]));
  const pipeline = new IngestPipeline(store, llm, deterministicEmbedder());

  const a = await pipeline.saveEpisode({ groupId: 'g', content: 'first' });
  const b = await pipeline.saveEpisode({ groupId: 'g', content: 'second' });
  assert.equal(a.duplicate, false);
  assert.equal(llm.calls.length, 0, 'saving does no extraction');
  assert.deepEqual((await pipeline.recoverPending('g')).map((e) => e.uuid), [a.episode.uuid, b.episode.uuid]);

  const done = await pipeline.processEpisode(a.episode.uuid);
  assert.equal(done.status, 'processed');
  assert.equal(done.entities.length, 1);
  const again = await pipeline.processEpisode(a.episode.uuid);
  assert.equal(again.status, 'duplicate', 'processing twice is a no-op');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual((await pipeline.recoverPending()).map((e) => e.uuid), [b.episode.uuid]);

  const dup = await pipeline.saveEpisode({ groupId: 'g', content: 'first' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.episode.uuid, a.episode.uuid);
});

test('ingest: two concurrent processEpisode calls for one episode process it once', async () => {
  // with a store that hands out copies, only the re-read under the lock sees
  // that the first call already finished
  const store = new CopyingStore();
  const llm = new ScriptedLLM(() => scenario([entity('Alice')]), false, 3);
  const pipeline = new IngestPipeline(store, llm, deterministicEmbedder());
  const { episode } = await pipeline.saveEpisode({ groupId: 'g', content: 'hi' });

  const results = await Promise.all([pipeline.processEpisode(episode.uuid), pipeline.processEpisode(episode.uuid)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['duplicate', 'processed']);
  assert.equal(llm.calls.length, 1);
});

test('ingest: saving a failed episode again persists it as pending, so startup recovery finds it', async () => {
  const store = new CopyingStore();
  await new IngestPipeline(store, new BrokenLLM(), deterministicEmbedder()).addEpisode({ groupId: 'g', content: 'retry me' });
  const pipeline = new IngestPipeline(store, new ScriptedLLM(() => scenario([entity('Retry')])), deterministicEmbedder());

  const { episode, duplicate } = await pipeline.saveEpisode({ groupId: 'g', content: 'retry me' });
  assert.equal(duplicate, false);
  const stored = await store.getEpisode(episode.uuid);
  assert.equal(stored?.status, 'pending');
  assert.equal(stored?.error, undefined);
  assert.deepEqual((await pipeline.recoverPending('g')).map((e) => e.uuid), [episode.uuid]);
});

test('ingest: regression R5 — an embedding outage mid-ingest writes nothing and is retried in place', async () => {
  let calls = 0;
  let down = true;
  const flaky: Embedder = {
    async embed(t: string) {
      // the first vector succeeds, then the service goes away mid-episode
      if (down && ++calls > 1) throw new Error('embeddings API 502: upstream job restarting');
      return new HashEmbedder(64).embed(t);
    },
  };
  const llm = new ScriptedLLM(() => scenario([entity('Dana'), entity('Umbrella', ['Organization'])], [fact('Dana', 'Umbrella', 'WORKS_AT')]));
  const zep = new Minizep({ store: new CopyingStore(), llm, embedder: flaky });

  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Dana works at Umbrella' });
  assert.equal(res.status, 'failed', 'the failure is reported, not thrown');
  assert.equal(res.failed, true);
  assert.match(res.error ?? '', /502/);
  const ep = (await zep.store.getEpisode(res.episode.uuid))!;
  assert.equal(ep.status, 'failed', 'the crashed episode does not claim success');
  assert.match(ep.error ?? '', /502/);
  assert.equal((await zep.store.getEntities('g')).length, 0, 'no half-written entities');
  assert.equal((await zep.store.getFacts('g')).length, 0);

  down = false; // embeddings are back
  const again = await zep.ingest.addEpisode({ groupId: 'g', content: 'Dana works at Umbrella' });
  assert.equal(again.status, 'processed', 'resending the same text is not swallowed as a duplicate');
  assert.equal(again.episode.uuid, ep.uuid, 're-processed in place');
  assert.equal((await zep.store.getEpisode(ep.uuid))?.status, 'processed');
  assert.equal((await zep.store.getEpisode(ep.uuid))?.error, undefined);
  assert.equal((await zep.store.getEpisodes('g')).length, 1);
  assert.equal((await zep.store.getEntities('g')).length, 2);
  assert.equal((await zep.store.getFacts('g')).length, 1);
});

test('ingest: retryFailed sees episodes that failed after extraction (store or embedding errors)', async () => {
  let down = true;
  const embedder: Embedder = {
    async embed(t: string) {
      if (down) throw new Error('fetch failed');
      return new HashEmbedder(64).embed(t);
    },
  };
  const zep = new Minizep({ llm: new ScriptedLLM(() => scenario([entity('Dana')])), embedder });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Dana' });
  down = false;
  assert.deepEqual(await zep.ingest.retryFailed('g'), { retried: 1, succeeded: 1, stillFailing: 0 });
  assert.equal((await zep.store.getEntities('g')).length, 1);
});

test('ingest: regression R7 — the same sentence on a later day is a new episode', async () => {
  const text = 'The production database went down.';
  // the key holds the UTC day: 00:30Z and 23:30Z are one UTC day, but two local
  // days in any zone half an hour or more off UTC. Pinning a far-east and a
  // far-west zone makes the test mean the same on every machine.
  const saved = process.env.TZ;
  try {
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      const llm = new ScriptedLLM(() => scenario([entity('prod-db')]));
      const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

      await zep.ingest.addEpisode({ groupId: 'g', content: text, validAt: new Date('2026-09-01T00:30:00Z') });
      const sameDay = await zep.ingest.addEpisode({ groupId: 'g', content: text, validAt: new Date('2026-09-01T23:30:00Z') });
      const later = await zep.ingest.addEpisode({ groupId: 'g', content: text, validAt: new Date('2026-09-20T08:00:00Z') });

      assert.equal(sameDay.status, 'duplicate', `a resend on the same (UTC) day is still deduplicated (TZ=${tz})`);
      assert.equal(later.status, 'processed', 'a second, separate incident is kept');
      assert.equal((await zep.store.getEpisodes('g')).length, 2);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('ingest: the same note in composed and decomposed Unicode is one episode', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('Zoë')]));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  const composed = 'Zoë moved to Café Müller';
  const decomposed = composed.normalize('NFD'); // what some macOS/iOS inputs send
  assert.notEqual(composed, decomposed);

  await zep.ingest.addEpisode({ groupId: 'g', content: composed });
  const again = await zep.ingest.addEpisode({ groupId: 'g', content: decomposed });
  assert.equal(again.status, 'duplicate');
  assert.equal(llm.calls.length, 1);
});

test('ingest: an explicit idempotencyKey identifies the episode on its own', async () => {
  const llm = new ScriptedLLM(() => scenario([entity('Alice')]));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  const first = await zep.ingest.addEpisode({ groupId: 'g', content: 'v1 of the note', idempotencyKey: 'msg-42' });
  const retried = await zep.ingest.addEpisode({
    groupId: 'g',
    content: 'v1 of the note, re-rendered',
    validAt: new Date('2020-01-01'),
    idempotencyKey: 'msg-42',
  });
  const other = await zep.ingest.addEpisode({ groupId: 'g', content: 'v1 of the note', idempotencyKey: 'msg-43' });

  assert.equal(retried.status, 'duplicate');
  assert.equal(retried.episode.uuid, first.episode.uuid);
  assert.equal(other.status, 'processed', 'another key is another episode, even with the same text');
});

test('ingest: episodes stored by older versions (bare content hash, no status) still deduplicate', async () => {
  const store = new MemoryGraphStore();
  const validAt = new Date();
  await store.addEpisode({
    type: 'episode',
    uuid: crypto.randomUUID(),
    groupId: 'g',
    name: 'legacy',
    source: 'text',
    sourceDescription: 'user input',
    content: 'Alice likes tea.',
    validAt,
    createdAt: validAt,
    contentHash: contentHash('Alice likes tea.'),
  });
  const llm = new ScriptedLLM(() => scenario([entity('Alice')]));
  const res = await new IngestPipeline(store, llm, deterministicEmbedder()).addEpisode({ groupId: 'g', content: 'Alice likes tea.' });
  assert.equal(res.status, 'duplicate');
  assert.equal(llm.calls.length, 0);
});

test('ingest: a failed duplicate is re-processed in place instead of adding a second record', async () => {
  const store = new CopyingStore();
  const failed = await new IngestPipeline(store, new BrokenLLM(), deterministicEmbedder()).addEpisode({ groupId: 'g', content: 'retry me' });
  const res = await new IngestPipeline(store, new ScriptedLLM(() => scenario([entity('Retry')])), deterministicEmbedder()).addEpisode({
    groupId: 'g',
    content: 'retry me',
  });

  assert.equal(res.status, 'processed');
  assert.equal(res.episode.uuid, failed.episode.uuid);
  const episodes = await store.getEpisodes('g');
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, 'processed');
  assert.equal(episodes[0].error, undefined, 'the stale error is cleared');
});

test('ingest: candidates whose endpoints cannot be resolved are counted as dropped', async () => {
  const llm = new ScriptedLLM(() => ({
    entities: [entity('Alice')],
    facts: [fact('Alice', 'Ghost', 'KNOWS')],
    invalidations: [invalidation('Nobody', 'Alice', 'KNOWS')],
  }));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'x' });

  assert.equal(res.status, 'processed');
  assert.deepEqual(res.dropped, { facts: 1, invalidations: 1 });
  assert.equal((await zep.store.getFacts('g')).length, 0);
});

test('ingest: an invalidation naming an entity outside the graph creates no placeholder entity', async () => {
  const llm = new ScriptedLLM(() => ({
    // what the provider's safety net emits for an endpoint it has not seen
    entities: [{ name: 'Bob', labels: [], summary: '' }, { name: 'Initrode', labels: [], summary: '' }],
    facts: [],
    invalidations: [invalidation('Bob', 'Initrode', 'WORKS_AT')],
  }));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initrode' });

  assert.equal((await zep.store.getEntities('g')).length, 0);
  assert.deepEqual(res.dropped, { facts: 0, invalidations: 1 });
});

test('ingest: the episode time is the reference time handed to the LLM', async () => {
  const llm = new ScriptedLLM(() => EMPTY);
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  const validAt = new Date('2026-09-24T00:00:00Z');
  await zep.ingest.addEpisode({ groupId: 'g', content: '昨天的周会上，我们决定把发布推迟到下周五', validAt });
  assert.equal(llm.calls[0].options.referenceTime?.getTime(), validAt.getTime());
});

test('ingest: the active relationships sent to the LLM carry their start', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const llm = new ScriptedLLM((content) => (content === 'one' ? scenario(pair, [fact('Alice', 'Acme', 'WORKS_AT')]) : EMPTY));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'one', validAt: new Date('2024-01-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice left Acme' });

  const [known] = llm.calls[1].knownFacts;
  assert.equal(known.fact, 'Alice --WORKS_AT--> Acme');
  assert.equal(known.validAt?.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('ingest: known entities sent to the LLM carry their summaries; unrelated ones are left out of large graphs', async () => {
  const names = Array.from({ length: 80 }, (_, i) => `Person${i}`);
  const llm = new ScriptedLLM((content) =>
    content === 'seed'
      ? { entities: names.map((n) => ({ name: n, labels: ['Person'], summary: `${n} is someone` })), facts: [], invalidations: [] }
      : { entities: [{ name: 'Person7', labels: [], summary: '' }], facts: [], invalidations: [] },
  );
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'seed' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Person7 called.' });

  const { known, options } = llm.calls[1];
  assert.equal(known[0], 'Person7', 'the entity named in the text comes first');
  assert.ok(known.length <= 51, `at most 50 others are ranked in, got ${known.length - 1}`);
  assert.equal(options.knownEntities?.[0].summary, 'Person7 is someone');
  assert.equal((await zep.store.findEntityByName('g', 'Person7'))?.summary, 'Person7 is someone', 'an empty summary keeps the old one');
});

test('ingest: different groups ingest concurrently, the same group stays serialised', async () => {
  let active = 0;
  let peak = 0;
  const llm: LLMProvider = {
    async extract() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return EMPTY;
    },
    async detectContradiction() {
      return [];
    },
  };
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });

  await Promise.all([zep.ingest.addEpisode({ groupId: 'a', content: '1' }), zep.ingest.addEpisode({ groupId: 'a', content: '2' })]);
  assert.equal(peak, 1, 'same group: one at a time');

  peak = 0;
  await Promise.all([zep.ingest.addEpisode({ groupId: 'a', content: '3' }), zep.ingest.addEpisode({ groupId: 'b', content: '4' })]);
  assert.equal(peak, 2, 'different groups: in parallel');
});

/* ---------------- embeddings never silently change space ---------------- */

test('ingest: regression R9 — an embedding outage fails the episode instead of switching to hash vectors', async () => {
  let up = true;
  const real: Embedder = {
    async embed(t: string) {
      if (!up) throw new Error('fetch failed');
      return new HashEmbedder(1024).embed(t);
    },
  };
  const llm = new ScriptedLLM((content) =>
    content.startsWith('Erin')
      ? scenario([entity('Erin'), entity('Hooli', ['Organization'])], [fact('Erin', 'Hooli', 'WORKS_AT')])
      : scenario([entity('Frank'), entity('Hooli', ['Organization'])], [fact('Frank', 'Hooli', 'WORKS_AT')]),
  );
  const zep = new Minizep({ llm, embedder: new FallbackEmbedder([real]) });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Erin works at Hooli' });
  up = false; // Slurm job hits its time limit, proxy returns 502 / refuses
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Frank works at Hooli' });

  assert.equal(res.status, 'failed');
  assert.match(res.error ?? '', /all embedding tiers failed/);
  const dims = (await zep.store.getFacts('g')).map((f) => f.factEmbedding!.length);
  assert.deepEqual(dims, [1024], 'one embedding space in the index');

  up = true;
  assert.equal((await zep.ingest.retryFailed('g')).succeeded, 1);
  assert.deepEqual((await zep.store.getFacts('g')).map((f) => f.factEmbedding!.length), [1024, 1024]);
});

test('ingest: a vector of the wrong dimension fails the episode before anything is written', async () => {
  let dims = 64;
  const embedder: Embedder = { embed: (t: string) => new HashEmbedder(dims).embed(t) };
  const llm = new ScriptedLLM((content) =>
    content === 'Alice'
      ? scenario([entity('Alice')])
      : // an update to Alice (whose stored vector is fine) comes before the new entity
        scenario([{ name: 'Alice', labels: ['Person'], summary: 'Alice met Bob' }, entity('Bob')]),
  );
  const zep = new Minizep({ llm, embedder });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice' });
  dims = 32; // someone swapped the model
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice met Bob' });

  assert.equal(res.status, 'failed');
  assert.match(res.error ?? '', /dimension mismatch: store expects 64, got 32/);
  assert.equal((await zep.store.getEntities('g')).length, 1);
  assert.equal((await zep.store.findEntityByName('g', 'Alice'))?.summary, 'Alice summary', 'not even the first write happened');
});

test('ingest: records written under another embedding model are re-embedded instead of failing the episode', async () => {
  // what the old hash fallback left behind (R9): a snapshot holding 64- and
  // 16-dim vectors, the odd one first
  const seed = new Minizep({
    llm: new ScriptedLLM(() => scenario([entity('Erin'), entity('Hooli', ['Organization'])], [fact('Erin', 'Hooli', 'WORKS_AT')])),
    embedder: new HashEmbedder(64),
  });
  await seed.ingest.addEpisode({ groupId: 'g', content: 'Erin works at Hooli', validAt: new Date('2024-01-01') });
  const snap = JSON.parse(seed.snapshot());
  const hooli = snap.entities.find((e: { name: string }) => e.name === 'Hooli');
  const legacy = new HashEmbedder(16);
  const frank = {
    type: 'entity',
    uuid: crypto.randomUUID(),
    groupId: 'g',
    name: 'Frank',
    labels: ['Person'],
    summary: 'stale',
    attributes: {},
    createdAt: new Date('2024-02-01'),
    nameEmbedding: await legacy.embed('Frank'),
  };
  snap.entities.push(frank);
  snap.facts.unshift({
    type: 'fact',
    uuid: crypto.randomUUID(),
    groupId: 'g',
    sourceNodeUuid: frank.uuid,
    targetNodeUuid: hooli.uuid,
    name: 'WORKS_AT',
    fact: 'Frank --WORKS_AT--> Hooli',
    episodes: [],
    validAt: new Date('2024-02-01'),
    createdAt: new Date('2024-02-01'),
    attributes: {},
    factEmbedding: await legacy.embed('Frank --WORKS_AT--> Hooli'),
  });
  const store = new MemoryGraphStore();
  store.loadJSON(JSON.stringify(snap));
  assert.equal(store.embeddingDims, 64, 'the most common length is pinned, not the first one seen');

  const llm = new ScriptedLLM(() =>
    scenario([entity('Gina'), entity('Hooli', ['Organization']), entity('Frank')], [fact('Gina', 'Hooli', 'WORKS_AT'), fact('Frank', 'Hooli', 'WORKS_AT')]),
  );
  const zep = new Minizep({ store, llm, embedder: new HashEmbedder(64) });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Gina joined Hooli; Frank still works at Hooli', validAt: new Date('2024-03-01') });

  assert.equal(res.status, 'processed', res.error ?? '');
  assert.equal(res.reinforced.length, 1, "Frank's legacy fact was touched");
  assert.ok((await store.getFacts('g')).some((f) => f.fact === 'Gina --WORKS_AT--> Hooli'));
  assert.equal((await store.findEntityByName('g', 'Frank'))?.nameEmbedding?.length, 64, 'repaired');
  assert.deepEqual((await store.getFacts('g')).map((f) => f.factEmbedding?.length), [64, 64, 64]);
});

test('ingest: an embedder answering with an empty vector fails the episode', async () => {
  const zep = new Minizep({ llm: new ScriptedLLM(() => scenario([entity('Alice')])), embedder: { embed: async () => [] } });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice' });
  assert.equal(res.status, 'failed');
  assert.match(res.error ?? '', /empty vector/);
  assert.equal((await zep.store.getEntities('g')).length, 0);
});

test('ingest: in a large graph, the known entities besides the named ones are the nearest by name embedding', async () => {
  // a stand-in for a real model: the text and "Near" land on one vector, "Far" opposite
  const embedder: Embedder = {
    async embed(t: string) {
      if (t === 'Near' || t.includes('kitten')) return [1, 0, 0, 0];
      if (t === 'Far') return [-1, 0, 0, 0];
      return [0, 1, 0, 0];
    },
  };
  const names = ['Far', ...Array.from({ length: 58 }, (_, i) => `Person${i}`), 'Near'];
  const llm = new ScriptedLLM((content) =>
    content === 'seed' ? scenario(names.map((n) => entity(n))) : EMPTY,
  );
  const zep = new Minizep({ llm, embedder });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'seed' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'a kitten purred' });

  const { known } = llm.calls[1];
  assert.equal(known.length, 50);
  assert.equal(known[0], 'Near', 'the nearest name ranks first');
  assert.ok(!known.includes('Far'), 'the farthest is left out');
});

test('ingest: Latin names written inside CJK text count as named in it', async () => {
  const names = Array.from({ length: 80 }, (_, i) => `Person${i}`);
  const llm = new ScriptedLLM((content) =>
    content === 'seed'
      ? {
          entities: [...names.map((n) => entity(n)), entity('Alice'), entity('Acme', ['Organization'])],
          facts: [fact('Alice', 'Acme', 'WORKS_AT')],
          invalidations: [],
        }
      : EMPTY,
  );
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'seed' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice上周从Acme离职了' });

  const { known, knownFacts, options } = llm.calls[1];
  assert.deepEqual(known.slice(0, 2).sort(), ['Acme', 'Alice']);
  assert.equal(options.knownEntities?.find((e) => e.name === 'Alice')?.summary, 'Alice summary', 'with what is known about them');
  assert.ok(knownFacts.some((f) => f.fact === 'Alice --WORKS_AT--> Acme'), 'and their relationship, so it can be ended');
});

test('ingest: Latin names match whole words only', () => {
  assert.equal(mentions('bob said hi', 'ai'), false, '"AI" is not in "said"');
  assert.equal(mentions('an ai lab', 'ai'), true);
  assert.equal(mentions('alice在acme工作', 'alice'), true);
  assert.equal(mentions('alice在acme工作', 'acme'), true);
  assert.equal(mentions('malice inc', 'alice'), false);
  assert.equal(mentions('alice2 called', 'alice'), false, 'digits continue a word');
  assert.equal(mentions('阿里巴巴的张三', '张三'), true, 'CJK names match anywhere');
});
