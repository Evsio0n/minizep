/**
 * Wiring shared by the server CLIs (http.ts, mcp.ts): providers, storage and
 * the job queue, all configured from the environment.
 *
 *   MINIZEP_DATABASE_URL   Postgres (else in-memory graph + JSON snapshot)
 *   MINIZEP_DB             snapshot path (default ~/.minizep/graph.json)
 *   MINIZEP_EMBED_URL / MINIZEP_EMBED_MODEL / MINIZEP_EMBED_DIMS / MINIZEP_OLLAMA_URL
 *   MINIZEP_LLM_*          see provider/openai-llm.ts
 *   MINIZEP_JOB_CONCURRENCY  ingestion jobs run at once (default 2)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Minizep,
  FilePersistence,
  PostgresStore,
  FallbackEmbedder,
  OpenAIEmbedder,
  OllamaEmbedder,
  buildLLM,
} from '../index.js';
import type { Embedder } from '../provider/interfaces.js';
import { JobQueue } from '../jobs/queue.js';
import { loadLocalDatabaseUrl } from '../cli/local-db.js';
import { MemoryAccessStore, type AccessStore } from '../store/access-store.js';

/** Default embedding endpoint: a llama.cpp server on the loopback interface. */
const DEFAULT_EMBED_URL = 'http://127.0.0.1:11435';

export interface Runtime {
  zep: Minizep;
  persistence: FilePersistence;
  jobs: JobQueue;
  /** users, grants and tokens: next to the graph in Postgres, else in memory until exit */
  access: AccessStore;
  llmLabel: string;
  storeLabel: string;
  /** release the database pool (after the last flush) */
  close(): Promise<void>;
}

/** A non-negative integer from the environment, or `fallback` when unset. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export async function runtimeFromEnv(): Promise<Runtime> {
  // Embedding tiers. The second tier is opt-in: an unreachable Ollama used to
  // cost a 3s health probe on every call before falling through.
  const embedTiers: Embedder[] = [
    new OpenAIEmbedder(
      process.env.MINIZEP_EMBED_URL ?? DEFAULT_EMBED_URL,
      process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embed',
    ),
  ];
  if (process.env.MINIZEP_OLLAMA_URL) embedTiers.push(new OllamaEmbedder(process.env.MINIZEP_OLLAMA_URL));
  const embedder = new FallbackEmbedder(embedTiers);

  const { llm, label: llmLabel } = buildLLM();

  const dbPath = process.env.MINIZEP_DB ?? join(homedir(), '.minizep', 'graph.json');
  const persistence = new FilePersistence(dbPath);
  const jobs = new JobQueue({ concurrency: envInt('MINIZEP_JOB_CONCURRENCY', 2) });

  // Storage: Postgres when configured (concurrent-safe, survives restarts,
  // pgvector search), otherwise an in-memory graph snapshotted to JSON.
  const databaseUrl = process.env.MINIZEP_DATABASE_URL ?? (await loadLocalDatabaseUrl());
  if (databaseUrl) {
    const store = new PostgresStore({
      connectionString: databaseUrl,
      embeddingDims: envInt('MINIZEP_EMBED_DIMS', 1024),
    });
    await store.health(); // fail fast if the database is not reachable
    return {
      zep: new Minizep({ store, llm, embedder }),
      persistence,
      jobs,
      access: store.accessStore(),
      llmLabel,
      storeLabel: `postgres (${databaseUrl.replace(/:[^:@/]+@/, ':***@')}, dims=${store.embeddingDims})`,
      close: () => store.close(),
    };
  }

  const zep = new Minizep({ llm, embedder });
  const loaded = await persistence.load(zep);
  return {
    zep,
    persistence,
    jobs,
    access: new MemoryAccessStore(),
    llmLabel,
    storeLabel: `memory + snapshot ${dbPath} (${loaded ? 'loaded' : 'empty'})`,
    close: async () => undefined,
  };
}

/**
 * Call `shutdown` on the first SIGINT/SIGTERM (it is responsible for exiting).
 * A second signal exits at once: work not finished by then stays pending and
 * is recovered at the next start.
 */
export function onShutdownSignal(shutdown: (signal: string) => void, log: (msg: string) => void): void {
  let stopping = false;
  const handle = (signal: string) => {
    if (stopping) {
      log(`${signal} again: exiting without waiting`);
      process.exit(1);
    }
    stopping = true;
    shutdown(signal);
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}
