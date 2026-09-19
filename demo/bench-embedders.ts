/**
 * Fair benchmark: ollama vs llama.cpp, same weights (Qwen3-Embedding-0.6B),
 * same texts, both via SSH tunnels.
 *
 *   ollama    → 127.0.0.1:11434  (CPU: ollama ships no SM70 kernels)
 *   llama.cpp → 127.0.0.1:11435  (GPU: CUDA sm70 built from source)
 *
 * Methodology: explicit warm-up excluded from timing; both engines get
 * single-string latency AND one 50-input batch call.
 */
const TEXTS = [
  'Alice works at Acme',
  '爱丽丝在 Acme 公司工作',
  'Bob joined the team in 2024',
  'qwen3-embedding latency comparison',
];

const BATCH: string[] = [];
for (let i = 0; i < 50; i++) BATCH.push(`fact ${i}: entity-${i % 9} relates to entity-${(i + 3) % 9}`);

interface Engine {
  name: string;
  url: string;
  /** request body builder for a list of inputs */
  body: (inputs: string[]) => unknown;
  /** response parser → vectors */
  parse: (json: any) => number[][];
}

const ollama: Engine = {
  name: 'ollama    (CPU backend)',
  url: 'http://127.0.0.1:11434/api/embed',
  body: (inputs) => ({ model: 'qwen3-embedding:0.6b', input: inputs }),
  parse: (j) => j.embeddings,
};

const llamacpp: Engine = {
  name: 'llama.cpp (GPU backend)',
  url: 'http://127.0.0.1:11435/v1/embeddings',
  body: (inputs) => ({ model: 'qwen3-embed', input: inputs }),
  parse: (j) => j.data.map((d: any) => d.embedding),
};

async function call(e: Engine, inputs: string[]): Promise<number[][]> {
  const res = await fetch(e.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(e.body(inputs)),
  });
  if (!res.ok) throw new Error(`${e.name} HTTP ${res.status}`);
  return e.parse(await res.json());
}

async function bench(e: Engine) {
  // warm-up (excluded from timing)
  await call(e, ['warm up the model']);
  await call(e, ['warm up again']);

  // 1. single-string latency, sequential
  const n = 10;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await call(e, [TEXTS[i % TEXTS.length]]);
  const single = (performance.now() - t0) / n;

  // 2. one 50-input batch
  const t1 = performance.now();
  const vecs = await call(e, BATCH);
  const batch = performance.now() - t1;

  // 3. correctness: same input gives same vector as the other engine
  const probe = await call(e, ['Alice works at Acme']);
  return { single, batch, dims: vecs.length === 50 ? vecs[0].length : -1, head: probe[0].slice(0, 3) };
}

const results: Record<string, Awaited<ReturnType<typeof bench>>> = {};
for (const e of [ollama, llamacpp]) {
  try {
    results[e.name] = await bench(e);
  } catch (err) {
    console.log(`${e.name}: FAILED — ${(err as Error).message}`);
  }
}

console.log('\n=== results ===');
for (const [name, r] of Object.entries(results)) {
  console.log(`${name}`);
  console.log(`  single: ${r.single.toFixed(1)} ms/req   batch(50): ${r.batch.toFixed(0)} ms   dims: ${r.dims}`);
  console.log(`  head sample: [${r.head.map((x) => x.toFixed(4)).join(', ')}]`);
}

const names = Object.keys(results);
if (names.length === 2) {
  const [a, b] = names.map((n) => results[n]);
  console.log(`\nspeedup (GPU vs CPU): single ${(a.single / b.single).toFixed(2)}x, batch ${(a.batch / b.batch).toFixed(2)}x`);
}
