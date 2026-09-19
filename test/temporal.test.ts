import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { isFactActive } from '../src/model/types.js';
import { ScriptedLLM, deterministicEmbedder, entity, fact, invalidation } from './helpers.js';

/** Build a Minizep instance driven by a scripted extraction per content string. */
function build(script: Record<string, ReturnType<typeof scenario>>, contradictions = false) {
  const llm = new ScriptedLLM((content) => script[content] ?? { entities: [], facts: [], invalidations: [] }, contradictions);
  return new Minizep({ llm, embedder: deterministicEmbedder() });
}
function scenario(entities: ReturnType<typeof entity>[], facts: ReturnType<typeof fact>[], invalidations: ReturnType<typeof invalidation>[] = []) {
  return { entities, facts, invalidations };
}

const TODAY = scenario(
  [entity('Alice'), entity('Acme', ['Organization'])],
  [fact('Alice', 'Acme', 'WORKS_AT')],
);

test('temporal: a fresh fact is active and reports no end', async () => {
  const zep = build({ 'alice works at acme': TODAY });
  const { episode } = await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });

  const [row] = await zep.factsAbout('Alice', { groupId: 'g' });
  assert.ok(row, 'fact should exist');
  assert.equal(row.fact.name, 'WORKS_AT');
  assert.equal(row.fact.invalidAt, undefined);
  assert.equal(row.fact.expiredAt, undefined);
  assert.equal(row.fact.validAt?.getTime(), episode.validAt.getTime());
  assert.equal(isFactActive(row.fact), true);
});

test('temporal: an invalidation closes the relation without creating a new edge', async () => {
  const zep = build({
    'alice works at acme': TODAY,
    'alice left acme': scenario(
      [entity('Alice'), entity('Acme', ['Organization'])],
      [],
      [invalidation('Alice', 'Acme', 'WORKS_AT')],
    ),
  });

  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  // the termination must not be modelled as its own relationship
  assert.equal(res.facts.length, 0, 'no LEFT/ENDED edge may be created');
  assert.equal(res.invalidated.length, 1);

  const all = await zep.store.getFacts('g');
  assert.equal(all.length, 1, 'graph still has exactly one edge');

  const closed = all[0];
  assert.ok(closed.expiredAt, 'expiredAt must be set (we no longer believe it)');
  assert.ok(closed.invalidAt, 'invalidAt must be set (it stopped being true)');
  assert.equal(isFactActive(closed), false);
});

test('temporal: invalidated facts are kept for history, not deleted', async () => {
  const zep = build({
    'alice works at acme': TODAY,
    'alice left acme': scenario([], [], [invalidation('Alice', 'Acme', 'WORKS_AT')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  const current = await zep.factsAbout('Alice', { groupId: 'g' });
  assert.equal(current.length, 0, 'no active facts remain');

  const historical = await zep.factsAbout('Alice', { groupId: 'g', includeHistorical: true });
  assert.equal(historical.length, 1, 'the superseded fact is still retrievable');
});

test('temporal: time travel returns what was true at an instant', async () => {
  const past = new Date('2020-01-01T00:00:00Z');
  const zep = build({
    'alice worked at oldco in 2020': scenario(
      [entity('Alice'), entity('OldCo', ['Organization'])],
      [fact('Alice', 'OldCo', 'WORKS_AT', { validAt: past, invalidAt: new Date('2021-01-01T00:00:00Z') })],
    ),
    'alice works at acme': TODAY,
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice worked at oldco in 2020' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });

  const in2020 = await zep.factsAt(new Date('2020-06-01T00:00:00Z'), 'g');
  assert.deepEqual(in2020.map((f) => f.targetName), ['OldCo']);

  const now = await zep.factsAt(new Date(), 'g');
  assert.deepEqual(now.map((f) => f.targetName), ['Acme']);

  const in2025 = await zep.factsAt(new Date('2025-06-01T00:00:00Z'), 'g');
  assert.equal(in2025.length, 0, 'between the two jobs nothing was true');
});

test('temporal: a fact dated in the future is not yet active', async () => {
  const future = new Date(Date.now() + 86_400_000);
  const zep = build({
    'alice will join futureco': scenario(
      [entity('Alice'), entity('FutureCo', ['Organization'])],
      [fact('Alice', 'FutureCo', 'WORKS_AT', { validAt: future })],
    ),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice will join futureco' });

  assert.equal((await zep.factsAbout('Alice', { groupId: 'g' })).length, 0);
  assert.equal((await zep.factsAbout('Alice', { groupId: 'g', includeHistorical: true })).length, 1);
  assert.equal((await zep.factsAt(future, 'g')).length, 1);
});

test('temporal: fact windows are half-open — a fact is inactive at its own invalidAt', async () => {
  const end = new Date('2024-06-01T00:00:00Z');
  const f = {
    validAt: new Date('2024-01-01T00:00:00Z'),
    invalidAt: end,
  } as Parameters<typeof isFactActive>[0];
  assert.equal(isFactActive(f, new Date(end.getTime() - 1)), true);
  assert.equal(isFactActive(f, end), false, 'inactive exactly at invalidAt');
  assert.equal(isFactActive(f, new Date(end.getTime() + 1)), false);
});
