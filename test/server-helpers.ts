/**
 * In-process servers for tests: the HTTP app on an ephemeral loopback port and
 * MCP clients talking to it, with offline providers only.
 */
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Minizep, MockLLMProvider } from '../src/index.js';
import type { GraphStore } from '../src/store/memory-store.js';
import type {
  ContradictionCandidate,
  ContradictionExisting,
  ExtractionResult,
  ExtractOptions,
  KnownFact,
  LLMProvider,
} from '../src/provider/interfaces.js';
import { createHttpApp, type HttpApp, type HttpAppOptions } from '../src/server/app.js';
import { parseTokens } from '../src/server/auth.js';
import { deterministicEmbedder } from './helpers.js';

export const TOKENS = 'tokA:teamA,tokB:teamB,tokC:teamC|shared';

/**
 * The rule-based mock extractor ("Alice works at Acme"), plus switches a test
 * can flip: fail like an LLM answering HTTP 500, or hold every call until
 * released (to observe queued and in-flight work).
 */
export class ControlledLLM implements LLMProvider {
  private readonly inner = new MockLLMProvider();
  failWith: string | null = null;
  calls = 0;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  hold(): void {
    this.gate ??= new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async extract(
    content: string,
    known: string[],
    knownFacts?: KnownFact[],
    options?: ExtractOptions,
  ): Promise<ExtractionResult> {
    this.calls++;
    if (this.gate) await this.gate;
    await new Promise((r) => setTimeout(r, 1));
    if (this.failWith) throw new Error(this.failWith);
    return this.inner.extract(content, known, knownFacts, options);
  }

  detectContradiction(candidate: ContradictionCandidate, existing: ContradictionExisting[]): Promise<number[]> {
    return this.inner.detectContradiction(candidate, existing);
  }
}

export interface TestServer {
  app: HttpApp;
  zep: Minizep;
  llm: ControlledLLM;
  base: string;
  close(): Promise<void>;
}

/** The HTTP app on 127.0.0.1:<ephemeral>, with TOKENS and offline providers. */
export async function startServer(
  opts: Partial<HttpAppOptions> & { store?: GraphStore; llm?: ControlledLLM } = {},
): Promise<TestServer> {
  const { store, llm: givenLlm, ...appOpts } = opts;
  const llm = givenLlm ?? new ControlledLLM();
  const zep = opts.zep ?? new Minizep({ store, llm, embedder: deterministicEmbedder() });
  const app = createHttpApp({ tokens: parseTokens(TOKENS), ...appOpts, zep });
  const [addr] = await app.listen(['127.0.0.1'], 0);
  return {
    app,
    zep,
    llm,
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      llm.release();
      await app.close({ drainTimeoutMs: 5000 });
    },
  };
}

export async function connect(
  base: string,
  token?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: 'minizep-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

export interface ToolResult {
  text: string;
  isError: boolean;
  structured: Record<string, any>;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  return {
    text: (res.content ?? []).map((c) => c.text ?? '').join('\n'),
    isError: res.isError === true,
    structured: (res.structuredContent ?? {}) as Record<string, any>,
  };
}

/** One raw JSON-RPC request to /mcp, for checks the SDK client would hide. */
export async function rawMcp(
  base: string,
  token: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** JSON request to the REST API. */
export async function api(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined || opts.rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body, headers: res.headers };
}

/**
 * One request with exactly these headers (fetch does not let a test choose
 * Host), answering the status and the parsed JSON body (or the text).
 */
export function rawRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: any }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON: keep the text
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Poll until `check` holds (or fail after `timeoutMs`). */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
