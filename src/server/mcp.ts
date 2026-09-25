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
});
const stdio = await serveStdio({
  service,
  defaultGroup: process.env.MINIZEP_GROUP ?? 'default',
  drainTimeoutMs: envInt('MINIZEP_DRAIN_TIMEOUT_MS', 120_000),
  log,
});

// the client disconnecting (stdin closed) and a signal both drain, flush, then exit here
void stdio.closed.then(async () => {
  await rt.close().catch(() => undefined);
  process.exit(0);
});
onShutdownSignal((signal) => void stdio.shutdown(signal), log);

log('MCP server ready on stdio');
