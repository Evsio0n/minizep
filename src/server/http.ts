#!/usr/bin/env node
/**
 * Minizep HTTP server: MCP (Streamable HTTP) on /mcp, a REST API on /v1 and,
 * when MINIZEP_UI is set, a web UI on /ui.
 *
 *   npm run serve                       # 127.0.0.1:8787
 *   MINIZEP_TOKENS="tok1:teamA,tok2:teamB|shared" npm run serve
 *
 * Why HTTP: a stdio server is one process per client, so N agents end up with N
 * divergent graphs and N snapshots overwriting each other. A single HTTP server
 * with shared storage is what makes this usable by more than one client.
 *
 * Auth: bearer tokens. Env tokens (MINIZEP_TOKENS) are each mapped to the
 * memory groups they may read and write (the first is its default). Users,
 * their roles per group and their tokens live in the database and are managed
 * with minizep-admin or /v1/admin (docs/ACCESS.md). With neither an env token
 * nor a user the server refuses to start unless MINIZEP_ALLOW_ANONYMOUS=1
 * (local development only).
 *
 * Env (plus the storage/provider variables of runtime.ts):
 *   MINIZEP_HOST               comma-separated listen addresses (default 127.0.0.1);
 *                              an address that does not exist yet is retried
 *   MINIZEP_PORT               default 8787
 *   MINIZEP_TOKENS             "token:group[|group...],..." (writer on exactly those groups)
 *   MINIZEP_ALLOW_ANONYMOUS    1 = no auth while there is no token and no user (local development only)
 *   MINIZEP_SESSION_TTL_MS     idle MCP sessions expire (default 1800000)
 *   MINIZEP_MAX_SESSIONS       MCP session cap, oldest idle evicted (default 256)
 *   MINIZEP_DRAIN_TIMEOUT_MS   how long shutdown waits for queued ingestion (default 120000)
 *   MINIZEP_RETRY_INTERVAL_MS  retry failed episodes in the background this often (default 600000, 0 = off)
 *   MINIZEP_RETRY_MAX          ... until an episode has been tried this many times (default 3)
 *   MINIZEP_UI                 1 = serve the web UI on /ui, with a login by token
 *   MINIZEP_UI_SESSION_DAYS    how long a UI login lasts (default 30)
 *   MINIZEP_UI_GROUPS          deprecated: "group[|group...]" or "*": serve the web UI WITHOUT a
 *                              login for these groups (private networks only; not with MINIZEP_UI)
 *   MINIZEP_UI_HOSTS           comma-separated host names the UI may be opened under, besides
 *                              IP addresses and localhost
 */
import { parseTokens } from './auth.js';
import { createHttpApp } from './app.js';
import { parseHosts } from './listen.js';
import { envInt, onShutdownSignal, runtimeFromEnv } from './runtime.js';
import { uiFromEnv } from './ui.js';

const log = (...args: unknown[]) => console.error('[minizep-http]', ...args);

/* ---------- configuration (a mistake stops the start before anything opens) ---------- */

const tokens = parseTokens(process.env.MINIZEP_TOKENS);
const allowAnonymous = process.env.MINIZEP_ALLOW_ANONYMOUS === '1';
const ui = uiFromEnv();
const hosts = parseHosts(process.env.MINIZEP_HOST);

/* ---------- graph ---------- */

const rt = await runtimeFromEnv();
log(`store=${rt.storeLabel}`);
log(`llm=${rt.llmLabel}`);

/* ---------- auth ---------- */

const users = await rt.access.countUsers();
if (tokens.size === 0 && users === 0 && !allowAnonymous) {
  console.error(
    'refusing to start without authentication.\n' +
      '  set MINIZEP_TOKENS="<token>:<group>[|<group>...][,<token>:<group>...]"  (token -> memory namespaces)\n' +
      '  or add a user: minizep-admin user add <name>  (needs MINIZEP_DATABASE_URL, see docs/ACCESS.md)\n' +
      '  or set MINIZEP_ALLOW_ANONYMOUS=1 for local development only',
  );
  await rt.close().catch(() => undefined);
  process.exit(1);
}
const anonymous = tokens.size === 0 && users === 0;
log(`auth: ${tokens.size} env token(s), ${users} user(s)${anonymous ? ', anonymous access (any group) until a user is added' : ''}`);
if (!rt.access.persistent) {
  log('users and tokens are kept in memory (no database): user management needs Postgres to persist');
}
if (anonymous && hosts.some((h) => !/^(127\.|::1$|localhost$)/.test(h))) {
  log('WARNING: anonymous access on a non-loopback address: anyone who can reach it can read and write every group');
}

if (ui?.groups) {
  const groups = ui.groups === 'any' ? 'every group' : `groups ${ui.groups.join('|')}`;
  log(`ui: /ui without a token for ${groups}: anyone who can reach this server can read and write them`);
  log('MINIZEP_UI_GROUPS (the UI without login) is deprecated: set MINIZEP_UI=1 instead, which asks for a token');
} else if (ui) {
  log(`ui: /ui with login (a session lasts ${ui.sessionDays} days)`);
} else if (process.env.MINIZEP_UI_HOSTS) {
  log('MINIZEP_UI_HOSTS is set but neither MINIZEP_UI nor MINIZEP_UI_GROUPS: the UI is off');
}

/* ---------- server ---------- */

const app = createHttpApp({
  zep: rt.zep,
  tokens,
  access: rt.access,
  allowAnonymous,
  ui,
  jobs: rt.jobs,
  persistence: rt.persistence,
  llmLabel: rt.llmLabel,
  storeLabel: rt.storeLabel,
  sessionTtlMs: envInt('MINIZEP_SESSION_TTL_MS', 30 * 60_000),
  maxSessions: envInt('MINIZEP_MAX_SESSIONS', 256),
  drainTimeoutMs: envInt('MINIZEP_DRAIN_TIMEOUT_MS', 120_000),
  retryIntervalMs: envInt('MINIZEP_RETRY_INTERVAL_MS', 600_000),
  retryMax: envInt('MINIZEP_RETRY_MAX', 3),
  log,
});
await app.listen(hosts, envInt('MINIZEP_PORT', 8787));

onShutdownSignal(async (signal) => {
  log(`${signal}: shutting down, finishing queued work`);
  const drained = await app.close().catch((err) => {
    log(`shutdown failed: ${(err as Error).message}`);
    return false;
  });
  if (!drained) log('unfinished episodes stay pending and are recovered at the next start');
  await rt.close().catch(() => undefined);
  process.exit(0);
}, log);
