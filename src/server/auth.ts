/**
 * Bearer-token authentication and memory-group authorisation.
 *
 * `MINIZEP_TOKENS="tokenA:teamA,tokenB:teamB|shared"` maps each token to the
 * groups it may read and write; the first one is its default. Tokens are
 * compared in constant time so a wrong guess cannot be narrowed down by
 * response timing. Tokens of the access store (users, grants and roles) are
 * resolved by access.ts into the same Principal.
 *
 * Every MCP tool and REST endpoint picks its group through resolveGroup():
 * this module is the only place that decides which namespace a caller may
 * touch, and with which role.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** What a caller may do in a group: read < write < manage who has access. */
export type Role = 'reader' | 'writer' | 'owner';
export const ROLES = ['reader', 'writer', 'owner'] as const satisfies readonly Role[];

/** What an operation needs: reads, writes (writer) or member management (owner). */
export type Need = 'read' | 'write' | 'manage';

const RANK: Record<Role, number> = { reader: 1, writer: 2, owner: 3 };
const NEEDED: Record<Need, Role> = { read: 'reader', write: 'writer', manage: 'owner' };

/** A role on the groups a pattern matches: an exact group name, or a prefix ending in "*". */
export interface Grant {
  pattern: string;
  role: Role;
}

/** What a token narrows its user's rights to. */
export interface Restriction {
  /** patterns the token reaches (absent: every group of its user) */
  groups?: readonly string[];
  /** the highest role it acts with (absent: its user's) */
  role?: 'reader' | 'writer';
}

/**
 * Who is calling and what they may touch. `grants === 'any'` is owner of every
 * group: a single trusted local user (stdio, or an HTTP server explicitly run
 * anonymously) or an admin.
 */
export interface Principal {
  /** stable identity of the credential (sessions are bound to it); never the token itself */
  id: string;
  /** the group used when a request names none */
  defaultGroup: string;
  grants: readonly Grant[] | 'any';
  /** may manage users, tokens and every group's members */
  admin: boolean;
  /** the account of an access-store token (absent for env tokens, the UI and local users) */
  user?: string;
  /** the access-store token (tk_...) the request came with */
  tokenId?: string;
  restriction?: Restriction;
}

export type AuthResult =
  | { ok: true; status: 200; principal: Principal }
  | { ok: false; status: number; error: string };

/** A request named a group its token may not use, or may not use for this. */
export class GroupNotPermittedError extends Error {
  readonly status = 403;
  constructor(message = 'group not permitted for this token') {
    super(message);
  }
}

/**
 * Parses "token:group,token2:groupA|groupB". The group list follows the LAST
 * colon (tokens may contain colons); its first entry is the token's default.
 * Malformed entries are rejected loudly, and so is "*" in a group name: an env
 * token holds exactly the groups it lists, never a prefix of them.
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
    if (groups.some((g) => g.includes('*'))) {
      throw new Error(`invalid MINIZEP_TOKENS entry (a group name cannot contain "*"): ${token.slice(0, 6)}…`);
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

/** An env token acts as writer on exactly its groups, the first by default, and is never admin. */
export function envPrincipal(token: string, groups: readonly string[]): Principal {
  return {
    id: tokenId(token),
    defaultGroup: groups[0],
    grants: groups.map((pattern) => ({ pattern, role: 'writer' as const })),
    admin: false,
  };
}

/** The secret of an `Authorization: Bearer <secret>` header, or undefined. */
export function bearerSecret(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : undefined;
}

/** The env token equal to `presented` (every entry is compared, in constant time). */
export function matchEnvToken(presented: string, tokens: Map<string, string[]>): Principal | undefined {
  let found: Principal | undefined;
  for (const [token, groups] of tokens) {
    if (safeEqual(presented, token) && !found) found = envPrincipal(token, groups);
  }
  return found;
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

  const presented = bearerSecret(header);
  if (!presented) return { ok: false, status: 401, error: 'missing bearer token' };
  const principal = matchEnvToken(presented, tokens);
  if (principal) return { ok: true, status: 200, principal };
  return { ok: false, status: 403, error: 'invalid token' };
}

/** Unauthenticated development server: one trusted user, any group, allowed to add users. */
function anonymousPrincipal(): Principal {
  return { id: 'anonymous', defaultGroup: 'default', grants: 'any', admin: true };
}

/** The anonymous (development) caller, which only local, non-browser clients may be. */
export function isAnonymous(p: Principal): boolean {
  return p.id === 'anonymous';
}

/** The single local user of a stdio server: any group, `defaultGroup` by default. */
export function localPrincipal(defaultGroup: string): Principal {
  return { id: 'local', defaultGroup, grants: 'any', admin: true };
}

/** "bob/*" matches "bob/notes" and "bob/x/y", "*" every group, anything else only itself. */
export function matchesPattern(pattern: string, group: string): boolean {
  return pattern.endsWith('*') ? group.startsWith(pattern.slice(0, -1)) : pattern === group;
}

/** The groups both patterns match, as one pattern; undefined when they share none. */
export function intersectPatterns(a: string, b: string): string | undefined {
  const aPrefix = a.endsWith('*');
  const bPrefix = b.endsWith('*');
  if (!aPrefix) return matchesPattern(b, a) ? a : undefined;
  if (!bPrefix) return matchesPattern(a, b) ? b : undefined;
  // two prefixes overlap only when one extends the other: the longer one is the overlap
  if (b.startsWith(a.slice(0, -1))) return b;
  if (a.startsWith(b.slice(0, -1))) return a;
  return undefined;
}

const lower = (a: Role, b: Role | undefined): Role => (b && RANK[b] < RANK[a] ? b : a);
const EVERY_GROUP: readonly Grant[] = [{ pattern: '*', role: 'owner' }];
/** The grants before the token restriction, 'any' as owner on "*". */
const held = (p: Principal): readonly Grant[] => (p.grants === 'any' ? EVERY_GROUP : p.grants);
export const atLeast = (role: Role | undefined, need: Need): boolean => !!role && RANK[role] >= RANK[NEEDED[need]];

/**
 * The caller's role in `group`: the highest of its grants that match, capped
 * by its token's role, and none outside the token's groups.
 */
export function roleIn(p: Principal, group: string): Role | undefined {
  let role: Role | undefined;
  for (const g of held(p)) {
    if (matchesPattern(g.pattern, group) && (!role || RANK[g.role] > RANK[role])) role = g.role;
  }
  if (!role) return undefined;
  const r = p.restriction;
  if (r?.groups && !r.groups.some((pattern) => matchesPattern(pattern, group))) return undefined;
  return lower(role, r?.role);
}

export function permits(p: Principal, group: string, need: Need = 'read'): boolean {
  return atLeast(roleIn(p, group), need);
}

/** The caller may use every group without a token restriction (local user, anonymous mode, admins). */
export function unrestricted(p: Principal): boolean {
  return p.grants === 'any' && !p.restriction?.groups;
}

/**
 * What the caller holds once its token's restriction is applied, as one list
 * ('any' is "*"): the grants /v1/me shows and the instructions name.
 */
export function effectiveGrants(p: Principal): Grant[] {
  const within = p.restriction?.groups;
  const out = new Map<string, Role>();
  for (const g of held(p)) {
    const patterns = within ? within.map((w) => intersectPatterns(g.pattern, w)) : [g.pattern];
    for (const pattern of patterns) {
      if (pattern === undefined) continue;
      const role = lower(g.role, p.restriction?.role);
      const had = out.get(pattern);
      if (!had || RANK[role] > RANK[had]) out.set(pattern, role);
    }
  }
  return [...out].map(([pattern, role]) => ({ pattern, role }));
}

/** Whether the caller may write anywhere (a read-only caller is not offered the write tools). */
export function canWrite(p: Principal): boolean {
  return effectiveGrants(p).some((g) => atLeast(g.role, 'write'));
}

/**
 * The group a request operates on: none (or an empty string) -> the
 * principal's default; a permitted one -> itself. A group the caller cannot
 * read, or a role below `need`, throws GroupNotPermittedError (403). Names
 * are matched exactly, patterns by prefix.
 */
export function resolveGroup(principal: Principal, requested: string | null | undefined, need: Need = 'read'): string {
  const named = requested !== undefined && requested !== null && requested !== '';
  const group = named ? requested : principal.defaultGroup;
  const role = roleIn(principal, group);
  if (!role) throw new GroupNotPermittedError(named ? undefined : 'no default group: pass group_id');
  if (!atLeast(role, need)) {
    throw new GroupNotPermittedError(
      need === 'manage' ? `managing members of "${group}" needs the owner role` : `read-only access to group "${group}"`,
    );
  }
  return group;
}
