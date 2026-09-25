/**
 * Proves the concurrency test is meaningful: calls the pipeline's internals
 * WITHOUT the mutex (a) and WITH it (b). If (a) does not produce duplicate
 * entities, the test guards nothing.
 *
 * Run: npx tsx demo/probe-race.ts
 */
import { IngestPipeline } from '../src/pipeline/ingest.js';
import { MemoryGraphStore } from '../src/store/memory-store.js';
import { ScriptedLLM, SlowEmbedder, entity } from '../test/helpers.js';

const N = 10;

const makeLLM = () =>
  new ScriptedLLM(
    (content) => ({ entities: [entity('Shared'), entity(`E-${content}`)], facts: [], invalidations: [] }),
    false,
    3,
  );

async function run(label: string, serialise: boolean) {
  const store = new MemoryGraphStore();
  // I/O-like embedder: its await yields at a macrotask boundary, which is
  // what actually lets two pipelines interleave
  const pipeline = new IngestPipeline(store, makeLLM(), new SlowEmbedder(2));
  const call = (i: number) => ({ groupId: 'g', content: `note-${i}` });

  if (serialise) {
    await Promise.all(Array.from({ length: N }, (_, i) => pipeline.addEpisode(call(i))));
  } else {
    // reach past the public API to hit the unserialised code path
    const raw = pipeline as unknown as {
      saveLocked(input: { groupId: string; content: string }, opts: object): Promise<{ episode: unknown }>;
      processLocked(episode: unknown): Promise<unknown>;
    };
    await Promise.all(
      Array.from({ length: N }, async (_, i) => raw.processLocked((await raw.saveLocked(call(i), {})).episode)),
    );
  }

  const entities = await store.getEntities('g');
  const shared = entities.filter((e) => e.name === 'Shared').length;
  console.log(
    `${label.padEnd(26)} entities=${String(entities.length).padStart(3)}  ` +
      `"Shared" copies=${shared}  ${shared === 1 ? '✓ correct' : '✗ DUPLICATED'}`,
  );
  return shared;
}

console.log(`firing ${N} concurrent ingests that all introduce the entity "Shared"\n`);
const withoutMutex = await run('without mutex (raw):', false);
const withMutex = await run('with mutex (public API):', true);

console.log();
if (withoutMutex > 1 && withMutex === 1) {
  console.log(`✓ race reproduced without the mutex (${withoutMutex} copies), fixed by it (1 copy)`);
} else if (withoutMutex === 1) {
  console.log('⚠ the race did not reproduce on this run — the test may be timing-dependent');
} else {
  console.log('✗ unexpected: mutex did not prevent duplication');
}
