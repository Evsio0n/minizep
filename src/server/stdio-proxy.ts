#!/usr/bin/env node
/**
 * stdio ↔ HTTP bridge.
 *
 * Some MCP clients only speak stdio. Rather than running a second graph in that
 * process, this shim forwards every request to the shared HTTP server — so all
 * clients see the same memories, with the token deciding the namespace.
 *
 *   MINIZEP_HTTP_URL=http://127.0.0.1:8787/mcp MINIZEP_TOKEN=tokA npm run mcp:proxy
 *
 * Client config:
 *   { "command": "node", "args": ["dist/server/stdio-proxy.js"],
 *     "env": { "MINIZEP_HTTP_URL": "...", "MINIZEP_TOKEN": "..." } }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const url = process.env.MINIZEP_HTTP_URL ?? 'http://127.0.0.1:8787/mcp';
const token = process.env.MINIZEP_TOKEN;
if (!token && process.env.MINIZEP_ALLOW_ANONYMOUS !== '1') {
  console.error('[minizep-proxy] refusing to start without MINIZEP_TOKEN');
  process.exit(1);
}

const log = (...args: unknown[]) => console.error('[minizep-proxy]', ...args);

const remote = new Client({ name: 'minizep-proxy', version: '1.0.0' });
await remote.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  }),
);
log(`connected to ${url}`);

const server = new Server(
  { name: 'minizep', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// Forward verbatim: the HTTP server owns the tool definitions, so this shim
// never needs updating when tools are added.
server.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
server.setRequestHandler(CallToolRequestSchema, (req) => remote.callTool(req.params));
server.setRequestHandler(ListResourcesRequestSchema, () => remote.listResources());
server.setRequestHandler(ReadResourceRequestSchema, (req) => remote.readResource(req.params));
server.setRequestHandler(ListPromptsRequestSchema, () => remote.listPrompts());
server.setRequestHandler(GetPromptRequestSchema, (req) => remote.getPrompt(req.params));

await server.connect(new StdioServerTransport());
log('stdio bridge ready');

const shutdown = async () => {
  await remote.close();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
