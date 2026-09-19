/**
 * Bearer-token authentication with per-token memory namespaces.
 *
 * `MINIZEP_TOKENS="tokenA:teamA,tokenB:teamB"` maps each token to the group it
 * may read and write. Tokens are compared in constant time so a wrong guess
 * cannot be narrowed down by response timing.
 */
import { timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { ok: true; status: 200; group: string }
  | { ok: false; status: number; error: string };

/** Parses "token:group,token2:group2". Malformed entries are rejected loudly. */
export function parseTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  if (!raw) return tokens;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`invalid MINIZEP_TOKENS entry (expected "token:group"): ${trimmed.slice(0, 6)}…`);
    }
    const token = trimmed.slice(0, idx);
    const group = trimmed.slice(idx + 1);
    if (tokens.has(token)) throw new Error('duplicate token in MINIZEP_TOKENS');
    tokens.set(token, group);
  }
  return tokens;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // still compare something of equal length to keep the timing flat
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function authorize(
  header: string | undefined,
  tokens: Map<string, string>,
  allowAnonymous = false,
): AuthResult {
  if (tokens.size === 0) {
    return allowAnonymous
      ? { ok: true, status: 200, group: 'default' }
      : { ok: false, status: 401, error: 'authentication is not configured' };
  }

  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return { ok: false, status: 401, error: 'missing bearer token' };

  const presented = match[1].trim();
  for (const [token, group] of tokens) {
    if (safeEqual(presented, token)) return { ok: true, status: 200, group };
  }
  return { ok: false, status: 403, error: 'invalid token' };
}
