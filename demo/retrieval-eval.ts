/**
 * Offline retrieval evaluation against a real graph and a gold file.
 *
 *   MINIZEP_EMBED_URL=http://<embedder> npx tsx demo/retrieval-eval.ts <graph.json> <gold.json> [--verbose]
 *
 * graph.json holds one GET /v1/graph?group_id=<g>&history=true&isolated=true
 * body per group, keyed by group id: { "<group>": { "nodes": [...], "edges": [...] } }.
 * The graph is rebuilt in an in-memory store (entities, and facts with their
 * valid/invalid/created/expired times), names and facts are embedded with the
 * configured embedder (OpenAIEmbedder at MINIZEP_EMBED_URL, model
 * MINIZEP_EMBED_MODEL), and every gold query runs through searchFactsDetailed.
 *
 * gold.json: { "queries": [ { "group", "q", "at"?, "as_of"?, "k"? (default 5),
 *   "expect"?: [substring of a fact text that must be in the top k],
 *   "forbid"?: [substring that must not be in the top k],
 *   "expect_empty"?: true (nothing may be returned) } ] }
 *
 * Prints per query whether it passed, where each expected fact ranks when it
 * missed the top k (among the first 50 results), and the returned facts with
 * their scores for the failures (for every query with --verbose); then hit@k,
 * forbidden-in-top-k and expect_empty totals. Holds no data itself.
 */
import { readFileSync } from 'node:fs';
import { Minizep, MemoryGraphStore, OpenAIEmbedder } from '../src/index.js';
import type { EntityEdge, EntityNode } from '../src/model/types.js';

interface GraphExport {
  nodes: Array<{ uuid: string; name: string; labels?: string[]; summary?: string; created_at: string }>;
  edges: Array<{
    uuid: string;
    relation: string;
    source_uuid: string;
    target_uuid: string;
    fact: string;
    valid_at: string | null;
    invalid_at: string | null;
    created_at: string;
    expired_at: string | null;
    episodes?: string[];
  }>;
}

interface GoldQuery {
  group: string;
  q: string;
  at?: string;
  as_of?: string;
  k?: number;
  expect?: string[];
  forbid?: string[];
  expect_empty?: boolean;
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const [graphPath, goldPath] = args.filter((a) => !a.startsWith('--'));
if (!graphPath || !goldPath) {
  console.error('usage: tsx demo/retrieval-eval.ts <graph.json> <gold.json> [--verbose]');
  process.exit(2);
}
const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Record<string, GraphExport>;
const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as { queries: GoldQuery[] };

const embedder = new OpenAIEmbedder(
  process.env.MINIZEP_EMBED_URL ?? 'http://127.0.0.1:11435',
  process.env.MINIZEP_EMBED_MODEL ?? 'qwen3-embed',
);
const date = (s: string | null | undefined) => (s ? new Date(s) : undefined);

/** Embed many texts in batches, keeping their order. */
async function embedAll(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) out.push(...(await embedder.embedBatch(texts.slice(i, i + 32))));
  return out;
}

// ---- rebuild the graph ----
const store = new MemoryGraphStore();
let entityCount = 0;
let factCount = 0;
for (const [groupId, g] of Object.entries(graph)) {
  const names = await embedAll(g.nodes.map((n) => n.name));
  for (const [i, n] of g.nodes.entries()) {
    const node: EntityNode = {
      type: 'entity',
      uuid: n.uuid,
      groupId,
      name: n.name,
      labels: n.labels ?? [],
      summary: n.summary ?? '',
      nameEmbedding: names[i],
      attributes: {},
      createdAt: new Date(n.created_at),
    };
    await store.upsertEntity(node);
    entityCount++;
  }
  const texts = await embedAll(g.edges.map((e) => e.fact));
  for (const [i, e] of g.edges.entries()) {
    const edge: EntityEdge = {
      type: 'fact',
      uuid: e.uuid,
      groupId,
      sourceNodeUuid: e.source_uuid,
      targetNodeUuid: e.target_uuid,
      name: e.relation,
      fact: e.fact,
      factEmbedding: texts[i],
      episodes: e.episodes ?? [],
      validAt: date(e.valid_at),
      invalidAt: date(e.invalid_at),
      createdAt: new Date(e.created_at),
      expiredAt: date(e.expired_at),
      attributes: {},
    };
    await store.addFact(edge);
    factCount++;
  }
}
const zep = new Minizep({ store, embedder });
console.log(`graph: ${Object.keys(graph).length} groups, ${entityCount} entities, ${factCount} facts`);

// ---- run the queries ----
let passed = 0;
let expected = 0;
let found = 0;
let forbidden = 0;
let emptyWanted = 0;
let emptyGot = 0;
for (const [i, g] of gold.queries.entries()) {
  const k = g.k ?? 5;
  // a deeper list, to say where a missed fact ranks; its first k are the top k
  const deep = await zep.searchFactsDetailed(g.q, {
    groupId: g.group,
    limit: Math.max(k, 50),
    at: date(g.at),
    asOf: date(g.as_of),
  });
  const { degraded } = deep;
  const results = deep.results.slice(0, k);
  const rankOf = (s: string) => deep.results.findIndex((r) => r.fact.fact.includes(s)) + 1;
  const texts = results.map((r) => r.fact.fact);
  const has = (s: string) => texts.some((t) => t.includes(s));
  const missing = (g.expect ?? []).filter((s) => !has(s));
  const leaked = (g.forbid ?? []).filter(has);
  const emptyOk = !g.expect_empty || results.length === 0;
  const ok = missing.length === 0 && leaked.length === 0 && emptyOk;

  expected += g.expect?.length ?? 0;
  found += (g.expect?.length ?? 0) - missing.length;
  forbidden += leaked.length;
  if (g.expect_empty) {
    emptyWanted++;
    if (results.length === 0) emptyGot++;
  }
  if (ok) passed++;

  const notes = [
    g.expect?.length ? `expect ${g.expect.length - missing.length}/${g.expect.length}` : null,
    g.forbid?.length ? `forbidden ${leaked.length}` : null,
    g.expect_empty ? `empty ${results.length === 0 ? 'yes' : `no (${results.length})`}` : null,
    degraded ? 'DEGRADED' : null,
  ].filter(Boolean);
  console.log(`\n#${i + 1} ${ok ? 'PASS' : 'FAIL'} [${g.group}] k=${k} at=${g.at ?? 'now'}  ${g.q}`);
  console.log(`   ${notes.join(', ')}`);
  for (const s of missing) console.log(`   missing:   ${s}  (${rankOf(s) ? `rank ${rankOf(s)}` : 'not returned'})`);
  for (const s of leaked) console.log(`   forbidden: ${s}`);
  if (!ok || verbose) {
    for (const [rank, r] of results.entries()) {
      console.log(`   ${rank + 1}. ${(r.score ?? 0).toFixed(4)}  ${r.fact.fact}`);
    }
  }
}

console.log('\n==== totals ====');
console.log(`queries passed        ${passed}/${gold.queries.length}`);
console.log(`hit@k (expect found)  ${found}/${expected}`);
console.log(`forbidden in top k    ${forbidden}`);
console.log(`expect_empty met      ${emptyGot}/${emptyWanted}`);
