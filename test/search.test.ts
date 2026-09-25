import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { HashEmbedder, type Embedder } from '../src/provider/interfaces.js';
import { bm25Scores, cosineSimilarity, hashEmbed, rrfFuse, tokenize } from '../src/search/retrieval.js';
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

test('tokenize: a CJK run becomes overlapping bigrams, a lone character stays whole', () => {
  // before: the whole sentence was ONE token, so no word inside it could match
  assert.deepEqual(tokenize('张伟在阿里巴巴做高级产品经理'), [
    '张伟', '伟在', '在阿', '阿里', '里巴', '巴巴', '巴做', '做高', '高级', '级产', '产品', '品经', '经理',
  ]);
  assert.deepEqual(tokenize('阿里巴巴'), ['阿里', '里巴', '巴巴']);
  assert.deepEqual(tokenize('猫'), ['猫']);
  // punctuation ends a run: no bigram spans "，"
  assert.deepEqual(tokenize('阿里巴巴，腾讯。'), ['阿里', '里巴', '巴巴', '腾讯']);
});

test('tokenize: mixed Chinese/English splits at script boundaries', () => {
  assert.deepEqual(tokenize('张伟在Google做PM'), ['张伟', '伟在', 'google', '做', 'pm']);
  assert.deepEqual(tokenize('2024年3月入职'), ['2024', '年', '3', '月入', '入职']);
  // full-width Latin and digits (common in CJK text) fold to ASCII
  assert.deepEqual(tokenize('ＧＰＴ４ 发布'), ['gpt4', '发布']);
});

test('tokenize: kana, Hangul and supplementary-plane ideographs are CJK too', () => {
  // the prolonged-sound mark ー belongs to both kana scripts and stays in the run
  assert.deepEqual(tokenize('コーヒーが好き'), ['コー', 'ーヒ', 'ヒー', 'ーが', 'が好', '好き']);
  assert.deepEqual(tokenize('삼성전자'), ['삼성', '성전', '전자']);
  // 𠮷 is a surrogate pair in UTF-16: bigrams are built per code point
  assert.deepEqual(tokenize('𠮷野家'), ['𠮷野', '野家']);
});

test('tokenize: variation selectors and combining marks do not cut a CJK run', () => {
  // an ideographic variation selector picks a glyph variant of the kanji before
  // it; read as punctuation it split the run and lost the bigram across it
  assert.deepEqual(tokenize('葛\u{E0100}城市'), ['葛城', '城市']);
  assert.deepEqual(tokenize('葛\u{E0100}城市在奈良县'), tokenize('葛城市在奈良县'));
  assert.deepEqual(tokenize('神\uFE00戸'), ['神戸']);
  // a combining mark NFKC cannot compose onto its base (Ainu small katakana)
  assert.deepEqual(tokenize('ㇷ\u309Aヌ'), ['ㇷヌ']);
  // marks NFKC can compose stay on their letter
  assert.deepEqual(tokenize('Cafe\u0301'), ['café']);
  assert.ok((bm25Scores('神戸', [{ id: 'kobe', text: '住在神\uFE00戸' }]).get('kobe') ?? 0) > 0);
});

test('bm25: a word inside a Chinese sentence matches (regression: CJK run was one token)', () => {
  const docs = [
    { id: 'zhang', text: '张伟在阿里巴巴做高级产品经理' },
    { id: 'li', text: '李娜在腾讯负责微信支付' },
  ];
  const s = bm25Scores('产品经理', docs);
  assert.ok((s.get('zhang') ?? 0) > 0, 'a word inside the sentence must match');
  assert.equal(s.get('li') ?? 0, 0, 'an unrelated sentence scores zero');
  // the organisation name matches inside the sentence too, not only when it
  // happens to be space-delimited
  assert.ok((bm25Scores('阿里巴巴', docs).get('zhang') ?? 0) > 0);
});

test('bm25: a mixed Chinese/English query matches both scripts', () => {
  const docs = [
    { id: 'chen', text: '陈明在Google做机器学习工程师' },
    { id: 'zhou', text: '周杰在Google做销售' },
    { id: 'wang', text: '王芳在百度做机器学习研究' },
  ];
  const s = bm25Scores('Google 机器学习', docs);
  assert.ok((s.get('zhou') ?? 0) > 0, 'the English term matches on its own');
  assert.ok((s.get('wang') ?? 0) > 0, 'the Chinese term matches on its own');
  assert.ok((s.get('chen') ?? 0) > (s.get('zhou') ?? 0), 'matching both scripts beats matching one');
  assert.ok((s.get('chen') ?? 0) > (s.get('wang') ?? 0), 'matching both scripts beats matching one');
});

test('hashEmbed: a Chinese query lands near the sentence that contains it', () => {
  // hashEmbed shares tokenize(), so CJK text gets overlapping bigrams here too
  const query = hashEmbed('产品经理', 64);
  const containing = cosineSimilarity(query, hashEmbed('张伟在阿里巴巴做高级产品经理', 64));
  const unrelated = cosineSimilarity(query, hashEmbed('王芳喜欢吃四川火锅', 64));
  assert.ok(containing > unrelated, `containing=${containing} unrelated=${unrelated}`);
});

test('search: a Chinese query finds the fact inside a Chinese sentence', async () => {
  const llm = new ScriptedLLM((content) =>
    content.includes('阿里巴巴')
      ? {
          entities: [entity('张伟'), entity('阿里巴巴', ['Organization'])],
          facts: [{ ...fact('张伟', '阿里巴巴', 'WORKS_AT'), fact: content }],
          invalidations: [],
        }
      : {
          entities: [entity('王芳'), entity('四川火锅', ['Concept'])],
          facts: [{ ...fact('王芳', '四川火锅', 'LIKES'), fact: content }],
          invalidations: [],
        },
  );
  const zep = new Minizep({ llm, embedder: new HashEmbedder(64) });
  await zep.ingest.addEpisode({ groupId: 'g', content: '张伟在阿里巴巴做高级产品经理' });
  await zep.ingest.addEpisode({ groupId: 'g', content: '王芳喜欢吃四川火锅' });

  const hits = await zep.searchFacts('产品经理', { groupId: 'g' });
  assert.equal(hits[0]?.fact.fact, '张伟在阿里巴巴做高级产品经理');
  assert.equal((await zep.searchFacts('火锅', { groupId: 'g' }))[0]?.sourceName, '王芳');
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
