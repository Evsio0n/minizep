/**
 * The MCP server over stdio, as a function of its streams (mcp.ts is the CLI
 * around it; tests drive it with in-memory streams).
 *
 * A stdio client owns the process: when it disconnects, stdin ends. Queued
 * ingestion must still finish (bounded by `drainTimeoutMs`) and be flushed
 * before the process may exit, otherwise an async add_memory is lost.
 */
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { localPrincipal } from './auth.js';
import type { MemoryService } from './service.js';
import { registerTools, SERVER_INFO, serverOptionsFor } from './tools.js';

export interface StdioOptions {
  service: MemoryService;
  /** group used when a tool call names none (any group is accepted) */
  defaultGroup: string;
  stdin?: Readable;
  stdout?: Writable;
  /** how long shutdown waits for queued ingestion (default 120 s) */
  drainTimeoutMs?: number;
  /** retry failed episodes in the background this often (default 600000; 0 = never) */
  retryIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface StdioServer {
  /**
   * Drain (bounded), flush and close; idempotent. Resolves false when the
   * drain timed out (those episodes stay pending for the next start).
   */
  shutdown(reason: string): Promise<boolean>;
  /** settles when a shutdown has completed, whatever triggered it */
  closed: Promise<boolean>;
}

export async function serveStdio(opts: StdioOptions): Promise<StdioServer> {
  const { service } = opts;
  const log = opts.log ?? (() => undefined);
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 120_000;

  const recovered = await service.recoverPending();
  if (recovered) log(`re-enqueued ${recovered} pending episode(s) from a previous run`);
  const stopRetrying = service.retryEvery(opts.retryIntervalMs ?? 600_000, log);

  // single local user: every group is theirs
  const principal = localPrincipal(opts.defaultGroup);
  const server = new McpServer(SERVER_INFO, serverOptionsFor(principal));
  registerTools(server, { service, principal: () => principal });
  // once the client is gone its pipe is broken: a late answer must not crash
  // the process while it drains
  stdout.on('error', (err) => log(`stdout: ${err.message}`));
  await server.connect(new StdioServerTransport(stdin, stdout));

  let finished: (drained: boolean) => void = () => undefined;
  const closed = new Promise<boolean>((resolve) => {
    finished = resolve;
  });
  let stopping: Promise<boolean> | undefined;
  const shutdown = (reason: string): Promise<boolean> => {
    stopping ??= (async () => {
      log(`${reason}: finishing queued work (up to ${drainTimeoutMs}ms)`);
      stopRetrying();
      let drained = false;
      try {
        drained = await service.shutdown(drainTimeoutMs);
        if (!drained) log('drain timed out: unfinished episodes stay pending and are recovered at the next start');
      } catch (err) {
        log(`shutdown failed: ${(err as Error).message}`);
      }
      await server.close().catch(() => undefined);
      finished(drained);
      return drained;
    })();
    return stopping;
  };
  stdin.once('end', () => void shutdown('stdin closed'));
  stdin.once('close', () => void shutdown('stdin closed'));
  return { shutdown, closed };
}
