/**
 * Bearer-token authentication and memory-group authorisation.
 *
 * `MINIZEP_TOKENS="tokenA:teamA,tokenB:teamB|shared"` maps each token to the
 * groups it may read and write; the first one is its default. Tokens are
 * compared in constant time so a wrong guess cannot be narrowed down by
 * response timing.
 *
 * Every MCP tool and REST endpoint picks its group through resolveGroup():
 * this module is the only place that decides which namespace a caller may
 * touch.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Who is calling and what they may touch. `groups === 'any'` is for a single
 * trusted local user (stdio, or an HTTP server explicitly run anonymously).
 */
export interface Principal {
  /** stable identity of the credential (sessions are bound to it); never the token itself */
  id: string;
  /** the group used when a request names none */
  defaultGroup: string;
  groups: readonly string[] | 'any';
}

export type AuthResult =
  | { ok: true; status: 200; principal: Principal }
  | { ok: false; status: number; error: string };

/** A request named a group its token may not use. */
export class GroupNotPermittedError extends Error {
  readonly status = 403;
  constructor() {
    super('group not permitted for this token');
  }
}

/**
 * Parses "token:group,token2:groupA|groupB". The group list follows the LAST
 * colon (tokens may contain colons); its first entry is the token's default.
 * Malformed entries are rejected loudly.
 */
export function parseTokens(raw: string | undefined): Map<string, string[]> {
  const tokens = new Map<string, string[]>();
  if (!raw) return tokens;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`invalid MINIZEP_TOKENS entry (expected "token:group"): ${trimmed.slice(0, 6)}…`);
    }
    const token = trimmed.slice(0, idx);
    const groups = trimmed.slice(idx + 1).split('|').map((g) => g.trim());
    if (groups.some((g) => !g)) {
      throw new Error(`invalid MINIZEP_TOKENS entry (empty group name): ${token.slice(0, 6)}…`);
    }
    if (tokens.has(token)) throw new Error('duplicate token in MINIZEP_TOKENS');
    tokens.set(token, [...new Set(groups)]);
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

/** A digest of the token: identifies it without keeping or logging the secret. */
function tokenId(token: string): string {
  return `tok_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

export function authorize(
  header: string | undefined,
  tokens: Map<string, string[]>,
  allowAnonymous = false,
): AuthResult {
  if (tokens.size === 0) {
    return allowAnonymous
      ? { ok: true, status: 200, principal: anonymousPrincipal() }
      : { ok: false, status: 401, error: 'authentication is not configured' };
  }

  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return { ok: false, status: 401, error: 'missing bearer token' };

  const presented = match[1].trim();
  for (const [token, groups] of tokens) {
    if (safeEqual(presented, token)) {
      return { ok: true, status: 200, principal: { id: tokenId(token), defaultGroup: groups[0], groups } };
    }
  }
  return { ok: false, status: 403, error: 'invalid token' };
}

/** Unauthenticated development server: one trusted user, any group. */
function anonymousPrincipal(): Principal {
  return { id: 'anonymous', defaultGroup: 'default', groups: 'any' };
}

/** The single local user of a stdio server: any group, `defaultGroup` by default. */
export function localPrincipal(defaultGroup: string): Principal {
  return { id: 'local', defaultGroup, groups: 'any' };
}

export function permits(principal: Principal, group: string): boolean {
  return principal.groups === 'any' || principal.groups.includes(group);
}

/**
 * The group a request operates on: none (or an empty string) -> the
 * principal's default; a permitted one -> itself; anything else throws
 * GroupNotPermittedError. Names are matched exactly.
 */
export function resolveGroup(principal: Principal, requested: string | null | undefined): string {
  if (requested === undefined || requested === null || requested === '') return principal.defaultGroup;
  if (permits(principal, requested)) return requested;
  throw new GroupNotPermittedError();
}
