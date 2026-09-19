/**
 * MCP smoke test: spawns the minizep MCP server over stdio like a real client
 * (Claude Code / Cursor would), then exercises the tools.
 *
 * Run: npm run mcp:smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'src', 'server', 'mcp.ts');
const dbPath = join(tmpdir(), `minizep-smoke-${Date.now()}.json`);

const transport = new StdioClientTransport({
  command: 'node',
  args: ['--import', 'tsx', serverPath],
  env: { ...process.env, MINIZEP_DB: dbPath },
});

const client = new Client({ name: 'minizep-smoke', version: '0.1.0' });
await client.connect(transport);
console.log('✓ connected to MCP server\n');

const tools = await client.listTools();
console.log(`✓ tools exposed (${tools.tools.length}):`);
for (const t of tools.tools) console.log(`    - ${t.name}: ${t.description?.split('.')[0]}`);

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');
  return text;
};

console.log('\n--- add_memory #1 ---');
console.log(await call('add_memory', {
  content: 'Alice works at Acme as a staff engineer. She likes Bob, her teammate.',
  group_id: 'smoke',
}));

console.log('\n--- add_memory #2 (termination) ---');
console.log(await call('add_memory', {
  content: 'Alice left Acme last month.',
  group_id: 'smoke',
}));

console.log('\n--- search_facts: "where does Alice work" ---');
console.log(await call('search_facts', { query: 'where does Alice work', group_id: 'smoke' }));

console.log('\n--- facts_about Alice (current only) ---');
console.log(await call('facts_about', { entity: 'Alice', group_id: 'smoke' }));

console.log('\n--- facts_about Alice (include_historical) ---');
console.log(await call('facts_about', { entity: 'Alice', group_id: 'smoke', include_historical: true }));

console.log('\n--- graph_stats ---');
console.log(await call('graph_stats', {}));

const usingPostgres = Boolean(process.env.MINIZEP_DATABASE_URL);
if (usingPostgres) {
  console.log('\n--- persistence: Postgres backend (no JSON snapshot expected) ---');
  console.log('✓ state lives in the database; see graph_stats above');
} else {
  console.log('\n--- persistence: snapshot file ---');
  const { readFile, stat } = await import('node:fs/promises');
  try {
    const st = await stat(dbPath);
    const parsed = JSON.parse(await readFile(dbPath, 'utf8'));
    console.log(`✓ ${dbPath} (${st.size} bytes) — episodes=${parsed.episodes.length} entities=${parsed.entities.length} facts=${parsed.facts.length}`);
  } catch (e) {
    console.log(`✗ snapshot not written: ${(e as Error).message}`);
  }
}

await client.close();
await rm(dbPath, { force: true });
console.log('\n✓ closed cleanly');
