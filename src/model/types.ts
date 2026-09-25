/**
 * Core data model — mirrors Graphiti's layered memory design.
 *
 * L0  Episode   : raw ingested data (provenance; everything traces back here)
 * L1  Entity    : extracted people/concepts/objects with evolving summaries
 * L1  Fact(edge): entity->entity relation with a temporal validity window
 */

export type UUID = string;

export function uuid(): UUID {
  return (globalThis as { crypto?: { randomUUID(): string } }).crypto?.randomUUID() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** L0 — raw data. Everything extracted later traces back to episodes. */
export interface EpisodicNode {
  readonly type: 'episode';
  uuid: UUID;
  groupId: string;
  name: string;
  /** where this episode came from: text message, json, markdown... */
  source: 'text' | 'json' | 'markdown';
  sourceDescription: string;
  content: string;
  /** when the episode happened in the real world */
  validAt: Date;
  createdAt: Date;
  /**
   * Lifecycle: saved as 'pending', then 'processed' once every entity and
   * fact it produced has been written, or 'failed' when anything went wrong
   * (the raw text is the most valuable thing we hold, so it is kept and can be
   * retried in place). Undefined only on records written by older versions,
   * which never persisted the final status; they are treated as processed.
   */
  status?: EpisodeStatus;
  /** failure reason when status === 'failed' */
  error?: string;
  /**
   * Idempotency key: content fingerprint plus the UTC day of validAt, or the
   * caller's explicit key. Stored in the content_hash column.
   */
  contentHash?: string;
}

export type EpisodeStatus = 'pending' | 'processed' | 'failed';

/** L1 — an extracted entity. */
export interface EntityNode {
  readonly type: 'entity';
  uuid: UUID;
  groupId: string;
  name: string;
  labels: string[];
  summary: string;
  nameEmbedding?: number[];
  attributes: Record<string, unknown>;
  createdAt: Date;
}

/**
 * L1 — a fact: a directed edge between two entities.
 * The soul of the temporal graph: facts are *invalidated, never deleted*.
 */
export interface EntityEdge {
  readonly type: 'fact';
  uuid: UUID;
  groupId: string;
  sourceNodeUuid: UUID;
  targetNodeUuid: UUID;
  /** relation name, e.g. "WORKS_AT" */
  name: string;
  /** human-readable fact sentence */
  fact: string;
  factEmbedding?: number[];
  /** episodes this fact was extracted from (provenance) */
  episodes: UUID[];
  /** when the fact became true in the real world */
  validAt?: Date;
  /** when the fact stopped being true in the real world */
  invalidAt?: Date;
  /** when our system learned the fact */
  createdAt: Date;
  /** when our system invalidated the fact (bi-temporal: differs from invalidAt) */
  expiredAt?: Date;
  attributes: Record<string, unknown>;
}

/** A fact plus its resolved endpoints — what search/UI layers consume. */
export interface FactWithContext {
  fact: EntityEdge;
  sourceName: string;
  targetName: string;
  /** fused retrieval score (RRF), present on search results */
  score?: number;
}

/**
 * Bi-temporal validity: was `fact` true at valid time `at`, according to what
 * the system knew at knowledge time `asOf`? Both default to now.
 *
 *   known      = createdAt <= asOf
 *   endKnownAt = expiredAt ?? (invalidAt ? createdAt : undefined)
 *   ended      = invalidAt && endKnownAt <= asOf && invalidAt <= at
 *   active     = known && !(validAt > at) && !ended
 *
 * With asOf = now this is pure valid-time semantics: an end scheduled in the
 * future keeps the fact active until then. A fact expired without any valid
 * time end was retracted as a whole, so it is ended at every `at` once the
 * retraction is known. PostgresStore's temporalPredicate mirrors this exactly.
 */
export function isFactActive(fact: EntityEdge, at?: Date, asOf?: Date): boolean {
  const t = at ?? new Date();
  const known = asOf ?? new Date();
  // records built without createdAt (tests, hand-made objects) count as known forever
  if (fact.createdAt && fact.createdAt > known) return false;
  if (fact.validAt && fact.validAt > t) return false;
  if (fact.invalidAt) {
    const endKnownAt = fact.expiredAt ?? fact.createdAt;
    if (fact.invalidAt <= t && (!endKnownAt || endKnownAt <= known)) return false;
  } else if (fact.expiredAt && fact.expiredAt <= known) {
    return false;
  }
  return true;
}

/** Did the system know about `fact` at knowledge time `asOf` (default: always)? */
export function isFactKnown(fact: EntityEdge, asOf?: Date): boolean {
  return !asOf || !fact.createdAt || fact.createdAt <= asOf;
}
