/**
 * Zero-dependency hybrid retrieval, mirroring Graphiti's search stack:
 *   BM25 keyword search + cosine vector search, fused with RRF,
 *   plus a temporal filter ("what was true at time T").
 */

/**
 * Scripts written without spaces between words (Han, kana) plus Hangul.
 * Script_Extensions rather than Script so marks shared by several scripts,
 * like the kana prolonged-sound mark in "コーヒー", stay inside their word.
 */
const CJK = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}';
const CJK_CHAR = new RegExp(`[${CJK}]`, 'u');
const SCRIPT_RUNS = new RegExp(`[${CJK}]+|[^${CJK}]+`, 'gu');

/**
 * Keyword tokens for BM25, Postgres full-text search and hashEmbed.
 *
 * Latin/digit words split on whitespace and punctuation. A CJK run has no
 * word boundaries, so it becomes its overlapping character bigrams
 * ("阿里巴巴" -> 阿里 里巴 巴巴); a one-character run stays as it is. Queries
 * and documents go through this same function, so matching stays symmetric.
 * NFKC folds the full-width letters and digits common in CJK text ("ＧＰＴ４")
 * into their ASCII forms. Combining marks NFKC could not compose, including
 * the variation selectors that pick a glyph variant of a kanji (葛 + U+E0100),
 * are dropped rather than treated as punctuation: as a space they would cut a
 * CJK run in two and lose the bigram across them.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/);
  for (const word of words) {
    // one word can mix scripts ("在google做pm"): handle each run on its own
    for (const run of word.match(SCRIPT_RUNS) ?? []) {
      if (CJK_CHAR.test(run)) tokens.push(...bigrams(run));
      else tokens.push(run);
    }
  }
  return tokens;
}

/** True for tokens made of CJK characters (a lone one is still a word). */
export function isCjkToken(token: string): boolean {
  return CJK_CHAR.test(token);
}

function bigrams(run: string): string[] {
  // by code point: CJK extension ideographs are surrogate pairs in UTF-16
  const chars = [...run];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/* ---------------- BM25 ---------------- */

export interface Bm25Doc {
  id: string;
  text: string;
}

export function bm25Scores(query: string, docs: Bm25Doc[], k1 = 1.2, b = 0.75): Map<string, number> {
  return bm25TermScores(
    tokenize(query),
    docs.map((d) => ({ id: d.id, terms: tokenize(d.text) })),
    { k1, b },
  );
}

/** Size and mean length (in tokens) of the collection BM25 scores against. */
export interface Bm25Corpus {
  size: number;
  avgLength: number;
}

/**
 * BM25 over already-tokenized documents. By default `docs` is the whole
 * collection. A caller that only holds the documents matching some query term
 * (a database pre-filter) passes the full collection's `corpus` statistics;
 * document frequencies still come from `docs`, which is exact because a
 * document without any query term adds nothing to them.
 */
export function bm25TermScores(
  qTerms: string[],
  docs: Array<{ id: string; terms: string[] }>,
  opts: { k1?: number; b?: number; corpus?: Bm25Corpus } = {},
): Map<string, number> {
  const { k1 = 1.2, b = 0.75, corpus } = opts;
  const scores = new Map<string, number>();
  if (docs.length === 0) return scores;
  const N = Math.max(corpus?.size ?? 0, docs.length);
  const ownAvg = docs.reduce((s, d) => s + d.terms.length, 0) / docs.length;
  const avgLen = corpus && corpus.avgLength > 0 ? corpus.avgLength : ownAvg;

  // document frequency per query term
  const df = new Map<string, number>();
  for (const term of qTerms) {
    df.set(term, docs.filter((d) => d.terms.includes(term)).length);
  }

  docs.forEach((doc) => {
    const terms = doc.terms;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * terms.length) / avgLen));
    }
    scores.set(doc.id, score);
  });
  return scores;
}

/* ---------------- vectors ---------------- */

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic fallback embedder (hashed bag-of-words projection).
 * No network, no model — good enough to prove the pipeline; swap for a
 * real embedder via the Embedder interface.
 */
export function hashEmbed(text: string, dims = 256): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const term of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < term.length; i++) {
      h ^= term.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    const sign = (h >>> 31) % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/* ---------------- RRF fusion ---------------- */

/** Reciprocal Rank Fusion: rank-based, score-scale agnostic. */
export function rrfFuse(rankings: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
