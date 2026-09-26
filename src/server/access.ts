/**
 * Users, roles and per-group access (docs/ACCESS.md).
 *
 * A user holds grants, (pattern, role) rows: its role in a group is the
 * highest among the grants that match it. An admin is owner everywhere and
 * manages users. Each API token belongs to one user and may narrow its rights
 * (some groups only, a role cap). This class turns a presented secret or a UI
 * session into a Principal, and serves the endpoints that manage all of this
 * within the caller's own rights. MINIZEP_TOKENS keeps working beside it:
 * those tokens are checked first and never reach the store.
 *
 * Principals of store tokens are cached for 30 s, so a change made elsewhere
 * (the CLI, another server) applies within that time; the changes made
 * through this class apply at once.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ROLES,
  authorize,
  bearerSecret,
  effectiveGrants,
  intersectPatterns,
  matchEnvToken,
  envPrincipal,
  resolveGroup,
  roleIn,
  type AuthResult,
  type Principal,
} from './auth.js';
import { ServiceError } from './service.js';
import { sha256, type AccessStore, type GrantRecord, type NewToken, type TokenRecord, type UserRecord } from '../store/access-store.js';

/** How long a store token's principal is reused before the store is asked again. */
const CACHE_MS = 30_000;
/** last_used_at is written at most this often per token. */
const TOUCH_EVERY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/* ---------------- input shapes (REST and the CLI) ---------------- */

const userName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'a user name is 1-64 of a-z, 0-9, ".", "_", "-", starting with a letter or digit');
const groupName = z.string().min(1).max(256).refine((g) => !g.includes('*'), 'a group name cannot contain "*"');
const pattern = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^*]*\*?$/, 'a pattern is a group name, or a prefix ending in "*"');
const role = z.enum(ROLES);
const tokenOptions = {
  name: z.string().max(100).optional(),
  groups: z.array(pattern).min(1).max(100).optional(),
  role: z.enum(['reader', 'writer']).optional(),
  default_group: groupName.optional(),
  expires_days: z.number().int().min(1).max(3650).optional(),
};

export const accessShapes = {
  login: { token: z.string().min(1).max(512) },
  myToken: { ...tokenOptions, name: z.string().min(1).max(100) },
  token: tokenOptions,
  member: { user: userName, role },
  removeMember: { user: userName },
  createUser: {
    name: userName,
    admin: z.boolean().optional(),
    default_group: groupName.optional(),
    workspace: z.boolean().optional(),
  },
  updateUser: { admin: z.boolean().optional(), disabled: z.boolean().optional(), default_group: groupName.optional() },
  grant: { user: userName, pattern, role },
  revokeGrant: { user: userName, pattern },
};

type Input<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export type TokenInput = Input<typeof accessShapes.token>;
export type CreateUserInput = Input<typeof accessShapes.createUser>;

/* ---------------- rows (snake_case, ISO dates; never a secret) ---------------- */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function userRow(u: UserRecord) {
  return {
    name: u.name,
    admin: u.admin,
    disabled: u.disabled,
    default_group: u.defaultGroup,
    created_at: u.createdAt.toISOString(),
  };
}

export function grantRow(g: GrantRecord) {
  return { user: g.user, pattern: g.pattern, role: g.role, created_at: g.createdAt.toISOString() };
}

export function tokenRow(t: TokenRecord) {
  return {
    id: t.id,
    user: t.user,
    name: t.name,
    prefix: t.prefix,
    groups: t.groups,
    role: t.role,
    default_group: t.defaultGroup,
    created_at: t.createdAt.toISOString(),
    expires_at: iso(t.expiresAt),
    last_used_at: iso(t.lastUsedAt),
    revoked_at: iso(t.revokedAt),
  };
}

/* ---------------- the access control ---------------- */

export interface AccessOptions {
  store: AccessStore;
  /** MINIZEP_TOKENS (see auth.parseTokens) */
  tokens?: Map<string, string[]>;
  /** with no env token and no user, serve everyone as one trusted user (local development only) */
  allowAnonymous?: boolean;
  log?: (...args: unknown[]) => void;
  /** clock, for tests */
  now?: () => number;
}

interface Cached {
  principal: Principal;
  until: number;
}

export class AccessControl {
  readonly store: AccessStore;
  private readonly tokens: Map<string, string[]>;
  private readonly allowAnonymous: boolean;
  private readonly log: (...args: unknown[]) => void;
  private readonly now: () => number;
  /** env-token principals by id, which is all their UI sessions keep */
  private readonly envById = new Map<string, Principal>();
  /** store-token principals by secret hash, and by token id (UI sessions) */
  private readonly bySecret = new Map<string, Cached>();
  private readonly byTokenId = new Map<string, Cached>();
  /** bumped by every change: a lookup that started before it must not fill the cache */
  private generation = 0;
  private readonly touched = new Map<string, number>();
  /** UI sessions of env tokens, which have no row to reference: lost at restart */
  private readonly envSessions = new Map<string, { principalId: string; expiresAt: number }>();
  private usersSeen = false;
  private usersCheckedAt = -Infinity;

  constructor(opts: AccessOptions) {
    this.store = opts.store;
    this.tokens = opts.tokens ?? new Map();
    this.allowAnonymous = opts.allowAnonymous ?? false;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    for (const [token, groups] of this.tokens) {
      const p = envPrincipal(token, groups);
      this.envById.set(p.id, p);
    }
  }

  /* ---------- authentication ---------- */

  /**
   * The caller of a request with this Authorization header. With no env token
   * and no user it is today's rule: anonymous when allowed, else 401.
   */
  async authenticate(header: string | undefined): Promise<AuthResult> {
    if (this.tokens.size === 0 && !(await this.hasUsers())) return authorize(header, this.tokens, this.allowAnonymous);
    const secret = bearerSecret(header);
    if (!secret) return { ok: false, status: 401, error: 'missing bearer token' };
    const principal = await this.principalFor(secret);
    return principal ? { ok: true, status: 200, principal } : { ok: false, status: 403, error: 'invalid token' };
  }

  /**
   * An env token, else a store token that is neither revoked nor expired, of
   * a user that is not disabled. Anything else is undefined, whatever the reason.
   */
  async principalFor(secret: string): Promise<Principal | undefined> {
    const env = matchEnvToken(secret, this.tokens);
    if (env) return env;
    if (!secret.startsWith('mz_')) return undefined; // not a store token: spare the lookup
    const hash = sha256(secret);
    return this.cached(this.bySecret, hash, () => this.store.findTokenBySecretHash(hash));
  }

  /**
   * Whether the store has a user: then a request without a token is refused,
   * even in anonymous mode. Asked again every 30 s until one exists.
   */
  async hasUsers(): Promise<boolean> {
    const now = this.now();
    if (!this.usersSeen && now - this.usersCheckedAt >= CACHE_MS) {
      this.usersCheckedAt = now;
      this.usersSeen = (await this.store.countUsers()) > 0;
    }
    return this.usersSeen;
  }

  /** Forget every cached principal: the next request of each token reads the store. */
  invalidate(): void {
    this.generation++;
    this.bySecret.clear();
    this.byTokenId.clear();
  }

  private async cached(
    cache: Map<string, Cached>,
    key: string,
    load: () => Promise<TokenRecord | undefined>,
  ): Promise<Principal | undefined> {
    const now = this.now();
    let hit = cache.get(key);
    if (!hit || hit.until <= now) {
      cache.delete(key);
      const generation = this.generation;
      const token = await load();
      const principal = token && (await this.resolve(token, now));
      if (!principal) return undefined;
      hit = { principal, until: Math.min(now + CACHE_MS, token.expiresAt?.getTime() ?? Infinity) };
      if (generation === this.generation) cache.set(key, hit);
    }
    this.touch(hit.principal.id, now);
    return hit.principal;
  }

  private async resolve(token: TokenRecord, now: number): Promise<Principal | undefined> {
    if (token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= now)) return undefined;
    const user = await this.store.getUser(token.user);
    if (!user || user.disabled) return undefined;
    const grants = await this.grantsOf(user);
    const restricted = token.groups !== null || token.role !== null;
    return {
      id: token.id,
      defaultGroup: token.defaultGroup ?? user.defaultGroup,
      grants,
      // a narrowed token of an admin is not an admin: it could otherwise lift its own limits
      admin: user.admin && !restricted,
      user: user.name,
      tokenId: token.id,
      ...(restricted && {
        restriction: { ...(token.groups && { groups: token.groups }), ...(token.role && { role: token.role }) },
      }),
    };
  }

  /** last_used_at, at most once per 5 minutes per token, without holding up the request. */
  private touch(id: string, now: number): void {
    if (now - (this.touched.get(id) ?? -Infinity) < TOUCH_EVERY_MS) return;
    this.touched.set(id, now);
    this.store.touchToken(id, new Date(now)).catch((err) => this.log(`recording the use of ${id} failed:`, (err as Error).message));
  }

  /* ---------- web UI sessions ---------- */

  /** Log in with a token: the session id for the cookie; undefined for a wrong token. */
  async login(secret: string, ttlMs: number): Promise<{ principal: Principal; sid: string; expiresAt: Date } | undefined> {
    const principal = await this.principalFor(secret);
    if (!principal) return undefined;
    const sid = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now + ttlMs);
    if (principal.tokenId) {
      await this.store.createUiSession(sha256(sid), principal.tokenId, expiresAt);
      this.store.purgeUiSessions(new Date(now)).catch((err) => this.log('purging UI sessions failed:', (err as Error).message));
    } else {
      for (const [k, s] of this.envSessions) if (s.expiresAt <= now) this.envSessions.delete(k);
      this.envSessions.set(sha256(sid), { principalId: principal.id, expiresAt: expiresAt.getTime() });
    }
    return { principal, sid, expiresAt };
  }

  /** The caller of a UI session, resolved again from its token: revocations and grant changes apply. */
  async sessionPrincipal(sid: string | undefined): Promise<Principal | undefined> {
    if (!sid) return undefined;
    const hash = sha256(sid);
    const now = this.now();
    const env = this.envSessions.get(hash);
    if (env) return env.expiresAt > now ? this.envById.get(env.principalId) : undefined;
    const session = await this.store.getUiSession(hash);
    if (!session || session.expiresAt.getTime() <= now) return undefined;
    return this.cached(this.byTokenId, session.tokenId, () => this.store.getToken(session.tokenId));
  }

  async logout(sid: string | undefined): Promise<void> {
    if (!sid) return;
    const hash = sha256(sid);
    this.envSessions.delete(hash);
    await this.store.deleteUiSession(hash);
  }

  /* ---------- the caller itself ---------- */

  /** GET /v1/me: who the caller is and what it may do (its grants as narrowed by its token). */
  async me(p: Principal) {
    const [user, token] = await Promise.all([
      p.user ? this.store.getUser(p.user) : undefined,
      p.tokenId ? this.store.getToken(p.tokenId) : undefined,
    ]);
    const env = this.envById.get(p.id);
    const tokenInfo = token
      ? { id: token.id, name: token.name, groups: token.groups, role: token.role, expires_at: iso(token.expiresAt) }
      : env
        ? { id: env.id, name: null, groups: effectiveGrants(env).map((g) => g.pattern), role: 'writer', expires_at: null }
        : null;
    return {
      user: user ? userRow(user) : null,
      admin: p.admin,
      default_group: p.defaultGroup,
      token: tokenInfo,
      grants: effectiveGrants(p),
    };
  }

  /** The caller's user name: only an account has tokens. */
  private account(p: Principal): string {
    if (!p.user) throw new ServiceError(403, 'only a user account has tokens (this token belongs to none)');
    return p.user;
  }

  async myTokens(p: Principal) {
    return { tokens: (await this.store.listTokens({ user: this.account(p) })).map(tokenRow) };
  }

  /**
   * A new token of the caller's user that can never do more than the calling
   * token: its groups, role cap and expiry are intersected with the caller's.
   */
  async createMyToken(p: Principal, input: Input<typeof accessShapes.myToken>) {
    const user = this.account(p);
    const own = p.tokenId ? await this.store.getToken(p.tokenId) : undefined;
    const reach = p.restriction?.groups;
    let groups = input.groups ?? (reach ? [...reach] : null);
    if (groups && reach) {
      groups = [...new Set(groups.flatMap((a) => reach.map((b) => intersectPatterns(a, b))))].filter(
        (g): g is string => g !== undefined,
      );
      if (groups.length === 0) throw new ServiceError(403, 'none of these groups is within reach of this token');
    }
    const cap = p.restriction?.role;
    const role = cap === 'reader' || input.role === 'reader' ? 'reader' : (input.role ?? cap ?? null);
    const asked = this.expiry(input.expires_days);
    const until = own?.expiresAt ?? null;
    const expiresAt = asked && until ? (asked < until ? asked : until) : (asked ?? until);
    const defaultGroup = await this.defaultWithin(await this.existingUser(user), groups, input.default_group ?? null);
    return this.issue({ user, name: input.name, groups, role, defaultGroup, expiresAt });
  }

  async revokeMyToken(p: Principal, id: string) {
    const token = await this.store.getToken(id);
    // another user's token is indistinguishable from a missing one
    if (!token || token.user !== this.account(p)) throw new ServiceError(404, 'token not found');
    return this.revoke(id);
  }

  /* ---------- group owners ---------- */

  /** GET /v1/groups/:g/members: every grant that reaches `group` (exact or by pattern). */
  async members(p: Principal, group: string) {
    ownedGroup(p, group);
    return { group_id: group, members: (await this.store.listGrants({ group })).map(grantRow) };
  }

  /** Upsert the exact grant (user, group, role). */
  async setMember(p: Principal, group: string, input: Input<typeof accessShapes.member>) {
    ownedGroup(p, group);
    notSelf(p, input.user);
    await this.existingUser(input.user);
    const grant = await this.store.setGrant(input.user, group, input.role);
    this.invalidate();
    return { grant: grantRow(grant) };
  }

  /** Remove the exact grant (user, group); grants by pattern stay (they are listed by members()). */
  async removeMember(p: Principal, group: string, input: Input<typeof accessShapes.removeMember>) {
    ownedGroup(p, group);
    notSelf(p, input.user);
    if (!(await this.store.removeGrant(input.user, group))) {
      throw new ServiceError(404, `user "${input.user}" has no grant on "${group}"`);
    }
    this.invalidate();
    return { removed: true };
  }

  /* ---------- admins ---------- */

  async listUsers(p: Principal) {
    requireAdmin(p);
    const [users, grants, tokens] = await Promise.all([this.store.listUsers(), this.store.listGrants(), this.store.listTokens()]);
    return {
      users: users.map((u) => ({
        ...userRow(u),
        grants: grants.filter((g) => g.user === u.name).map(({ pattern, role, createdAt }) => ({ pattern, role, created_at: createdAt.toISOString() })),
        tokens: tokens.filter((t) => t.user === u.name).map(tokenRow),
      })),
    };
  }

  /**
   * A user with default group `default_group` (else `name`), by default with
   * its workspace there (owner of that group and of its sub-groups, `group/*`),
   * and a first token with all of its rights.
   */
  async createUser(p: Principal, input: CreateUserInput) {
    requireAdmin(p);
    const name = input.name;
    const home = input.default_group ?? name;
    const user = await this.store.createUser({
      name,
      admin: input.admin ?? false,
      disabled: false,
      defaultGroup: home,
    });
    if (!user) throw new ServiceError(409, `user "${name}" already exists`);
    this.usersSeen = true;
    const grants =
      input.workspace === false
        ? []
        : [await this.store.setGrant(name, home, 'owner'), await this.store.setGrant(name, `${home}/*`, 'owner')];
    const first = await this.issue({ user: name, name: 'first token', groups: null, role: null, defaultGroup: null, expiresAt: null });
    return { user: userRow(user), grants: grants.map(grantRow), ...first };
  }

  async updateUser(p: Principal, name: string, input: Input<typeof accessShapes.updateUser>) {
    requireAdmin(p);
    const user = await this.store.updateUser(name, {
      admin: input.admin,
      disabled: input.disabled,
      defaultGroup: input.default_group,
    });
    if (!user) throw new ServiceError(404, `no user "${name}"`);
    this.invalidate();
    return { user: userRow(user) };
  }

  async createToken(p: Principal, name: string, input: TokenInput) {
    requireAdmin(p);
    const user = await this.existingUser(name);
    const groups = input.groups ?? null;
    return this.issue({
      user: name,
      name: input.name ?? '',
      groups,
      role: input.role ?? null,
      defaultGroup: await this.defaultWithin(user, groups, input.default_group ?? null),
      expiresAt: this.expiry(input.expires_days),
    });
  }

  async listTokens(p: Principal, filter: { user?: string } = {}) {
    requireAdmin(p);
    return { tokens: (await this.store.listTokens(filter)).map(tokenRow) };
  }

  async revokeToken(p: Principal, id: string) {
    requireAdmin(p);
    return this.revoke(id);
  }

  async listGrants(p: Principal, filter: { user?: string; group?: string } = {}) {
    requireAdmin(p);
    return { grants: (await this.store.listGrants(filter)).map(grantRow) };
  }

  async setGrant(p: Principal, input: Input<typeof accessShapes.grant>) {
    requireAdmin(p);
    await this.existingUser(input.user);
    const grant = await this.store.setGrant(input.user, input.pattern, input.role);
    this.invalidate();
    return { grant: grantRow(grant) };
  }

  async removeGrant(p: Principal, input: Input<typeof accessShapes.revokeGrant>) {
    requireAdmin(p);
    if (!(await this.store.removeGrant(input.user, input.pattern))) {
      throw new ServiceError(404, `user "${input.user}" has no grant "${input.pattern}"`);
    }
    this.invalidate();
    return { removed: true };
  }

  /* ---------- helpers ---------- */

  /** What a user's tokens start from: its grants, 'any' for an admin. */
  private async grantsOf(user: UserRecord): Promise<Principal['grants']> {
    return user.admin ? 'any' : (await this.store.listGrants({ user: user.name })).map(({ pattern, role }) => ({ pattern, role }));
  }

  /**
   * The default group of a new token of `user` within `groups`, checked
   * against what the token could use (its user's grants, narrowed): one that
   * reaches no group, or an explicit default it cannot read, is refused (400).
   * Without an explicit one, a narrowed token that cannot read its user's
   * default gets the first exact group of `groups` it can read, else none
   * (calls then pass group_id). Checked here only: later grant changes are not.
   */
  private async defaultWithin(user: UserRecord, groups: string[] | null, asked: string | null): Promise<string | null> {
    const grants = await this.grantsOf(user);
    const restriction = groups ? { groups } : undefined;
    const token: Principal = { id: 'new', defaultGroup: user.defaultGroup, grants, admin: false, restriction };
    if (effectiveGrants(token).length === 0) {
      // only a user's own grants can miss: 'any' meets every pattern
      const held = grants === 'any' ? '*' : grants.map((g) => g.pattern).join(', ') || 'none';
      throw new ServiceError(400, `this token would reach none of the groups of "${user.name}" (their grants: ${held})`);
    }
    if (asked !== null) {
      if (!roleIn(token, asked)) throw new ServiceError(400, `default group "${asked}" is outside this token's reach`);
      return asked;
    }
    if (!groups || roleIn(token, user.defaultGroup)) return null;
    return groups.find((g) => !g.includes('*') && roleIn(token, g)) ?? null;
  }

  /** The secret is in this answer only. */
  private async issue(t: NewToken) {
    const { secret, token } = await this.store.createToken(t);
    return { token: secret, record: tokenRow(token) };
  }

  private async revoke(id: string) {
    const token = await this.store.revokeToken(id, new Date(this.now()));
    if (!token) throw new ServiceError(404, 'token not found');
    this.invalidate();
    return { record: tokenRow(token) };
  }

  private expiry(days: number | undefined): Date | null {
    return days === undefined ? null : new Date(this.now() + days * DAY_MS);
  }

  private async existingUser(name: string): Promise<UserRecord> {
    const user = await this.store.getUser(name);
    if (!user) throw new ServiceError(404, `no user "${name}"`);
    return user;
  }
}

function requireAdmin(p: Principal): void {
  if (!p.admin) throw new ServiceError(403, 'admin rights required');
}

/** Member management needs the owner role on the group itself (a name, not a pattern). */
function ownedGroup(p: Principal, group: string): void {
  const r = groupName.safeParse(group);
  if (!r.success) throw new ServiceError(400, `invalid group: ${r.error.issues[0].message}`);
  resolveGroup(p, group, 'manage');
}

/** An owner cannot change their own grants (no self-lockout); an admin can. */
function notSelf(p: Principal, user: string): void {
  if (!p.admin && p.user === user) throw new ServiceError(403, 'you cannot change your own access');
}
