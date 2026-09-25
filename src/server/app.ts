/**
 * The HTTP server as a factory: MCP (Streamable HTTP) on /mcp, the REST API
 * on /v1/*, and an unauthenticated liveness probe on /health, all sharing one
 * Minizep instance, job queue and persistence.
 *
 * `http.ts` is the CLI around this; tests start it in-process on an ephemeral
 * port with fake providers.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { Minizep } from '../index.js';
import { JobQueue } from '../jobs/queue.js';
import { authorize, type Principal } from './auth.js';
import { bindOnce, listenWithRetry, parseHosts, type RetryOptions, type RetryingListen } from './listen.js';
import { createRestHandler, readJsonBody, sendJson } from './rest.js';
import { MemoryService, type SnapshotWriter } from './service.js';
import { SessionRegistry } from './sessions.js';
import { registerTools, SERVER_INFO } from './tools.js';

export interface HttpAppOptions {
  zep: Minizep;
  /** token -> permitted groups, first = default (see auth.parseTokens) */
  tokens: Map<string, string[]>;
  /** with no tokens configured, serve everyone as one trusted user (local development only) */
  allowAnonymous?: boolean;
  jobs?: JobQueue;
  persistence?: SnapshotWriter;
  llmLabel?: string;
  storeLabel?: string;
  /** MCP sessions idle longer than this are closed (default 30 min) */
  sessionTtlMs?: number;
  /** at most this many MCP sessions; the longest idle is evicted for a new one (default 256) */
  maxSessions?: number;
  /** how long close() waits for queued ingestion (default 120 s) */
  drainTimeoutMs?: number;
  /** backoff for listen addresses that do not exist yet */
  listenRetry?: Omit<RetryOptions, 'onRetry'>;
  log?: (...args: unknown[]) => void;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

export interface HttpApp {
  /** the request listener (usable with any node:http server) */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  service: MemoryService;
  jobs: JobQueue;
  sessions: SessionRegistry<McpSession>;
  /**
   * Re-enqueue episodes a previous process left pending (first call only),
   * then listen on every host. Resolves with the addresses bound now; a host
   * whose address does not exist yet keeps being retried in the background.
   * Rejects on any other bind error.
   */
  listen(hosts: string | string[], port: number): Promise<AddressInfo[]>;
  /** the addresses currently listening */
  addresses(): AddressInfo[];
  /**
   * Stop listening, close MCP sessions, wait for queued ingestion (bounded)
   * and flush persistence. Resolves false when the drain timed out: those
   * episodes stay pending and are recovered at the next start.
   */
  close(opts?: { drainTimeoutMs?: number }): Promise<boolean>;
}

/** A JSON-RPC error body, which is what MCP clients expect from /mcp. */
const rpcError = (message: string, code = -32000) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const log = opts.log ?? (() => undefined);
  const jobs = opts.jobs ?? new JobQueue();
  const service = new MemoryService({
    zep: opts.zep,
    jobs,
    persistence: opts.persistence,
    llmLabel: opts.llmLabel,
    storeLabel: opts.storeLabel,
  });
  const sessions = new SessionRegistry<McpSession>({ ttlMs: opts.sessionTtlMs, maxSessions: opts.maxSessions });
  sessions.startSweeping();
  const rest = createRestHandler({
    service,
    sessionsOf: (p) => sessions.countFor(p.id),
    log,
  });

  const servers: Server[] = [];
  const retries: RetryingListen[] = [];
  let recovered = false;
  let closing: Promise<boolean> | undefined;

  /** A new MCP server + transport acting for `principal`; registered once initialised. */
  async function openSession(principal: Principal, onReady: () => void): Promise<McpSession> {
    const server = new McpServer(SERVER_INFO);
    registerTools(server, { service, principal });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.add(id, principal.id, session);
        onReady();
      },
    });
    const session: McpSession = { server, transport, close: () => server.close() };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        const tooLarge = status === 413;
        return sendJson(res, status, rpcError((err as Error).message, tooLarge ? -32600 : -32700), tooLarge ? { connection: 'close' } : {});
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessionId) {
      // a GET is the client's standing SSE stream: it does not keep the session alive
      const found = sessions.acquire(sessionId, principal.id, req.method !== 'GET');
      // 404 tells a client to start a new session; 403: someone else's session
      if (!found.ok) return sendJson(res, found.status, rpcError(found.error, found.status === 404 ? -32001 : -32000));
      res.on('close', found.release);
      await found.handle.transport.handleRequest(req, res, body);
      return;
    }

    const initialize = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
    if (req.method !== 'POST' || !initialize) {
      return sendJson(res, 400, rpcError('Bad Request: mcp-session-id header is required'));
    }
    if (!sessions.reserve()) return sendJson(res, 503, rpcError('too many sessions, try again later'));
    let registered = false;
    try {
      const session = await openSession(principal, () => {
        registered = true;
      });
      await session.transport.handleRequest(req, res, body);
      if (!registered) await session.close();
    } finally {
      if (!registered) sessions.unreserve();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // the Host header is client-controlled; only the path matters here
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      // liveness only: server details are for authenticated callers (/v1/status)
      return sendJson(res, 200, { ok: true });
    }
    const isMcp = url.pathname === '/mcp';
    const isRest = url.pathname === '/v1' || url.pathname.startsWith('/v1/');
    if (!isMcp && !isRest) return sendJson(res, 404, { error: 'not found' });

    const auth = authorize(req.headers.authorization, opts.tokens, opts.allowAnonymous ?? false);
    if (!auth.ok) {
      return sendJson(res, auth.status, { error: auth.error }, auth.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
    }
    if (closing) return sendJson(res, 503, { error: 'server is shutting down' });
    if (isRest) return rest(req, res, url, auth.principal);
    return handleMcp(req, res, auth.principal);
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err) => {
      log(`${req.method} ${req.url} failed:`, (err as Error)?.stack ?? err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  };

  const addresses = () =>
    servers.filter((s) => s.listening).map((s) => s.address() as AddressInfo);

  async function listen(hostsArg: string | string[], port: number): Promise<AddressInfo[]> {
    if (!recovered) {
      recovered = true;
      const n = await service.recoverPending();
      if (n) log(`re-enqueued ${n} pending episode(s) from a previous run`);
    }
    const hosts = Array.isArray(hostsArg) ? hostsArg : parseHosts(hostsArg);
    const bound: AddressInfo[] = [];
    for (const host of hosts) {
      const server = createServer(handler);
      servers.push(server);
      const attempt = listenWithRetry(() => bindOnce(server, port, host), {
        ...opts.listenRetry,
        onRetry: (err, delay) => log(`${host}:${port} is not available yet (${err.code}); retrying in ${delay}ms`),
      });
      retries.push(attempt);
      const addr = await attempt.first;
      if (addr) {
        bound.push(addr);
        log(`listening on ${describe(addr)}`);
      } else {
        attempt.bound.then(
          (a) => log(`listening on ${describe(a)}`),
          () => undefined,
        );
      }
    }
    return bound;
  }

  function close(closeOpts: { drainTimeoutMs?: number } = {}): Promise<boolean> {
    closing ??= (async () => {
      for (const r of retries) r.cancel();
      const stopped = servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s.listening) return resolve();
            s.close(() => resolve());
            s.closeIdleConnections();
          }),
      );
      await sessions.closeAll();
      const drained = await service.shutdown(closeOpts.drainTimeoutMs ?? opts.drainTimeoutMs ?? 120_000);
      for (const s of servers) s.closeAllConnections();
      await Promise.all(stopped);
      return drained;
    })();
    return closing;
  }

  return { handler, service, jobs, sessions, listen, addresses, close };
}

function describe(a: AddressInfo): string {
  const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
  return `http://${host}:${a.port} (mcp: /mcp, rest: /v1, health: /health)`;
}
