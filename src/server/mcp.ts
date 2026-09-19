#!/usr/bin/env node
/**
 * Minizep MCP server — temporal knowledge-graph memory for any MCP client
 * (Claude Code, Cursor, custom agents).
 *
 * Transport: stdio. All diagnostics go to stderr; stdout carries protocol
 * frames only.
 *
 * Env:
 *   MINIZEP_DB         snapshot path        (default ~/.minizep/graph.json)
 *   MINIZEP_GROUP      default group id     (default "default")
 *   MINIZEP_LLM_PROVIDER / MINIZEP_LLM_MODEL / MINIZEP_LLM_API_KEY / MINIZEP_LLM_BASE_URL
 *   MINIZEP_EMBED_URL  llama.cpp or ollama endpoint (default 127.0.0.1:11435)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JobQueue } from '../jobs/queue.js';
import { registerTools } from './tools.js';

import {
  Minizep,
  FilePersistence,
  PostgresStore,
  FallbackEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  buildLLM,
} from '../index.js';

/** storage-01 exposes the cluster's embedding service over Tailscale. */
const DEFAULT_EMBED_URL = 'http://127.0.0.1:11435';

const DB_PATH = process.env.MINIZEP_DB ?? join(homedir(), '.minizep', 'graph.json');
const DEFAULT_GROUP = process.env.MINIZEP_GROUP ?? 'default';

const log = (...args: unknown[]) => console.error('[minizep]', ...args);

/* ---------- wiring ---------- */

// Embedding tiers. The second tier is opt-in: an unreachable Ollama used to
// cost a 3s health probe on every call before falling through.
import type { Embedder } from '../provider/interfaces.js';

const embedTiers: Embedder[] = [
  new OpenAIEmbedder(
    process.env.MINIZEP_EMBED_URL ?? DEFAULT_EMBED_URL,
    process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embed',
  ),
];
if (process.env.MINIZEP_OLLAMA_URL) {
  embedTiers.push(new OllamaEmbedder(process.env.MINIZEP_OLLAMA_URL));
}
const embedder = new FallbackEmbedder(embedTiers);

const { llm, label: llmLabel } = buildLLM();

// Storage: Postgres when configured (concurrent-safe, survives restarts,
// pgvector search), otherwise an in-memory graph snapshotted to JSON.
const { loadLocalDatabaseUrl } = await import('../cli/local-db.js');
const databaseUrl = process.env.MINIZEP_DATABASE_URL ?? (await loadLocalDatabaseUrl());

let zep: Minizep;
let persistence: FilePersistence;
let storeLabel: string;

if (databaseUrl) {
  const store = new PostgresStore({
    connectionString: databaseUrl,
    embeddingDims: Number(process.env.MINIZEP_EMBED_DIMS ?? 1024),
  });
  await store.health(); // fail fast if the database is not reachable
  zep = new Minizep({ store, llm, embedder });
  persistence = new FilePersistence(DB_PATH);
  storeLabel = `postgres (${databaseUrl.replace(/:[^:@/]+@/, ':***@')}, dims=${store.embeddingDims})`;
} else {
  zep = new Minizep({ llm, embedder });
  persistence = new FilePersistence(DB_PATH);
  const loaded = await persistence.load(zep);
  storeLabel = `memory + snapshot ${DB_PATH} (${loaded ? 'loaded' : 'empty'})`;
}

log(`store=${storeLabel}`);
log(`llm=${llmLabel}`);

/* ---------- server ---------- */

const jobs = new JobQueue({
  concurrency: Number(process.env.MINIZEP_JOB_CONCURRENCY ?? 2),
});

const server = new McpServer({ name: 'minizep', version: '0.1.0' });
registerTools(server, {
  zep,
  persistence,
  jobs,
  llmLabel,
  storeLabel,
  defaultGroup: DEFAULT_GROUP,
});

/* ---------- lifecycle ---------- */

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await jobs.drain();
  await persistence.flush(zep);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', async () => {
  await persistence.flush(zep);
  process.exit(0);
});

log('MCP server ready on stdio');
