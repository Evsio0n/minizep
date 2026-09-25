import { createHash } from 'node:crypto';

/**
 * Content fingerprint for ingestion idempotency.
 * Normalises whitespace and case so trivially-different re-submissions of the
 * same text are recognised as the same episode.
 */
export function contentHash(content: string): string {
  const normalised = content.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

/**
 * Ingestion idempotency key, stored in the episode's content_hash column.
 *
 * The same text on another day is a new event ("the production database went
 * down" twice is two incidents), so the UTC day of the episode's validAt is part
 * of the key. A caller that knows better passes its own key, which then
 * identifies the episode on its own (content and date no longer matter).
 */
export function idempotencyKey(content: string, validAt: Date, explicitKey?: string): string {
  if (explicitKey) return `key:${createHash('sha256').update(explicitKey).digest('hex').slice(0, 32)}`;
  return `${contentHash(content)}@${validAt.toISOString().slice(0, 10)}`;
}
