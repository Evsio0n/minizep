/**
 * Graph-aware reranking of hybrid-search candidates, shared by the in-memory
 * and the database search paths (after Graphiti's node-distance reranker, but
 * as a bonus on top of the text ranking instead of a replacement for it):
 *
 *   fused score = RRF(keyword rank, vector rank) + proximity bonus
 *
 * where the bonus depends on the fact's graph distance to the entities the
 * query names: 0 when it touches one, 1 when it touches a direct neighbour of
 * one. Then a relevance cut: a candidate with no keyword hit, no proximity and
 * a low cosine is dropped, so an unrelated query can come back empty.
 */
import type { EntityEdge } from '../model/types.js';

/** RRF's k, as in rrfFuseScored: first place in one ranking is worth 1/(k+1). */
export const RRF_K = 60;

/**
 * Proximity bonus by graph distance (index 0 and 1), in RRF terms. An eighth
 * of first place in one ranking, about what separates first place from tenth
 * in one ranking, or from fifth in both: it reorders candidates the text
 * rankings find comparable, and cannot lift a fact they rank low over one
 * they rank high. A neighbour's fact gets half of that.
 *
 * Kept small on purpose. A query often names a hub (the project every
 * component hangs off), and every fact near a hub gets the same lift, so a
 * larger bonus mostly pushes the hub's own facts over the specific ones the
 * question asks about.
 */
const PROXIMITY_BONUS = [0.125 / (RRF_K + 1), 0.0625 / (RRF_K + 1)];

/**
 * Default cosine a candidate needs when nothing else ties it to the query (no
 * keyword hit, no graph proximity). Calibrated on Qwen3-Embedding-0.6B, where
 * a fact on another subject scores 0.15-0.40 against a question and a relevant
 * fact sharing no word with it (other language, paraphrase) 0.40-0.65: the
 * floor removes the clear misses and keeps the paraphrases.
 */
export const DEFAULT_MIN_COSINE = 0.4;

/** One fact a search found, with what each retriever said about it. */
export interface SearchCandidate {
  edge: EntityEdge;
  /** 1-based place in the keyword (BM25) ranking; unset when no query term is in the fact */
  keywordRank?: number;
  /** 1-based place in the vector ranking; unset when the fact was not ranked by vector */
  vectorRank?: number;
  /** cosine between the query and fact vectors; unset without either */
  cosine?: number;
}

/**
 * The neighbours of the entities `anchors`: the other endpoints of the facts
 * in `facts` that touch an anchor. `facts` must be the visible facts (the
 * search's time filter), all of those touching an anchor, so a relationship
 * that ended does not make its entities neighbours.
 */
export function neighboursOf(anchors: ReadonlySet<string>, facts: readonly EntityEdge[]): Set<string> {
  const neighbours = new Set<string>();
  for (const f of facts) {
    const fromSource = anchors.has(f.sourceNodeUuid);
    const fromTarget = anchors.has(f.targetNodeUuid);
    if (fromSource && !fromTarget) neighbours.add(f.targetNodeUuid);
    if (fromTarget && !fromSource) neighbours.add(f.sourceNodeUuid);
  }
  return neighbours;
}

/**
 * Graph distance of each fact in `facts` from the entities `anchors`: 0 for a
 * fact touching an anchor, 1 for a fact touching one of their `neighbours`
 * (neighboursOf). Facts further away are absent. It depends on nothing but
 * each fact's endpoints, so any candidate can be scored, whichever retriever
 * found it.
 */
export function graphDistances(
  anchors: ReadonlySet<string>,
  neighbours: ReadonlySet<string>,
  facts: readonly EntityEdge[],
): Map<string, number> {
  const distance = new Map<string, number>();
  for (const f of facts) {
    if (anchors.has(f.sourceNodeUuid) || anchors.has(f.targetNodeUuid)) distance.set(f.uuid, 0);
    else if (neighbours.has(f.sourceNodeUuid) || neighbours.has(f.targetNodeUuid)) distance.set(f.uuid, 1);
  }
  return distance;
}

/**
 * Fused score for every candidate that passes the relevance cut, best first,
 * at most `limit`. Equal scores go to the most recently learned fact, then by
 * uuid: the backends list candidates in different orders (the database's
 * neighbourhood comes newest first), and that must not change the result.
 */
export function rerank(
  candidates: readonly SearchCandidate[],
  distance: ReadonlyMap<string, number>,
  opts: { limit: number; minCosine: number },
): { edge: EntityEdge; score: number }[] {
  const scored: { edge: EntityEdge; score: number }[] = [];
  for (const c of candidates) {
    const d = distance.get(c.edge.uuid);
    const bonus = d === undefined ? 0 : (PROXIMITY_BONUS[d] ?? 0);
    if (!c.keywordRank && !bonus && !((c.cosine ?? -1) >= opts.minCosine)) continue;
    const score =
      (c.keywordRank ? 1 / (RRF_K + c.keywordRank) : 0) + (c.vectorRank ? 1 / (RRF_K + c.vectorRank) : 0) + bonus;
    scored.push({ edge: c.edge, score });
  }
  return scored.sort((a, b) => b.score - a.score || newestFirst(a.edge, b.edge)).slice(0, opts.limit);
}

/** Most recently learned first, then by uuid (the database's ORDER BY created_at DESC, uuid). */
function newestFirst(a: EntityEdge, b: EntityEdge): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
}
