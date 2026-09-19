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
   * 'processed' once extraction succeeded. An episode whose extraction failed
   * is still persisted (the raw text is the most valuable thing we hold) and
   * marked 'failed' so it can be retried later instead of being lost.
   */
  status?: 'processed' | 'failed';
  /** failure reason when status === 'failed' */
  error?: string;
  /** content fingerprint, used for ingestion idempotency */
  contentHash?: string;
}

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
}

export function isFactActive(fact: EntityEdge, at?: Date): boolean {
  const t = at ?? new Date();
  if (fact.expiredAt && fact.expiredAt <= t) return false;
  if (fact.invalidAt && fact.invalidAt <= t) return false;
  if (fact.validAt && fact.validAt > t) return false;
  return true;
}
