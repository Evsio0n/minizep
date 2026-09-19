#!/usr/bin/env node
/**
 * Migration CLI: JSON snapshot → configured store.
 *
 *   npm run migrate -- <snapshot.json> [--reembed] [--group <id>] [--dry]
 *
 * Target store comes from MINIZEP_DATABASE_URL (Postgres) or, when unset,
 * falls back to the local Postgres URL file written by infra/postgres/setup.sh.
 * --reembed recomputes embeddings (needed when the vector dimension changes).
 */
import { readFile } from 'node:fs/promises';
import { PostgresStore } from '../store/postgres-store.js';
import { migrateSnapshot } from '../store/migrate.js';
import { FallbackEmbedder, OpenAIEmbedder, OllamaEmbedder } from '../provider/index.js';
import { loadLocalDatabaseUrl } from './local-db.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const reembed = args.includes('--reembed');
const dry = args.includes('--dry');

if (!file) {
  console.error('usage: npm run migrate -- <snapshot.json> [--reembed] [--dry]');
  process.exit(1);
}

const url = process.env.MINIZEP_DATABASE_URL ?? (await loadLocalDatabaseUrl());
if (!url) {
  console.error('no database configured: set MINIZEP_DATABASE_URL, or run infra/postgres/setup.sh');
  process.exit(1);
}

const dims = Number(process.env.MINIZEP_EMBED_DIMS ?? 1024);
console.log(`target : ${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`dims   : ${dims}${reembed ? ' (re-embedding)' : ''}${dry ? ' [DRY RUN]' : ''}`);

if (dry) {
  const json = await readFile(file, 'utf8');
  const data = JSON.parse(json) as { episodes?: unknown[]; entities?: unknown[]; facts?: unknown[] };
  console.log(
    `would migrate: ${data.episodes?.length ?? 0} episodes, ` +
      `${data.entities?.length ?? 0} entities, ${data.facts?.length ?? 0} facts`,
  );
  process.exit(0);
}

const store = new PostgresStore({ connectionString: url, embeddingDims: dims });
const embedder = reembed
  ? new FallbackEmbedder([
      new OpenAIEmbedder(process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435', process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embed'),
      new OllamaEmbedder(),
    ])
  : undefined;

try {
  const json = await readFile(file, 'utf8');
  const report = await migrateSnapshot(json, store, {
    reembed: embedder,
    onProgress: (m: string) => console.log(`  ${m}`),
  });
  console.log('\nmigration complete');
  console.log(`  episodes : ${report.episodes}`);
  console.log(`  entities : ${report.entities} (${report.mergedEntities.length} merged)`);
  console.log(`  facts    : ${report.facts}${report.skippedFacts.length ? ` (${report.skippedFacts.length} skipped)` : ''}`);
  if (report.reembedded) console.log(`  re-embedded vectors: ${report.reembedded}`);
  if (report.skippedFacts.length) {
    console.log('  skipped facts:');
    for (const f of report.skippedFacts.slice(0, 10)) console.log(`    - ${f}`);
  }
  const health = await store.health();
  console.log(`  store now holds ${health.facts} facts (dims=${health.dims})`);
} finally {
  await store.close();
}
