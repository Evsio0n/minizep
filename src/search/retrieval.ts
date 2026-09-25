/**
 * Zero-dependency hybrid retrieval, mirroring Graphiti's search stack:
 *   BM25 keyword search + cosine vector search, fused with RRF,
 *   plus a temporal filter ("what was true at time T").
 */

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/* ---------------- BM25 ---------------- */

export interface Bm25Doc {
  id: string;
  text: string;
}

export function bm25Scores(query: string, docs: Bm25Doc[], k1 = 1.2, b = 0.75): Map<string, number> {
  const qTerms = tokenize(query);
  const N = docs.length;
  const scores = new Map<string, number>();
  if (N === 0) return scores;

  const docTerms = docs.map((d) => tokenize(d.text));
  const avgLen = docTerms.reduce((s, t) => s + t.length, 0) / N;

  // document frequency per query term
  const df = new Map<string, number>();
  for (const term of qTerms) {
    df.set(term, docTerms.filter((terms) => terms.includes(term)).length);
  }

  docs.forEach((doc, i) => {
    const terms = docTerms[i];
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
  return rrfFuseScored(rankings, k).map((r) => r.id);
}

/** RRF keeping the fused score, best first (exposed on search results). */
export function rrfFuseScored(rankings: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
}
