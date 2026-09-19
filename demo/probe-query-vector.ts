/** Regression demonstration for the query-vector bug (now fixed): queries used
 *  to be embedded with hashEmbed (256d) while facts used the configured
 *  embedder (Qwen3, 1024d), so cosine scores were noise. Re-run this whenever
 *  the embedding path changes — the correct score must stay well above the
 *  mismatched one. */
import { hashEmbed, cosineSimilarity } from '../src/search/retrieval.js';
import { OpenAIEmbedder } from '../src/provider/openai-embedder.js';

const real = new OpenAIEmbedder((process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435'), 'qwen3-embed');
const fact = 'Alice --WORKS_AT--> Acme';
const query = 'where does Alice work';

const factVec = await real.embed(fact);
const goodQueryVec = await real.embed(query);
const hashQueryVec = hashEmbed(query);

console.log('fact vector dims       :', factVec.length);
console.log('real query vector dims :', goodQueryVec.length);
console.log('hash query vector dims :', hashQueryVec.length, '  (旧 bug 用的就是这个)');
console.log();
console.log('余弦 [正确: 同一模型]  :', cosineSimilarity(factVec, goodQueryVec).toFixed(4));
console.log('余弦 [当前代码: hash]  :', cosineSimilarity(factVec, hashQueryVec).toFixed(4), ' ← 不匹配空间的噪声');
console.log();
const unrelated = await real.embed('Bob --LIKES--> Pizza');
console.log('对照·无关事实[正确模型]:', cosineSimilarity(unrelated, goodQueryVec).toFixed(4), ' ← 明显低于正确值');
