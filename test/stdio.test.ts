import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { FilePersistence, Minizep } from '../src/index.js';
import { JobQueue } from '../src/jobs/queue.js';
import type { EpisodicNode } from '../src/model/types.js';
import { MemoryService } from '../src/server/service.js';
import { serveStdio } from '../src/server/stdio.js';
import { INSTRUCTIONS } from '../src/server/tools.js';
import { deterministicEmbedder } from './helpers.js';
import { ControlledLLM, call, startServer, waitFor } from './server-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Client side of a stdio connection over in-memory streams; close() is the client going away. */
class StreamClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly toServer: Writable,
    private readonly fromServer: Readable,
  ) {}

  async start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) this.onmessage?.(m);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}

async function stdioSetup(path: string, opts: { drainTimeoutMs?: number; zep?: Minizep; llm?: ControlledLLM } = {}) {
  const llm = opts.llm ?? new ControlledLLM();
  const zep = opts.zep ?? new Minizep({ llm, embedder: deterministicEmbedder() });
  const persistence = new FilePersistence(path);
  if (!opts.zep) await persistence.load(zep);
  const service = new MemoryService({ zep, jobs: new JobQueue(), persistence });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = await serveStdio({ service, defaultGroup: 'default', stdin, stdout, drainTimeoutMs: opts.drainTimeoutMs });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(new StreamClientTransport(stdin, stdout));
  return { llm, zep, server, client };
}

const snapshotEpisodes = async (path: string) =>
  (JSON.parse(await readFile(path, 'utf8')) as { episodes: EpisodicNode[] }).episodes;

test('stdio: when the client disconnects, queued work finishes and is flushed before shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-stdio-'));
  const path = join(dir, 'graph.json');
  try {
    const { llm, server, client } = await stdioSetup(path);
    llm.hold();
    const queued = await call(client, 'add_memory', { content: 'Alice works at Acme.', async: true });
    assert.equal(queued.structured.status, 'queued');
    // a synchronous call in flight when the client goes away must finish too
    // (it waits behind the queued job: same group)
    const inFlight = call(client, 'add_memory', { content: 'Bob works at Borealis.' }).catch(() => undefined);
    await waitFor(() => llm.calls === 1);

    await client.close(); // stdin ends: this is where the old server exited at once
    let settled = false;
    void server.closed.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false, 'shutdown waits for the queued job');

    llm.release();
    assert.equal(await server.closed, true, 'drained');
    await inFlight;
    const episodes = await snapshotEpisodes(path);
    assert.equal(episodes.length, 2);
    assert.deepEqual(episodes.map((e) => e.status), ['processed', 'processed']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stdio: a drain that times out still flushes, and the next start recovers the pending episode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-stdio-'));
  const path = join(dir, 'graph.json');
  try {
    const first = await stdioSetup(path, { drainTimeoutMs: 30 });
    first.llm.hold();
    const queued = await call(first.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
    await first.client.close();
    assert.equal(await first.server.closed, false, 'timed out');
    const [saved] = await snapshotEpisodes(path);
    assert.equal(saved.uuid, queued.structured.episode_uuid);
    assert.equal(saved.status, 'pending');

    const second = await stdioSetup(path);
    await waitFor(async () => (await second.zep.store.getEpisode(saved.uuid))?.status === 'processed');
    assert.equal(second.llm.calls, 1);
    await second.client.close();
    assert.equal(await second.server.closed, true);
    first.llm.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stdio: the single local user may use any group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-stdio-'));
  try {
    const { client, server } = await stdioSetup(join(dir, 'graph.json'));
    // the shared text, then the groups this connection may use
    assert.ok(client.getInstructions()?.startsWith(INSTRUCTIONS));
    assert.match(client.getInstructions() ?? '', /this connection may use any group; the default is "default"/);
    const r = await call(client, 'add_memory', { content: 'Alice works at Acme.', group_id: 'project-x' });
    assert.equal(r.isError, false);
    assert.equal(r.structured.group_id, 'project-x');
    assert.equal((await call(client, 'graph_stats')).structured.group_id, 'default');
    await client.close();
    await server.closed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stdio proxy: forwards the instructions and every tool of the HTTP server under the token\'s groups, and survives session expiry', async () => {
  const srv = await startServer({ sessionTtlMs: 150 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(ROOT, 'src', 'server', 'stdio-proxy.ts')],
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), MINIZEP_HTTP_URL: `${srv.base}/mcp`, MINIZEP_TOKEN: 'tokA' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'proxy-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  try {
    await client.connect(transport);
    assert.ok(client.getInstructions()?.startsWith(INSTRUCTIONS));
    assert.match(client.getInstructions() ?? '', /Groups this connection may use: teamA \(default\)\./);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const tool of ['add_memory', 'get_episode', 'invalidate_fact', 'reopen_fact', 'forget_episode', 'retry_failed', 'facts_at', 'memory_guide']) {
      assert.ok(names.includes(tool), `${tool} is forwarded`);
    }
    assert.equal(tools.find((t) => t.name === 'forget_episode')?.annotations?.destructiveHint, true, 'with its annotations');

    const added = await call(client, 'add_memory', { content: 'Alice works at Acme.' });
    assert.equal(added.structured.status, 'processed');
    assert.equal(added.structured.group_id, 'teamA');
    const foreign = await call(client, 'list_episodes', { group_id: 'teamB' });
    assert.equal(foreign.isError, true);
    assert.match(foreign.text, /group not permitted/);

    // the server forgets the idle session; the proxy opens a new one transparently
    await new Promise((r) => setTimeout(r, 300));
    const found = await call(client, 'search_facts', { query: 'Alice' });
    assert.match(found.text, /Alice --WORKS_AT--> Acme/);
    assert.match(stderr, /session expired on the server; reconnecting/);
  } finally {
    await client.close();
    await srv.close();
  }
});
