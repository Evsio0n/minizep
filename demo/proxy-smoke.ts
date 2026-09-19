import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const c = new Client({ name: 'proxy-check', version: '1' });
await c.connect(new StdioClientTransport({
  command: 'node', args: ['--import', 'tsx', 'src/server/stdio-proxy.ts'],
  env: { ...process.env, MINIZEP_HTTP_URL: 'http://127.0.0.1:8787/mcp', MINIZEP_TOKEN: 'tok-teamB' },
}));
const tools = await c.listTools();
console.log('✓ 经 stdio 代理拿到工具:', tools.tools.map(t => t.name).join(', '));
const r = await c.callTool({ name: 'search_facts', arguments: { query: 'what do we use for storage' } });
console.log('--- teamB 视角检索（应看不到 teamA 的 Postgres 记录）---');
console.log((r as any).content.map((x: any) => x.text).join('\n'));
const s = await c.callTool({ name: 'graph_stats', arguments: {} });
console.log('--- graph_stats ---');
console.log((s as any).content.map((x: any) => x.text).join('\n').split('\n').slice(0, 4).join('\n'));
await c.close();
