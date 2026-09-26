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
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

async function connect(): Promise<Client> {
  const client = new Client({ name: 'minizep-proxy', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
    }),
  );
  return client;
}

let remote: Promise<Client> = connect();
// the server's instructions (how to use the memory) reach this client too
const instructions = (await remote).getInstructions();
log(`connected to ${url}`);

/**
 * Forward one call. The server expires idle sessions (and forgets them when
 * it restarts) and then answers 404: open a new session and send the call
 * again, which is safe because a 404 means it was never handled.
 */
async function forward<T>(call: (client: Client) => Promise<T>): Promise<T> {
  const current = remote;
  const client = await current;
  try {
    return await call(client);
  } catch (err) {
    if (!(err instanceof StreamableHTTPError && err.code === 404)) throw err;
    // concurrent calls that hit the same dead session share one reconnect
    if (remote === current) {
      log('session expired on the server; reconnecting');
      remote = connect();
      void client.close().catch(() => undefined);
    }
    return call(await remote);
  }
}

const server = new Server(
  { name: 'minizep', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions },
);

// Forward verbatim: the HTTP server owns the tool definitions, so this shim
// never needs updating when tools are added.
server.setRequestHandler(ListToolsRequestSchema, () => forward((c) => c.listTools()));
server.setRequestHandler(CallToolRequestSchema, (req) => forward((c) => c.callTool(req.params)));
server.setRequestHandler(ListResourcesRequestSchema, () => forward((c) => c.listResources()));
server.setRequestHandler(ReadResourceRequestSchema, (req) => forward((c) => c.readResource(req.params)));
server.setRequestHandler(ListPromptsRequestSchema, () => forward((c) => c.listPrompts()));
server.setRequestHandler(GetPromptRequestSchema, (req) => forward((c) => c.getPrompt(req.params)));

await server.connect(new StdioServerTransport());
log('stdio bridge ready');

const shutdown = async () => {
  await remote.then((c) => c.close()).catch(() => undefined);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
