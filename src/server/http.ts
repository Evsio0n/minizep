#!/usr/bin/env node
/**
 * Minizep HTTP server: MCP (Streamable HTTP) on /mcp, a REST API on /v1 and,
 * when MINIZEP_UI_GROUPS is set, a web UI on /ui.
 *
 *   npm run serve                       # 127.0.0.1:8787
 *   MINIZEP_TOKENS="tok1:teamA,tok2:teamB|shared" npm run serve
 *
 * Why HTTP: a stdio server is one process per client, so N agents end up with N
 * divergent graphs and N snapshots overwriting each other. A single HTTP server
 * with shared storage is what makes this usable by more than one client.
 *
 * Auth: bearer tokens. Each token is mapped to the memory groups it may read
 * and write (the first is its default), so a client can only reach its own
 * namespaces. With no tokens configured the server refuses to start unless
 * MINIZEP_ALLOW_ANONYMOUS=1 (local development only).
 *
 * Env (plus the storage/provider variables of runtime.ts):
 *   MINIZEP_HOST               comma-separated listen addresses (default 127.0.0.1);
 *                              an address that does not exist yet is retried
 *   MINIZEP_PORT               default 8787
 *   MINIZEP_TOKENS             "token:group[|group...],..."
 *   MINIZEP_ALLOW_ANONYMOUS    1 = no auth (local development only)
 *   MINIZEP_SESSION_TTL_MS     idle MCP sessions expire (default 1800000)
 *   MINIZEP_MAX_SESSIONS       MCP session cap, oldest idle evicted (default 256)
 *   MINIZEP_DRAIN_TIMEOUT_MS   how long shutdown waits for queued ingestion (default 120000)
 *   MINIZEP_RETRY_INTERVAL_MS  retry failed episodes in the background this often (default 600000, 0 = off)
 *   MINIZEP_RETRY_MAX          ... until an episode has been tried this many times (default 3)
 *   MINIZEP_UI_GROUPS          "group[|group...]" or "*": serve the web UI on /ui, WITHOUT a
 *                              token, for these groups (private networks only; unset = off)
 *   MINIZEP_UI_HOSTS           comma-separated host names the UI may be opened under, besides
 *                              IP addresses and localhost
 */
import { parseTokens } from './auth.js';
import { createHttpApp } from './app.js';
import { parseHosts } from './listen.js';
import { envInt, onShutdownSignal, runtimeFromEnv } from './runtime.js';
import { uiFromEnv } from './ui.js';

const log = (...args: unknown[]) => console.error('[minizep-http]', ...args);

/* ---------- auth ---------- */

const tokens = parseTokens(process.env.MINIZEP_TOKENS);
const allowAnonymous = process.env.MINIZEP_ALLOW_ANONYMOUS === '1';
if (tokens.size === 0 && !allowAnonymous) {
  console.error(
    'refusing to start without authentication.\n' +
      '  set MINIZEP_TOKENS="<token>:<group>[|<group>...][,<token>:<group>...]"  (token -> memory namespaces)\n' +
      '  or set MINIZEP_ALLOW_ANONYMOUS=1 for local development only',
  );
  process.exit(1);
}
log(`auth: ${tokens.size} token(s)${tokens.size === 0 ? ', anonymous access (any group)' : ''}`);

const ui = uiFromEnv();
if (ui) {
  const groups = ui.groups === 'any' ? 'every group' : `groups ${ui.groups.join('|')}`;
  log(`ui: /ui without a token for ${groups}: anyone who can reach this server can read and write them`);
} else if (process.env.MINIZEP_UI_HOSTS) {
  log('MINIZEP_UI_HOSTS is set but MINIZEP_UI_GROUPS is not: the UI is off');
}

const hosts = parseHosts(process.env.MINIZEP_HOST);
if (tokens.size === 0 && hosts.some((h) => !/^(127\.|::1$|localhost$)/.test(h))) {
  log('WARNING: anonymous access on a non-loopback address: anyone who can reach it can read and write every group');
}

/* ---------- graph + server ---------- */

const rt = await runtimeFromEnv();
log(`store=${rt.storeLabel}`);
log(`llm=${rt.llmLabel}`);

const app = createHttpApp({
  zep: rt.zep,
  tokens,
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
