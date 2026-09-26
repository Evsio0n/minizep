/**
 * Storage of users, grants, API tokens and web UI sessions (server/access.ts
 * says what they mean). Two implementations: in memory (tests, and a server
 * without a database, where they last as long as the process) and Postgres,
 * next to the graph in the same database and schema.
 *
 * No secret is stored: a token is found by the sha256 of its secret, a UI
 * session by the sha256 of its cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { matchesPattern, type Role } from '../server/auth.js';

export interface UserRecord {
  name: string;
  admin: boolean;
  disabled: boolean;
  defaultGroup: string;
  createdAt: Date;
}

export interface GrantRecord {
  user: string;
  pattern: string;
  role: Role;
  createdAt: Date;
}

export interface TokenRecord {
  /** tk_ + 12 hex characters: names the token in listings and sessions */
  id: string;
  user: string;
  /** a label for people */
  name: string;
  /** the first 8 characters of the secret, to recognise it */
  prefix: string;
  /** the token only reaches groups matching one of these (null: every group of its user) */
  groups: string[] | null;
  /** the highest role it acts with (null: its user's) */
  role: 'reader' | 'writer' | null;
  defaultGroup: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type NewToken = Pick<TokenRecord, 'user' | 'name' | 'groups' | 'role' | 'defaultGroup' | 'expiresAt'>;

export interface UiSessionRecord {
  tokenId: string;
  expiresAt: Date;
}

export interface AccessStore {
  /** false: users and tokens are gone when the process exits */
  readonly persistent: boolean;
  countUsers(): Promise<number>;
  /** undefined when the name is taken */
  createUser(user: Omit<UserRecord, 'createdAt'>): Promise<UserRecord | undefined>;
  getUser(name: string): Promise<UserRecord | undefined>;
  listUsers(): Promise<UserRecord[]>;
  /** undefined when there is no such user */
  updateUser(name: string, patch: Partial<Pick<UserRecord, 'admin' | 'disabled' | 'defaultGroup'>>): Promise<UserRecord | undefined>;
  /** insert, or change the role of the existing (user, pattern) grant */
  setGrant(user: string, pattern: string, role: Role): Promise<GrantRecord>;
  /** false when there was no such grant */
  removeGrant(user: string, pattern: string): Promise<boolean>;
  /** one user's grants, or every grant whose pattern matches `group` */
  listGrants(filter?: { user?: string; group?: string }): Promise<GrantRecord[]>;
  /** the only time the secret is seen */
  createToken(token: NewToken): Promise<{ secret: string; token: TokenRecord }>;
  findTokenBySecretHash(hash: string): Promise<TokenRecord | undefined>;
  getToken(id: string): Promise<TokenRecord | undefined>;
  listTokens(filter?: { user?: string }): Promise<TokenRecord[]>;
  /** undefined when there is no such token; revoking again keeps the first time */
  revokeToken(id: string, at: Date): Promise<TokenRecord | undefined>;
  touchToken(id: string, at: Date): Promise<void>;
  createUiSession(sidHash: string, tokenId: string, expiresAt: Date): Promise<void>;
  getUiSession(sidHash: string): Promise<UiSessionRecord | undefined>;
  deleteUiSession(sidHash: string): Promise<void>;
  /** drop the expired sessions; answers how many */
  purgeUiSessions(now: Date): Promise<number>;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A new token's id and secret (mz_ + 32 random bytes as base64url), and what is kept of the secret. */
function mint(): { id: string; secret: string; hash: string; prefix: string } {
  const secret = `mz_${randomBytes(32).toString('base64url')}`;
  return { id: `tk_${randomBytes(6).toString('hex')}`, secret, hash: sha256(secret), prefix: secret.slice(0, 8) };
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byGrant = (a: GrantRecord, b: GrantRecord) =>
  a.user < b.user ? -1 : a.user > b.user ? 1 : a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
const byCreation = (a: TokenRecord, b: TokenRecord) => a.createdAt.getTime() - b.createdAt.getTime();
const inGroup = (group: string | undefined) => (g: GrantRecord) => group === undefined || matchesPattern(g.pattern, group);

/* ---------------- in memory ---------------- */

export class MemoryAccessStore implements AccessStore {
  readonly persistent = false;
  private readonly users = new Map<string, UserRecord>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly tokens = new Map<string, TokenRecord & { hash: string }>();
  private readonly sessions = new Map<string, UiSessionRecord>();

  async countUsers() {
    return this.users.size;
  }

  async createUser(user: Omit<UserRecord, 'createdAt'>) {
    if (this.users.has(user.name)) return undefined;
    const record = { ...user, createdAt: new Date() };
    this.users.set(user.name, record);
    return { ...record };
  }

  async getUser(name: string) {
    const u = this.users.get(name);
    return u && { ...u };
  }

  async listUsers() {
    return [...this.users.values()].map((u) => ({ ...u })).sort(byName);
  }

  async updateUser(name: string, patch: Partial<Pick<UserRecord, 'admin' | 'disabled' | 'defaultGroup'>>) {
    const u = this.users.get(name);
    if (!u) return undefined;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) Object.assign(u, { [k]: v });
    return { ...u };
  }

  async setGrant(user: string, pattern: string, role: Role) {
    const key = JSON.stringify([user, pattern]);
    const grant = { user, pattern, role, createdAt: this.grants.get(key)?.createdAt ?? new Date() };
    this.grants.set(key, grant);
    return { ...grant };
  }

  async removeGrant(user: string, pattern: string) {
    return this.grants.delete(JSON.stringify([user, pattern]));
  }

  async listGrants(filter: { user?: string; group?: string } = {}) {
    return [...this.grants.values()]
      .filter((g) => filter.user === undefined || g.user === filter.user)
      .filter(inGroup(filter.group))
      .map((g) => ({ ...g }))
      .sort(byGrant);
  }

  async createToken(t: NewToken) {
    const { id, secret, hash, prefix } = mint();
    const token = { ...t, id, prefix, hash, createdAt: new Date(), lastUsedAt: null, revokedAt: null };
    this.tokens.set(id, token);
    return { secret, token: withoutHash(token) };
  }

  async findTokenBySecretHash(hash: string) {
    const t = [...this.tokens.values()].find((x) => x.hash === hash);
    return t && withoutHash(t);
  }

  async getToken(id: string) {
    const t = this.tokens.get(id);
    return t && withoutHash(t);
  }

  async listTokens(filter: { user?: string } = {}) {
    return [...this.tokens.values()]
      .filter((t) => filter.user === undefined || t.user === filter.user)
      .map(withoutHash)
      .sort(byCreation);
  }

  async revokeToken(id: string, at: Date) {
    const t = this.tokens.get(id);
    if (!t) return undefined;
    t.revokedAt ??= at;
    return withoutHash(t);
  }

  async touchToken(id: string, at: Date) {
    const t = this.tokens.get(id);
    if (t) t.lastUsedAt = at;
  }

  async createUiSession(sidHash: string, tokenId: string, expiresAt: Date) {
    this.sessions.set(sidHash, { tokenId, expiresAt });
  }

  async getUiSession(sidHash: string) {
    const s = this.sessions.get(sidHash);
    return s && { ...s };
  }

  async deleteUiSession(sidHash: string) {
    this.sessions.delete(sidHash);
  }

  async purgeUiSessions(now: Date) {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(k);
        n++;
      }
    }
    return n;
  }
}

function withoutHash({ hash: _hash, ...t }: TokenRecord & { hash: string }): TokenRecord {
  return { ...t, groups: t.groups && [...t.groups] };
}

/* ---------------- Postgres ---------------- */

/**
 * The access tables in the graph's database and schema (the pool's
 * search_path), created on first use. Users are never deleted, only
 * disabled, so grants and tokens simply reference them.
 */
export class PostgresAccessStore implements AccessStore {
  readonly persistent = true;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly schema: string,
  ) {}

  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mz_users (
          name TEXT PRIMARY KEY,
          admin BOOLEAN NOT NULL DEFAULT false,
          disabled BOOLEAN NOT NULL DEFAULT false,
          default_group TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS mz_grants (
          user_name TEXT NOT NULL REFERENCES mz_users(name),
          pattern TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'owner')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_name, pattern)
        );
        CREATE TABLE IF NOT EXISTS mz_tokens (
          id TEXT PRIMARY KEY,
          user_name TEXT NOT NULL REFERENCES mz_users(name),
          name TEXT NOT NULL DEFAULT '',
          secret_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          groups TEXT[],
          role TEXT CHECK (role IN ('reader', 'writer')),
          default_group TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ,
          last_used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS mz_tokens_user ON mz_tokens (user_name);
        CREATE TABLE IF NOT EXISTS mz_ui_sessions (
          sid_hash TEXT PRIMARY KEY,
          token_id TEXT NOT NULL REFERENCES mz_tokens(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        );
      `);
    })().catch((err: unknown) => {
      // a transient failure must not break the store for good: the next call retries
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async query(sql: string, params: unknown[] = []) {
    await this.ensure();
    return this.pool.query(sql, params);
  }

  async countUsers() {
    const r = await this.query('SELECT count(*) AS n FROM mz_users');
    return Number(r.rows[0].n);
  }

  async createUser(user: Omit<UserRecord, 'createdAt'>) {
    const r = await this.query(
      `INSERT INTO mz_users (name, admin, disabled, default_group) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [user.name, user.admin, user.disabled, user.defaultGroup],
    );
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async getUser(name: string) {
    const r = await this.query('SELECT * FROM mz_users WHERE name = $1', [name]);
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async listUsers() {
    const r = await this.query('SELECT * FROM mz_users ORDER BY name COLLATE "C"');
    return r.rows.map(rowToUser);
  }

  async updateUser(name: string, patch: Partial<Pick<UserRecord, 'admin' | 'disabled' | 'defaultGroup'>>) {
    const r = await this.query(
      `UPDATE mz_users SET admin = COALESCE($2, admin), disabled = COALESCE($3, disabled),
              default_group = COALESCE($4, default_group)
        WHERE name = $1 RETURNING *`,
      [name, patch.admin ?? null, patch.disabled ?? null, patch.defaultGroup ?? null],
    );
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async setGrant(user: string, pattern: string, role: Role) {
    const r = await this.query(
      `INSERT INTO mz_grants (user_name, pattern, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_name, pattern) DO UPDATE SET role = EXCLUDED.role RETURNING *`,
      [user, pattern, role],
    );
    return rowToGrant(r.rows[0]);
  }

  async removeGrant(user: string, pattern: string) {
    const r = await this.query('DELETE FROM mz_grants WHERE user_name = $1 AND pattern = $2', [user, pattern]);
    return (r.rowCount ?? 0) > 0;
  }

  async listGrants(filter: { user?: string; group?: string } = {}) {
    // few rows: the pattern match runs here, the same code as the in-memory store's
    const r = await this.query(
      'SELECT * FROM mz_grants WHERE $1::text IS NULL OR user_name = $1 ORDER BY user_name COLLATE "C", pattern COLLATE "C"',
      [filter.user ?? null],
    );
    return r.rows.map(rowToGrant).filter(inGroup(filter.group));
  }

  async createToken(t: NewToken) {
    const { id, secret, hash, prefix } = mint();
    const r = await this.query(
      `INSERT INTO mz_tokens (id, user_name, name, secret_hash, prefix, groups, role, default_group, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, t.user, t.name, hash, prefix, t.groups, t.role, t.defaultGroup, t.expiresAt],
    );
    return { secret, token: rowToToken(r.rows[0]) };
  }

  async findTokenBySecretHash(hash: string) {
    const r = await this.query('SELECT * FROM mz_tokens WHERE secret_hash = $1', [hash]);
    return r.rows[0] ? rowToToken(r.rows[0]) : undefined;
  }

  async getToken(id: string) {
    const r = await this.query('SELECT * FROM mz_tokens WHERE id = $1', [id]);
    return r.rows[0] ? rowToToken(r.rows[0]) : undefined;
  }

  async listTokens(filter: { user?: string } = {}) {
    const r = await this.query(
      'SELECT * FROM mz_tokens WHERE $1::text IS NULL OR user_name = $1 ORDER BY created_at, id',
      [filter.user ?? null],
    );
    return r.rows.map(rowToToken);
  }

  async revokeToken(id: string, at: Date) {
    const r = await this.query(
      'UPDATE mz_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 RETURNING *',
      [id, at],
    );
    return r.rows[0] ? rowToToken(r.rows[0]) : undefined;
  }

  async touchToken(id: string, at: Date) {
    await this.query('UPDATE mz_tokens SET last_used_at = $2 WHERE id = $1', [id, at]);
  }

  async createUiSession(sidHash: string, tokenId: string, expiresAt: Date) {
    await this.query('INSERT INTO mz_ui_sessions (sid_hash, token_id, expires_at) VALUES ($1, $2, $3)', [
      sidHash,
      tokenId,
      expiresAt,
    ]);
  }

  async getUiSession(sidHash: string) {
    const r = await this.query('SELECT token_id, expires_at FROM mz_ui_sessions WHERE sid_hash = $1', [sidHash]);
    const row = r.rows[0];
    return row ? { tokenId: row.token_id as string, expiresAt: row.expires_at as Date } : undefined;
  }

  async deleteUiSession(sidHash: string) {
    await this.query('DELETE FROM mz_ui_sessions WHERE sid_hash = $1', [sidHash]);
  }

  async purgeUiSessions(now: Date) {
    const r = await this.query('DELETE FROM mz_ui_sessions WHERE expires_at <= $1', [now]);
    return r.rowCount ?? 0;
  }
}

type Row = Record<string, any>;

function rowToUser(r: Row): UserRecord {
  return { name: r.name, admin: r.admin, disabled: r.disabled, defaultGroup: r.default_group, createdAt: r.created_at };
}

function rowToGrant(r: Row): GrantRecord {
  return { user: r.user_name, pattern: r.pattern, role: r.role, createdAt: r.created_at };
}

function rowToToken(r: Row): TokenRecord {
  return {
    id: r.id,
    user: r.user_name,
    name: r.name,
    prefix: r.prefix,
    groups: r.groups,
    role: r.role,
    defaultGroup: r.default_group,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}
