import { Minizep, OllamaEmbedder, OpenAIEmbedder, FallbackEmbedder } from '../src/index.js';

// 真实语义 embedding，优先使用集群上跑在 V100 上的 llama.cpp（OpenAI 兼容
// /v1/embeddings，本地 11435），其次 ollama（11434），都不可用则降级 hashEmbed。
// 端点由 MINIZEP_EMBED_URL 指定。降级到 hash 必须显式开启（allowHash），
// 服务端不开：hash 向量与模型向量不在同一个空间。
const embedder = new FallbackEmbedder(
  [
    new OpenAIEmbedder((process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435'), 'qwen3-embed'),
    new OllamaEmbedder(),
  ],
  { allowHash: true },
);
const zep = new Minizep({ embedder });

console.log('=== 1. 摄取：Alice 加入 Acme ===');
await zep.ingest.addEpisode({
  groupId: 'demo',
  content: 'Alice works at Acme. Alice likes Bob.',
});

console.log('\n=== 2. 摄取：矛盾信息 —— Alice 离开 Acme ===');
await zep.ingest.addEpisode({
  groupId: 'demo',
  content: 'Alice left Acme.',
});

console.log('\n--- 当前活跃事实 (what is true NOW) ---');
for (const f of await zep.factsAbout('Alice', { groupId: 'demo' })) {
  console.log(
    `  [${f.fact.name}] ${f.sourceName} -> ${f.targetName} | "${f.fact.fact}" | valid: ${f.fact.validAt?.toISOString().slice(0, 10)}`,
  );
}

console.log('\n--- 含历史 (includeHistorical: 被 supersede 的事实也可见) ---');
for (const f of await zep.factsAbout('Alice', { groupId: 'demo', includeHistorical: true })) {
  console.log(
    `  [${f.fact.name}] "${f.fact.fact}" | expiredAt: ${f.fact.expiredAt?.toISOString().slice(0, 10) ?? '-'} invalidAt: ${f.fact.invalidAt?.toISOString().slice(0, 10) ?? '-'}`,
  );
}

console.log('\n=== 3. 时间旅行 ===');
// 摄取一条更早的事实：去年 Alice 在 StartupCo
await zep.ingest.addEpisode({
  groupId: 'demo',
  content: 'Alice works at StartupCo.',
  validAt: new Date('2024-01-15'),
});
const mid2024 = new Date('2024-06-01');
console.log(`--- 2024-06-01 时，Alice 的状态 ---`);
for (const f of await zep.factsAt(mid2024, 'demo')) {
  console.log(`  ${f.sourceName} --${f.fact.name}--> ${f.targetName}  (learned: ${f.fact.createdAt.toISOString().slice(0, 10)})`);
}

console.log('\n=== 4. 混合检索 (BM25 + cosine + RRF) ===');
console.log(`  embedder tier: ${(await embedder.embedTraced('探活')).tier}`);
for (const q of ['Alice Acme work', '职业 工作 employer', 'who likes whom']) {
  console.log(`  -- query: "${q}"`);
  for (const r of await zep.searchFacts(q, { groupId: 'demo' })) {
    console.log(`     ${r.sourceName} --${r.fact.name}--> ${r.targetName} | "${r.fact.fact}"`);
  }
}

console.log('\n=== 5. 持久化快照 (前 40 行) ===');
const snap = zep.snapshot();
console.log(snap.split('\n').slice(0, 40).join('\n'), '\n... (truncated)');

console.log('\n=== 6. 快照重载 ===');
const zep2 = new Minizep();
zep2.load(snap);
console.log(
  `  重载后: ${(await zep2.store.getEntities()).length} 实体, ${(await zep2.store.getFacts()).length} 事实, ` +
    `${(await zep2.store.getEpisodes()).length} episodes`,
);
