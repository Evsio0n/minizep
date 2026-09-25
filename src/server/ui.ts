/**
 * The optional web UI: one static page (ui/index.html) and the data API it
 * calls, /ui/api/v1/*, which is the REST API of rest.ts acting as a fixed
 * principal.
 *
 * MINIZEP_UI_GROUPS turns it on and names the groups that principal may open
 * ("*": every group). The UI has no login: whoever can reach the listen
 * address can read and write those groups, so enable it on a private network
 * only. Token auth on /v1 and /mcp is unchanged.
 *
 * What keeps other web pages out (every UI request is checked):
 *   - Host must be an IP literal, localhost or a MINIZEP_UI_HOSTS name. A DNS
 *     rebinding page reaches this server under the attacker's domain name.
 *   - An Origin, when the browser sends one, must be this very origin, with
 *     Sec-Fetch-Site absent or same-origin: a cross-site page can neither
 *     write (its POSTs carry its own Origin) nor read (no CORS headers).
 *   - Bodies must be application/json (readJsonBody), which a cross-site form
 *     or no-cors fetch cannot send.
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Principal } from './auth.js';
import { sendJson } from './rest.js';

export interface UiOptions {
  /** the groups the UI may open, the first being its default; 'any' = every group */
  groups: readonly string[] | 'any';
  /** Host names accepted besides IP literals and localhost (lowercase, without port) */
  hosts?: readonly string[];
}

/** "teamA|shared" -> ['teamA', 'shared'], "*" -> 'any', unset or blank -> undefined (UI off). */
export function parseUiGroups(raw: string | undefined): readonly string[] | 'any' | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === '*') return 'any';
  const groups = value.split('|').map((g) => g.trim());
  if (groups.some((g) => !g || g === '*')) {
    throw new Error('invalid MINIZEP_UI_GROUPS: expected "*" or "group[|group...]" without empty names');
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

/** The UI settings from MINIZEP_UI_GROUPS / MINIZEP_UI_HOSTS; undefined when the UI is off. */
export function uiFromEnv(env: NodeJS.ProcessEnv = process.env): UiOptions | undefined {
  const groups = parseUiGroups(env.MINIZEP_UI_GROUPS);
  const hosts = parseUiHosts(env.MINIZEP_UI_HOSTS);
  return groups ? { groups, hosts } : undefined;
}

/** Who the UI acts as: its groups only, the first by default. */
export function uiPrincipal(ui: UiOptions): Principal {
  return { id: 'ui', defaultGroup: ui.groups === 'any' ? 'default' : ui.groups[0], groups: ui.groups };
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
