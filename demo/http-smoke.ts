/**
 * HTTP transport smoke test: real MCP client over Streamable HTTP.
 *
 * Verifies that a bearer token authenticates, that its tools work end to end,
 * and — most importantly — that one token cannot see another token's memories.
 *
 * Run: MINIZEP_TOKENS="tok-a:teamA,tok-b:teamB" npm run serve   (in another shell)
 *      npm run http:smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.MINIZEP_HTTP_URL ?? 'http://127.0.0.1:8787/mcp';
const TOKEN_A = process.env.SMOKE_TOKEN_A ?? 'tok-teamA';
const TOKEN_B = process.env.SMOKE_TOKEN_B ?? 'tok-teamB';

async function connect(token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: 'minizep-http-smoke', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const text = (res: unknown) =>
  ((res as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

console.log('=== auth ===');
try {
  const anon = await connect();
  await anon.listTools();
  console.log('✗ anonymous client was accepted — expected rejection');
  await anon.close();
} catch (err) {
  console.log(`✓ anonymous rejected: ${(err as Error).message.slice(0, 70)}`);
}

console.log('\n=== token A (group teamA) ===');
const a = await connect(TOKEN_A);
const tools = await a.listTools();
console.log(`✓ authenticated, ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`);

console.log('\n--- add_memory (async mode) ---');
const queued = await a.callTool({
  name: 'add_memory',
  // unique per run: identical content is (correctly) de-duplicated, and the
    // job would then report zero new entities in ~20ms without calling the LLM
    arguments: { content: `Team A uses Postgres for storage. (run ${Date.now()})`, async: true },
});
console.log(text(queued));

console.log('\n--- memory_job_status ---');
const jobLine = /queued job ([0-9a-f-]{36})/.exec(text(queued));
if (jobLine) {
  let statusText = '';
  for (let i = 0; i < 30; i++) {
    statusText = text(await a.callTool({ name: 'memory_job_status', arguments: { job_id: jobLine[1] } }));
    if (/status\s+:\s+(succeeded|failed)/.test(statusText)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(statusText);
}

console.log('\n--- search_facts as team A ---');
console.log(text(await a.callTool({ name: 'search_facts', arguments: { query: 'what do we use for storage' } })));

console.log('\n=== token B (group teamB) ===');
const b = await connect(TOKEN_B);
const bHits = text(await b.callTool({ name: 'search_facts', arguments: { query: 'what do we use for storage' } }));
console.log(bHits);
if (/Postgres/i.test(bHits)) {
  console.log('✗ LEAK: team B can see team A memories');
  process.exitCode = 1;
} else {
  console.log('✓ isolation holds: team B cannot see team A memories');
}

console.log('\n--- graph_stats per token ---');
console.log('team A:', text(await a.callTool({ name: 'graph_stats', arguments: {} })).split('\n')[0]);
console.log('team B:', text(await b.callTool({ name: 'graph_stats', arguments: {} })).split('\n')[0]);

await a.close();
await b.close();
console.log('\n✓ done');
