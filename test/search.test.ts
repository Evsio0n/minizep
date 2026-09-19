import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { HashEmbedder, type Embedder } from '../src/provider/interfaces.js';
import { bm25Scores, cosineSimilarity, rrfFuse, tokenize } from '../src/search/retrieval.js';
import { ScriptedLLM, entity, fact } from './helpers.js';

/** Records which texts were embedded, to catch query/document space drift. */
class SpyEmbedder implements Embedder {
  readonly seen: string[] = [];
  private inner = new HashEmbedder(64);
  async embed(text: string): Promise<number[]> {
    this.seen.push(text);
    return this.inner.embed(text);
  }
}

test('search: regression — the query is embedded by the SAME embedder as the documents', async () => {
  // The original bug: queries went through a module-level hashEmbedder while
  // facts used the configured embedder, so the two vectors lived in different
  // spaces and cosine scores were noise (0.007 vs 0.687 in the real setup).
  const spy = new SpyEmbedder();
  const llm = new ScriptedLLM(() => ({
    entities: [entity('Alice'), entity('Acme', ['Organization'])],
    facts: [fact('Alice', 'Acme', 'WORKS_AT')],
    invalidations: [],
  }));
  const zep = new Minizep({ llm, embedder: spy });

  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  spy.seen.length = 0; // ignore ingestion-time embeddings

  await zep.searchFacts('where does alice work', { groupId: 'g' });

  assert.ok(spy.seen.includes('where does alice work'), 'the configured embedder must embed the query');
});

test('search: exact fact text ranks its own edge first', async () => {
  const llm = new ScriptedLLM((content) => {
    if (content.includes('bob')) {
      return {
        entities: [entity('Bob'), entity('Pizza', ['Concept'])],
        facts: [fact('Bob', 'Pizza', 'LIKES')],
        invalidations: [],
      };
    }
    return {
      entities: [entity('Alice'), entity('Acme', ['Organization'])],
      facts: [fact('Alice', 'Acme', 'WORKS_AT')],
      invalidations: [],
    };
  });
  const zep = new Minizep({ llm, embedder: new HashEmbedder(64) });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'bob likes pizza' });

  const hits = await zep.searchFacts('Bob LIKES Pizza', { groupId: 'g' });
  assert.equal(hits[0].sourceName, 'Bob');
  assert.equal(hits[0].fact.name, 'LIKES');
});

test('search: results are scoped to the group', async () => {
  const llm = new ScriptedLLM(() => ({
    entities: [entity('Alice'), entity('Acme', ['Organization'])],
    facts: [fact('Alice', 'Acme', 'WORKS_AT')],
    invalidations: [],
  }));
  const zep = new Minizep({ llm, embedder: new HashEmbedder(64) });
  await zep.ingest.addEpisode({ groupId: 'a', content: 'alice works at acme' });

  assert.equal((await zep.searchFacts('alice', { groupId: 'a' })).length, 1);
  assert.equal((await zep.searchFacts('alice', { groupId: 'b' })).length, 0);
});

test('search: historical facts stay out of default results but are reachable', async () => {
  const llm = new ScriptedLLM((content) =>
    content.includes('left')
      ? { entities: [], facts: [], invalidations: [{ sourceName: 'Alice', targetName: 'Acme', relation: 'WORKS_AT' }] }
      : {
          entities: [entity('Alice'), entity('Acme', ['Organization'])],
          facts: [fact('Alice', 'Acme', 'WORKS_AT')],
          invalidations: [],
        },
  );
  const zep = new Minizep({ llm, embedder: new HashEmbedder(64) });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  const current = await zep.searchFacts('alice acme', { groupId: 'g' });
  assert.equal(current.length, 0);

  const withHistory = await zep.searchFacts('alice acme', { groupId: 'g', includeHistorical: true });
  assert.equal(withHistory.length, 1);
});

test('bm25: rarer terms weigh more and matching docs outrank non-matching ones', () => {
  const docs = [
    { id: 'a', text: 'Alice works at Acme' },
    { id: 'b', text: 'Bob works at Globex' },
    { id: 'c', text: 'Alice likes tea' },
  ];
  const scores = bm25Scores('Alice Acme', docs);
  assert.ok((scores.get('a') ?? 0) > 0, 'matching doc scores');
  assert.equal(scores.get('b') ?? 0, 0, 'unrelated doc scores zero');
  assert.ok((scores.get('a') ?? 0) > (scores.get('c') ?? 0), 'two-term match beats one-term match');
});

test('bm25: tokenisation is case- and punctuation-insensitive', () => {
  assert.deepEqual(tokenize('Alice, WORKS-at Acme!'), ['alice', 'works', 'at', 'acme']);
});

test('rrf: agreement between rankings outranks a single strong ranking', () => {
  // "b" is 2nd in both lists; "a" is 1st in one list only
  const fused = rrfFuse([
    ['a', 'b'],
    ['c', 'b'],
  ]);
  assert.equal(fused[0], 'b', 'the item both retrievers agree on wins');
});

test('cosine: identical vectors score 1, orthogonal score 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([0, 0, 0], [1, 0, 0]), 0, 'zero vector is handled');
});

test('cosine: mismatched dimensions are compared over the overlap, not silently 0', () => {
  // documents the failure mode that hid the original bug: a 2-dim query against
  // a 3-dim vector still returns a number, so the mismatch is invisible
  const score = cosineSimilarity([1, 0, 0], [1, 0]);
  assert.equal(score, 1);
});
