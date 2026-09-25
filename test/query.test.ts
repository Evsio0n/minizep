import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { HashEmbedder, type Embedder } from '../src/provider/interfaces.js';
import { ScriptedLLM, deterministicEmbedder, entity, fact, invalidation } from './helpers.js';
import type { ExtractionResult } from '../src/provider/interfaces.js';

const EMPTY: ExtractionResult = { entities: [], facts: [], invalidations: [] };

/** One scripted extraction per content string. */
function build(script: Record<string, ExtractionResult>, embedder: Embedder = deterministicEmbedder()) {
  const llm = new ScriptedLLM((content) => script[content] ?? EMPTY);
  return new Minizep({ llm, embedder });
}

const PEOPLE: Record<string, ExtractionResult> = {
  'Alice Chen works at Globex': {
    entities: [entity('Alice Chen'), entity('Globex', ['Organization'])],
    facts: [fact('Alice Chen', 'Globex', 'WORKS_AT')],
    invalidations: [],
  },
  'Alice Wong likes tea': {
    entities: [entity('Alice Wong'), entity('Tea', ['Concept'])],
    facts: [fact('Alice Wong', 'Tea', 'LIKES')],
    invalidations: [],
  },
  'Malice Inc is a company': { entities: [entity('Malice Inc', ['Organization'])], facts: [], invalidations: [] },
};

test('query: regression R8 — facts_about resolves a partial name to the best matching entity', async () => {
  const zep = build(PEOPLE);
  for (const content of Object.keys(PEOPLE)) await zep.ingest.addEpisode({ groupId: 'g', content });

  const rows = await zep.factsAbout('Alice', { groupId: 'g' });
  assert.equal(rows.length, 1, 'the partial name finds a fact');
  assert.equal((await zep.factsAbout('Alice Chen', { groupId: 'g' })).length, 1);
  assert.equal((await zep.factsAbout('chen', { groupId: 'g' }))[0]?.sourceName, 'Alice Chen', 'a later word of the name');

  const detailed = await zep.factsAboutDetailed('Alice', { groupId: 'g' });
  assert.equal(detailed.entity?.name, rows[0].sourceName);
  assert.deepEqual(
    detailed.candidates.map((e) => e.name),
    [detailed.entity?.name === 'Alice Chen' ? 'Alice Wong' : 'Alice Chen', 'Malice Inc'],
    'the other plausible matches are reported for disambiguation, prefix matches before substrings',
  );
  assert.deepEqual(await zep.factsAboutDetailed('Nobody', { groupId: 'g' }), { facts: [], candidates: [] });
});

test('query: findEntities ranks exact, then prefix/word-prefix, then substring matches', async () => {
  const zep = build({
    seed: {
      entities: [entity('Ann Lee'), entity('Ann'), entity('Joann'), entity('Annabel'), entity('Bob')],
      facts: [],
      invalidations: [],
    },
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'seed' });
  const names = (await zep.findEntities('ANN', { groupId: 'g' })).map((e) => e.name);
  assert.deepEqual(names, ['Ann', 'Ann Lee', 'Annabel', 'Joann']);
  assert.deepEqual((await zep.findEntities('ann', { groupId: 'g', limit: 2 })).map((e) => e.name), ['Ann', 'Ann Lee']);
  assert.deepEqual(await zep.findEntities('ann', { groupId: 'other' }), []);
});

test('query: findEntities falls back to the nearest name embeddings', async () => {
  // a stand-in for a multilingual model: both spellings land on one vector
  const embedder: Embedder = {
    async embed(text: string) {
      if (/tencent|腾讯/i.test(text)) return [1, 0, 0, 0];
      if (/alibaba/i.test(text)) return [0.6, 0.8, 0, 0];
      return [0, 0, 1, 0];
    },
  };
  const zep = build(
    { seed: { entities: [entity('腾讯', ['Organization']), entity('Alibaba', ['Organization'])], facts: [], invalidations: [] } },
    embedder,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'seed' });
  const names = (await zep.findEntities('Tencent', { groupId: 'g' })).map((e) => e.name);
  assert.deepEqual(names, ['腾讯'], 'cosine 0.6 (Alibaba) is below the 0.75 threshold');
});

test('query: factsAbout lists newest facts first and honours at/asOf/includeHistorical', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const zep = build({
    one: { entities: pair, facts: [{ ...fact('Alice', 'Acme', 'WORKS_AT'), validAt: new Date('2020-01-01') }], invalidations: [] },
    two: { entities: pair, facts: [{ ...fact('Alice', 'Acme', 'LIKES'), validAt: new Date('2023-01-01') }], invalidations: [] },
    three: { entities: [], facts: [], invalidations: [invalidation('Alice', 'Acme', 'WORKS_AT', new Date('2024-01-01'))] },
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'one' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'two' });
  const beforeEnd = new Date();
  await new Promise((r) => setTimeout(r, 5));
  await zep.ingest.addEpisode({ groupId: 'g', content: 'three' });

  const names = async (opts: Parameters<typeof zep.factsAbout>[1]) => (await zep.factsAbout('Alice', { groupId: 'g', ...opts })).map((r) => r.fact.name);
  assert.deepEqual(await names({}), ['LIKES']);
  assert.deepEqual(await names({ includeHistorical: true }), ['LIKES', 'WORKS_AT'], 'newest first');
  assert.deepEqual(await names({ at: new Date('2023-06-01') }), ['LIKES', 'WORKS_AT']);
  assert.deepEqual(await names({ asOf: beforeEnd }), ['LIKES', 'WORKS_AT'], 'before we learned it had ended');
});

test('query: search degrades to keyword ranking when the query cannot be embedded', async () => {
  let up = true;
  const embedder: Embedder = {
    async embed(t: string) {
      if (!up) throw new Error('embeddings API 502');
      return new HashEmbedder(64).embed(t);
    },
  };
  const zep = build(PEOPLE, embedder);
  for (const content of Object.keys(PEOPLE)) await zep.ingest.addEpisode({ groupId: 'g', content });

  const healthy = await zep.searchFactsDetailed('Globex', { groupId: 'g' });
  assert.equal(healthy.degraded, false);

  up = false;
  const degraded = await zep.searchFactsDetailed('Globex', { groupId: 'g' });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.results[0]?.targetName, 'Globex', 'keyword ranking still finds it');
  assert.equal((await zep.searchFacts('Globex', { groupId: 'g' }))[0]?.targetName, 'Globex', 'searchFacts does not throw either');
});

test('query: search results carry their fused score, best first', async () => {
  const zep = build(PEOPLE);
  for (const content of Object.keys(PEOPLE)) await zep.ingest.addEpisode({ groupId: 'g', content });
  const hits = await zep.searchFacts('Alice Chen Globex', { groupId: 'g' });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(typeof h.score, 'number');
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score! >= hits[i].score!);
});

test('query: concurrent searches do not share state', async () => {
  let calls = 0;
  const embedder: Embedder = {
    async embed(t: string) {
      // every other query embedding fails; the flags must not leak across calls
      if (t.startsWith('q') && calls++ % 2 === 1) throw new Error('flaky');
      await new Promise((r) => setTimeout(r, 1));
      return new HashEmbedder(64).embed(t);
    },
  };
  const zep = build(PEOPLE, embedder);
  for (const content of Object.keys(PEOPLE)) await zep.ingest.addEpisode({ groupId: 'g', content });
  const results = await Promise.all(['q Globex', 'q tea', 'q Globex', 'q tea'].map((q) => zep.searchFactsDetailed(q, { groupId: 'g' })));
  assert.deepEqual(results.map((r) => r.degraded), [false, true, false, true]);
});

test('query: searchFacts honours asOf (what the graph knew then)', async () => {
  const zep = build(PEOPLE);
  const before = new Date(Date.now() - 1000);
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen works at Globex' });
  assert.equal((await zep.searchFacts('Globex', { groupId: 'g' })).length, 1);
  assert.equal((await zep.searchFacts('Globex', { groupId: 'g', asOf: before })).length, 0);
  assert.equal((await zep.searchFacts('Globex', { groupId: 'g', asOf: before, includeHistorical: true })).length, 0);
});
