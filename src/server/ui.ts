/**
 * The optional web UI: one static page (ui/index.html) and the data API it
 * calls, /ui/api/v1/*, which is the REST API of rest.ts.
 *
 * MINIZEP_UI=1 turns it on with a login: the page asks for a token, POST
 * /ui/api/login exchanges it for an HttpOnly session cookie, and every
 * /ui/api/v1 request acts as that token (resolved again each time, so a
 * revocation applies at once). The page itself is served without login.
 *
 * MINIZEP_UI_GROUPS (deprecated) turns it on WITHOUT a login, acting as a
 * fixed principal on the groups it names ("*": every group): whoever can
 * reach the listen address can read and write those groups, so enable it on
 * a private network only. Setting both is an error. Token auth on /v1 and
 * /mcp is unchanged either way.
 *
 * What keeps other web pages out (every UI request is checked, login too):
 *   - Host must be an IP literal, localhost or a MINIZEP_UI_HOSTS name. A DNS
 *     rebinding page reaches this server under the attacker's domain name.
 *   - An Origin, when the browser sends one, must be this very origin, with
 *     Sec-Fetch-Site absent or same-origin: a cross-site page can neither
 *     write (its POSTs carry its own Origin) nor read (no CORS headers).
 *   - Bodies must be application/json (readJsonBody), which a cross-site form
 *     or no-cors fetch cannot send.
 *   - The session cookie is SameSite=Strict, and after 10 failed logins
 *     within 5 minutes an address is refused (429) until they age out.
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Principal } from './auth.js';
import { sendJson } from './rest.js';

export interface UiOptions {
  /**
   * The UI without login (deprecated): the groups it may open, the first
   * being its default; 'any' = every group. Absent: visitors log in with a
   * token.
   */
  groups?: readonly string[] | 'any';
  /** Host names accepted besides IP literals and localhost (lowercase, without port) */
  hosts?: readonly string[];
  /** how long a login lasts (default 30 days) */
  sessionDays?: number;
}

/** The login cookie: HttpOnly, SameSite=Strict, sent to /ui and its API only. */
export const SESSION_COOKIE = 'mz_ui';

/** "teamA|shared" -> ['teamA', 'shared'], "*" -> 'any', unset or blank -> undefined (UI off). */
export function parseUiGroups(raw: string | undefined): readonly string[] | 'any' | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === '*') return 'any';
  const groups = value.split('|').map((g) => g.trim());
  if (groups.some((g) => !g || g.includes('*'))) {
    throw new Error('invalid MINIZEP_UI_GROUPS: expected "*" or "group[|group...]" without empty names or "*"');
  }
  return [...new Set(groups)];
}

/** "minizep.example,box.tailnet.example" -> lowercase names; a port, path or wildcard is an error. */
export function parseUiHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of hosts) {
    if (!/^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(h)) {
      throw new Error(`invalid MINIZEP_UI_HOSTS entry "${h}": expected a host name without scheme, port or wildcard`);
    }
  }
  return [...new Set(hosts)];
}

/**
 * The UI settings from MINIZEP_UI (1 = with login) or MINIZEP_UI_GROUPS (no
 * login), MINIZEP_UI_HOSTS and MINIZEP_UI_SESSION_DAYS; undefined when the UI
 * is off.
 */
export function uiFromEnv(env: NodeJS.ProcessEnv = process.env): UiOptions | undefined {
  const groups = parseUiGroups(env.MINIZEP_UI_GROUPS);
  const hosts = parseUiHosts(env.MINIZEP_UI_HOSTS);
  const flag = env.MINIZEP_UI?.trim() ?? '';
  if (!['', '0', '1'].includes(flag)) throw new Error(`MINIZEP_UI must be 1 (UI with login) or 0, got "${flag}"`);
  const login = flag === '1';
  if (login && groups) {
    throw new Error('set MINIZEP_UI=1 (UI with login) or MINIZEP_UI_GROUPS (UI without login), not both');
  }
  const rawDays = env.MINIZEP_UI_SESSION_DAYS?.trim();
  const sessionDays = rawDays ? Number(rawDays) : 30;
  if (!Number.isInteger(sessionDays) || sessionDays < 1) {
    throw new Error(`MINIZEP_UI_SESSION_DAYS must be a positive whole number of days, got "${rawDays}"`);
  }
  if (groups) return { groups, hosts, sessionDays };
  return login ? { hosts, sessionDays } : undefined;
}

/**
 * Who the UI without login acts as: writer on its groups, the first by
 * default ("*": any group, as writer). Never an admin, never an owner.
 */
export function uiPrincipal(groups: readonly string[] | 'any'): Principal {
  if (groups === 'any') return { id: 'ui', defaultGroup: 'default', grants: 'any', admin: false, restriction: { role: 'writer' } };
  return { id: 'ui', defaultGroup: groups[0], grants: groups.map((pattern) => ({ pattern, role: 'writer' as const })), admin: false };
}

/** The value of one cookie of the request, or undefined. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** Set-Cookie for a login of `maxAgeS` seconds; 0 clears it. */
export function sessionCookie(sid: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=${maxAgeS}`;
}

/**
 * Failed logins per client address: after `max` within `windowMs`, the
 * address is refused until the oldest of them ages out. A success does not
 * reset the count (one valid token must not buy unlimited guesses).
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until `address` may try again; 0 when it may now. */
  blockedFor(address: string): number {
    const recent = this.recent(address);
    return recent.length >= this.max ? recent[recent.length - this.max] + this.windowMs - this.now() : 0;
  }

  fail(address: string): void {
    const recent = this.recent(address);
    recent.push(this.now());
    this.failures.set(address, recent);
    // many addresses: forget those whose failures have all aged out
    if (this.failures.size > 10_000) {
      for (const a of [...this.failures.keys()]) if (this.recent(a).length === 0) this.failures.delete(a);
    }
  }

  private recent(address: string): number[] {
    const since = this.now() - this.windowMs;
    return (this.failures.get(address) ?? []).filter((t) => t > since);
  }
}

/** The host part of a Host header (lowercase, no port or brackets); undefined when malformed. */
function hostName(header: string): string | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::\d{1,5})?$/.exec(header.trim().toLowerCase());
  if (!m) return undefined;
  if (m[1] !== undefined) return isIP(m[1]) === 6 ? m[1] : undefined;
  return m[2];
}

/** Why a UI request is refused (403), or undefined when it may proceed. */
export function uiRefusal(req: IncomingMessage, allowedHosts: ReadonlySet<string>): string | undefined {
  const header = req.headers.host;
  const host = header ? hostName(header) : undefined;
  if (!host || !(isIP(host) || host === 'localhost' || allowedHosts.has(host))) {
    return 'host not allowed for the UI (use an IP address, localhost or a MINIZEP_UI_HOSTS name)';
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const site = req.headers['sec-fetch-site'];
    if (origin !== `http://${header}` || (site !== undefined && site !== 'same-origin')) {
      return 'cross-origin request refused';
    }
  }
  return undefined;
}

/** Resolves from src/server and from dist/server alike. */
const PAGE = new URL('../../ui/index.html', import.meta.url);

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

/** ui/index.html, read on every request (it holds no data, and edits need no restart). */
export async function sendUiPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let html: Buffer;
  try {
    html = await readFile(PAGE);
  } catch {
    return sendJson(res, 404, { error: 'the UI is not installed (ui/index.html is missing)' });
  }
  res.writeHead(200, { ...PAGE_HEADERS, 'content-length': String(html.length) });
  res.end(req.method === 'HEAD' ? undefined : html);
}
