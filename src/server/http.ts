#!/usr/bin/env node
/**
 * Minizep MCP server over HTTP (Streamable HTTP transport).
 *
 *   npm run serve                       # 127.0.0.1:8787/mcp
 *   MINIZEP_TOKENS="tok1:teamA,tok2:teamB" npm run serve
 *
 * Why HTTP: a stdio server is one process per client, so N agents end up with N
 * divergent graphs and N snapshots overwriting each other. A single HTTP server
 * with shared storage is what makes this usable by more than one client.
 *
 * Auth: bearer tokens. Each token is mapped to a memory group, so a client can
 * only read and write its own namespace. With no tokens configured the server
 * refuses to start unless MINIZEP_ALLOW_ANONYMOUS=1 (local development only).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  Minizep,
  FilePersistence,
  PostgresStore,
  FallbackEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  buildLLM,
} from '../index.js';
import { JobQueue } from '../jobs/queue.js';
import { registerTools } from './tools.js';
import { parseTokens, authorize } from './auth.js';

const PORT = Number(process.env.MINIZEP_PORT ?? 8787);
const HOST = process.env.MINIZEP_HOST ?? '127.0.0.1';
const DB_PATH = process.env.MINIZEP_DB ?? join(homedir(), '.minizep', 'graph.json');
const DEFAULT_EMBED_URL = process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435';

const log = (...args: unknown[]) => console.error('[minizep-http]', ...args);

/* ---------- auth ---------- */

const tokens = parseTokens(process.env.MINIZEP_TOKENS);
const allowAnonymous = process.env.MINIZEP_ALLOW_ANONYMOUS === '1';
if (tokens.size === 0 && !allowAnonymous) {
  console.error(
    'refusing to start without authentication.\n' +
      '  set MINIZEP_TOKENS="<token>:<group>[,<token>:<group>...]"  (token -> memory namespace)\n' +
      '  or set MINIZEP_ALLOW_ANONYMOUS=1 for local development only',
  );
  process.exit(1);
}
log(`auth: ${tokens.size} token(s)${allowAnonymous ? ' + anonymous allowed' : ''}`);

/* ---------- graph ---------- */

const { loadLocalDatabaseUrl } = await import('../cli/local-db.js');
const databaseUrl = process.env.MINIZEP_DATABASE_URL ?? (await loadLocalDatabaseUrl());

import type { Embedder } from '../provider/interfaces.js';

const embedTiers: Embedder[] = [new OpenAIEmbedder(DEFAULT_EMBED_URL, process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embed')];
if (process.env.MINIZEP_OLLAMA_URL) embedTiers.push(new OllamaEmbedder(process.env.MINIZEP_OLLAMA_URL));
const embedder = new FallbackEmbedder(embedTiers);

const { llm, label: llmLabel } = buildLLM();

let zep: Minizep;
let storeLabel: string;
if (databaseUrl) {
  const store = new PostgresStore({
    connectionString: databaseUrl,
    embeddingDims: Number(process.env.MINIZEP_EMBED_DIMS ?? 1024),
  });
  await store.health();
  zep = new Minizep({ store, llm, embedder });
  storeLabel = `postgres (${databaseUrl.replace(/:[^:@/]+@/, ':***@')}, dims=${store.embeddingDims})`;
} else {
  zep = new Minizep({ llm, embedder });
  storeLabel = `memory + snapshot ${DB_PATH}`;
}
const persistence = new FilePersistence(DB_PATH);
if (!databaseUrl) await persistence.load(zep);

const jobs = new JobQueue({ concurrency: Number(process.env.MINIZEP_JOB_CONCURRENCY ?? 2) });
log(`store=${storeLabel}`);
log(`llm=${llmLabel}`);

/* ---------- http ---------- */

type Session = { server: McpServer; transport: StreamableHTTPServerTransport };
const sessions = new Map<string, Session>();

async function makeSession(group: string): Promise<Session> {
  const server = new McpServer({ name: 'minizep', version: '0.1.0' });
  // the token's group becomes the default namespace for every tool call
  registerTools(server, { zep, persistence, jobs, llmLabel, storeLabel, defaultGroup: group });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return { server, transport };
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        store: storeLabel,
        llm: llmLabel,
        jobs: jobs.stats,
        sessions: sessions.size,
      }),
    );
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const auth = authorize(req.headers.authorization, tokens, allowAnonymous);
  if (!auth.ok) {
    res.writeHead(auth.status, {
      'content-type': 'application/json',
      ...(auth.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    });
    res.end(JSON.stringify({ error: auth.error }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string' && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    return;
  }

  // new session: hand the transport its own server bound to this token's group
  const session = await makeSession(auth.group);
  await session.transport.handleRequest(req, res);
});

httpServer.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}/mcp (health: /health)`);
});

const shutdown = async () => {
  log('shutting down: draining jobs');
  await jobs.drain();
  await persistence.flush(zep);
  httpServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
