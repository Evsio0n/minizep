/**
 * End-to-end with real providers:
 *   LLM (extraction) → DeepSeek API  (deepseek-flash)
 *   Embeddings       → llama.cpp on V100 (Qwen3-Embedding-0.6B, sm70 CUDA)
 *   Fallbacks        → ollama → hashEmbed
 */
import {
  Minizep,
  OpenAIEmbedder,
  OllamaEmbedder,
  FallbackEmbedder,
  OpenAICompatLLM,
  loadLLMConfig,
} from '../src/index.js';

const llmCfg = await loadLLMConfig(); // deepseek from ~/.openclaw/openclaw.json
console.log(`LLM: ${llmCfg.model} @ ${llmCfg.baseUrl}`);

const embedder = new FallbackEmbedder([
  new OpenAIEmbedder((process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435'), 'qwen3-embed'), // llama.cpp on V100
  new OllamaEmbedder(),
]);

const zep = new Minizep({ llm: new OpenAICompatLLM(llmCfg), embedder });

console.log(`\n=== ingest #1 (real LLM extraction) ===`);
let t0 = performance.now();
await zep.ingest.addEpisode({
  groupId: 'real',
  content:
    'Alice works at Acme as a staff engineer. She likes Bob, her teammate. ' +
    'Bob joined Globex in 2024.',
});
console.log(`  took ${((performance.now() - t0) / 1000).toFixed(1)}s`);

console.log(`\n=== ingest #2 (contradiction: Alice left Acme) ===`);
t0 = performance.now();
await zep.ingest.addEpisode({
  groupId: 'real',
  content: 'Alice left Acme last month.',
});
console.log(`  took ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const show = (rows: ReturnType<typeof zep.factsAbout>, title: string) => {
  console.log(`\n--- ${title} ---`);
  for (const r of rows) {
    const f = r.fact;
    const win = [
      f.validAt ? `valid ${f.validAt.toISOString().slice(0, 10)}` : null,
      f.invalidAt ? `invalid ${f.invalidAt.toISOString().slice(0, 10)}` : null,
      f.expiredAt ? `expired ${f.expiredAt.toISOString().slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`  [${f.name}] ${r.sourceName} -> ${r.targetName}  (${win || 'always'})`);
    console.log(`      "${f.fact}"`);
  }
};

show(await zep.factsAbout('Alice', { groupId: 'real' }), '当前活跃事实 (NOW)');
show(await zep.factsAbout('Alice', { groupId: 'real', includeHistorical: true }), '含历史 (superseded 保留)');

console.log('\n--- entities ---');
for (const e of await zep.store.getEntities('real')) {
  console.log(`  ${e.name} [${e.labels.join(',')}] — ${e.summary.slice(0, 70)}`);
}

console.log(`\n--- episodes (provenance) ---`);
for (const ep of await zep.store.getEpisodes('real')) {
  console.log(`  ${ep.uuid.slice(0, 8)}: ${ep.content.slice(0, 60)}`);
}

console.log(`\n--- hybrid search (BM25 + cosine + RRF) ---`);
for (const q of ['where does Alice work', '职业 雇主', 'who is Bob']) {
  const hits = await zep.searchFacts(q, { groupId: 'real' });
  console.log(`  query "${q}" → ${hits.map((h) => `${h.sourceName}-${h.fact.name}->${h.targetName}`).join(', ') || '(no hit)'}`);
}
