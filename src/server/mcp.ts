#!/usr/bin/env node
/**
 * Minizep MCP server — temporal knowledge-graph memory for any MCP client
 * (Claude Code, Cursor, custom agents).
 *
 * Transport: stdio. All diagnostics go to stderr; stdout carries protocol
 * frames only. One local user: tool calls may name any group.
 *
 * Env (plus the storage/provider variables of runtime.ts):
 *   MINIZEP_GROUP              default group id (default "default")
 *   MINIZEP_DRAIN_TIMEOUT_MS   how long to finish queued ingestion when the
 *                              client disconnects or on SIGTERM (default 120000)
 *   MINIZEP_RETRY_INTERVAL_MS  retry failed episodes in the background this
 *                              often (default 600000, 0 = off)
 *   MINIZEP_RETRY_MAX          ... until an episode has been tried this many
 *                              times (default 3)
 */
import { MemoryService } from './service.js';
import { serveStdio } from './stdio.js';
import { envInt, onShutdownSignal, runtimeFromEnv } from './runtime.js';

const log = (...args: unknown[]) => console.error('[minizep]', ...args);

const rt = await runtimeFromEnv();
log(`store=${rt.storeLabel}`);
log(`llm=${rt.llmLabel}`);

const service = new MemoryService({
  zep: rt.zep,
  jobs: rt.jobs,
  persistence: rt.persistence,
  llmLabel: rt.llmLabel,
  storeLabel: rt.storeLabel,
  retryMax: envInt('MINIZEP_RETRY_MAX', 3),
});
const stdio = await serveStdio({
  service,
  defaultGroup: process.env.MINIZEP_GROUP ?? 'default',
  drainTimeoutMs: envInt('MINIZEP_DRAIN_TIMEOUT_MS', 120_000),
  retryIntervalMs: envInt('MINIZEP_RETRY_INTERVAL_MS', 600_000),
  log,
});

// the client disconnecting (stdin closed) and a signal both drain, flush, then exit here
void stdio.closed.then(async () => {
  await rt.close().catch(() => undefined);
  process.exit(0);
});
onShutdownSignal((signal) => void stdio.shutdown(signal), log);

log('MCP server ready on stdio');
