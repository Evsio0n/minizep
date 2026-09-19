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
