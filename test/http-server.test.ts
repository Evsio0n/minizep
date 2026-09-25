import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FilePersistence, Minizep } from '../src/index.js';
import { MemoryGraphStore, type GraphStore } from '../src/store/memory-store.js';
import { PostgresStore } from '../src/store/postgres-store.js';
import type { EpisodicNode } from '../src/model/types.js';
import { ScriptedLLM, deterministicEmbedder, entity, fact } from './helpers.js';
import { parseUiHosts, uiFromEnv } from '../src/server/ui.js';
import { ControlledLLM, api, call, connect, rawMcp, rawRequest, startServer, waitFor } from './server-helpers.js';

const DAY = 86_400_000;

/* ================================================================
 * Tenant isolation (C1): each case was reproduced against the old server
 * ================================================================ */

test('security: a token cannot read another group\'s episodes through group_id', async () => {
  const srv = await startServer();
  try {
    const b = await connect(srv.base, 'tokB');
    await call(b.client, 'add_memory', { content: 'Bob works at Borealis. Secret launch plan.' });
    const a = await connect(srv.base, 'tokA');

    const r = await call(a.client, 'list_episodes', { group_id: 'teamB' });
    assert.equal(r.isError, true, 'reading a foreign group must be a tool error');
    assert.match(r.text, /group not permitted for this token/);
    assert.doesNotMatch(r.text, /Secret launch plan/);
    // and the token's own view is empty
    assert.match((await call(a.client, 'list_episodes')).text, /no episodes/);
  } finally {
    await srv.close();
  }
});

test('security: a token cannot write into another group through group_id', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    const r = await call(a.client, 'add_memory', { content: 'Mallory works at Borealis.', group_id: 'teamB' });
    assert.equal(r.isError, true);
    assert.match(r.text, /group not permitted for this token/);
    assert.equal((await srv.zep.store.getEpisodes('teamB')).length, 0, 'nothing may be written into team B');
    assert.equal(srv.llm.calls, 0, 'the refused request must not reach the LLM');
  } finally {
    await srv.close();
  }
});

test('security: a session is bound to its token (token A + team B\'s session id is refused)', async () => {
  const srv = await startServer();
  try {
    const b = await connect(srv.base, 'tokB');
    await call(b.client, 'add_memory', { content: 'Bob works at Borealis.' });
    const bSession = b.transport.sessionId!;
    assert.ok(bSession);

    const hijack = await rawMcp(srv.base, 'tokA', bSession, 'tools/call', { name: 'list_episodes', arguments: {} });
    assert.equal(hijack.status, 403);
    const body = await hijack.text();
    assert.match(body, /session belongs to another token/);
    assert.doesNotMatch(body, /Borealis/);

    // the rightful owner is unaffected
    assert.match((await call(b.client, 'list_episodes')).text, /Borealis/);
  } finally {
    await srv.close();
  }
});

/** Minimal valid arguments for each tool that takes a group_id. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  add_memory: { content: 'Eve works at Borealis.' },
  search_facts: { query: 'Borealis' },
  facts_about: { entity: 'Bob' },
  facts_at: {},
  list_entities: {},
  list_episodes: {},
  get_episode: { id: '00000000' },
  invalidate_fact: { uuid: '00000000', reason: 'test' },
  retry_failed: {},
  graph_stats: {},
};

test('security: every tool that takes group_id refuses a group the token does not hold', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    const tools = (await a.client.listTools()).tools;
    const grouped = tools
      .filter((t) => Object.hasOwn((t.inputSchema.properties ?? {}) as object, 'group_id'))
      .map((t) => t.name);
    assert.deepEqual(grouped.sort(), Object.keys(MINIMAL_ARGS).sort(), 'every group-taking tool is covered here');
    for (const name of grouped) {
      const r = await call(a.client, name, { ...MINIMAL_ARGS[name], group_id: 'teamB' });
      assert.equal(r.isError, true, `${name} must refuse team B`);
      assert.match(r.text, /group not permitted for this token/, name);
    }
    assert.equal((await srv.zep.store.getEpisodes()).length, 0);
  } finally {
    await srv.close();
  }
});

test('security: a token with several groups defaults to the first and may name the others', async () => {
  const srv = await startServer();
  try {
    const c = await connect(srv.base, 'tokC');
    const own = await call(c.client, 'add_memory', { content: 'Carol works at Cyan.' });
    assert.equal(own.structured.group_id, 'teamC');
    const shared = await call(c.client, 'add_memory', { content: 'Dan works at Delta.', group_id: 'shared' });
    assert.equal(shared.isError, false);
    assert.equal(shared.structured.group_id, 'shared');
    assert.equal((await call(c.client, 'list_episodes', { group_id: 'teamA' })).isError, true);
    assert.equal((await srv.zep.store.getEpisodes('shared')).length, 1);
  } finally {
    await srv.close();
  }
});

test('security: async jobs are only visible to the groups they belong to', async () => {
  const srv = await startServer();
  try {
    const b = await connect(srv.base, 'tokB');
    const queued = await call(b.client, 'add_memory', { content: 'Bob works at Borealis.', async: true });
    const jobId = queued.structured.job_id as string;
    await srv.app.jobs.drain();

    const a = await connect(srv.base, 'tokA');
    const peek = await call(a.client, 'memory_job_status', { job_id: jobId });
    assert.equal(peek.isError, true);
    assert.match(peek.text, /job not found/);
    assert.match((await call(a.client, 'memory_job_status')).text, /no jobs/);
    assert.match((await call(b.client, 'memory_job_status', { job_id: jobId })).text, /status\s+: succeeded/);
    // the short id the listing shows works too
    assert.equal((await call(b.client, 'memory_job_status', { job_id: jobId.slice(0, 8) })).isError, false);
  } finally {
    await srv.close();
  }
});

test('security: /health says only ok; details need a token', async () => {
  const srv = await startServer({ storeLabel: 'memory', llmLabel: 'mock' });
  try {
    const health = await api(srv.base, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });

    assert.equal((await api(srv.base, 'GET', '/v1/status')).status, 401);
    assert.equal((await api(srv.base, 'GET', '/v1/status', { token: 'nope' })).status, 403);
    const status = await api(srv.base, 'GET', '/v1/status', { token: 'tokA' });
    assert.equal(status.status, 200);
    assert.equal(status.body.store, 'memory');
    assert.equal(status.body.llm, 'mock');
    assert.deepEqual(status.body.groups, ['teamA']);
  } finally {
    await srv.close();
  }
});

test('security: /mcp refuses missing and unknown tokens', async () => {
  const srv = await startServer();
  try {
    await assert.rejects(connect(srv.base), (err: unknown) => (err as StreamableHTTPError).code === 401);
    await assert.rejects(connect(srv.base, 'tokZ'), (err: unknown) => (err as StreamableHTTPError).code === 403);
  } finally {
    await srv.close();
  }
});

test('sessions: an unknown session id is 404 and a request without one must be initialize', async () => {
  const srv = await startServer();
  try {
    const unknown = await rawMcp(srv.base, 'tokA', crypto.randomUUID(), 'tools/list', {});
    assert.equal(unknown.status, 404);
    const noSession = await fetch(`${srv.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tokA',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(noSession.status, 400);
    assert.equal(srv.app.sessions.size, 0, 'a refused request must not leave a session behind');
  } finally {
    await srv.close();
  }
});

test('sessions: an idle session expires after the TTL; the client can start a new one', async () => {
  const srv = await startServer({ sessionTtlMs: 50 });
  try {
    const a = await connect(srv.base, 'tokA');
    assert.equal((await call(a.client, 'graph_stats')).isError, false);
    await new Promise((r) => setTimeout(r, 120));
    await assert.rejects(call(a.client, 'graph_stats'), (err: unknown) => (err as StreamableHTTPError).code === 404);
    const again = await connect(srv.base, 'tokA');
    assert.equal((await call(again.client, 'graph_stats')).isError, false);
  } finally {
    await srv.close();
  }
});

test('sessions: the cap evicts the longest idle session', async () => {
  const srv = await startServer({ maxSessions: 2 });
  try {
    const first = await connect(srv.base, 'tokA');
    await new Promise((r) => setTimeout(r, 5));
    const second = await connect(srv.base, 'tokB');
    await new Promise((r) => setTimeout(r, 5));
    const third = await connect(srv.base, 'tokA');
    assert.equal(srv.app.sessions.size, 2);
    await assert.rejects(call(first.client, 'graph_stats'), (err: unknown) => (err as StreamableHTTPError).code === 404);
    assert.equal((await call(second.client, 'graph_stats')).isError, false);
    assert.equal((await call(third.client, 'graph_stats')).isError, false);
  } finally {
    await srv.close();
  }
});

/* ================================================================
 * Honest tool results (C2)
 * ================================================================ */

test('add_memory: an LLM failure is a tool error, and the episode is kept for retry', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    srv.llm.failWith = 'LLM HTTP 500: upstream error';
    const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.' });
    assert.equal(r.isError, true, 'a failed extraction must not look like success');
    assert.match(r.text, /stored for retry/);
    assert.doesNotMatch(r.text, /processed/);
    assert.equal(r.structured.status, 'failed');
    assert.match(r.structured.error, /HTTP 500/);
    const [ep] = await srv.zep.store.getEpisodes('teamA');
    assert.equal(ep.status, 'failed');

    // recovery: once the LLM is back, retry_failed processes it in place
    srv.llm.failWith = null;
    const retry = await call(a.client, 'retry_failed');
    assert.equal(retry.isError, false);
    assert.equal(retry.structured.succeeded, 1);
    const episode = await call(a.client, 'get_episode', { id: ep.uuid.slice(0, 8) });
    assert.equal(episode.structured.episode.status, 'processed');
    assert.equal(episode.structured.facts.length, 1);
  } finally {
    await srv.close();
  }
});

test('add_memory: reports processed with complete fact rows, then duplicate', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    const content = 'Alice works at Acme.';
    const first = await call(a.client, 'add_memory', { content, valid_at: '2024-03-01T00:00:00Z' });
    assert.equal(first.isError, false);
    assert.equal(first.structured.status, 'processed');
    assert.deepEqual(first.structured.entities.sort(), ['Acme', 'Alice']);
    const row = first.structured.facts[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'created_at', 'episodes', 'expired_at', 'fact', 'invalid_at', 'reason', 'relation', 'score', 'source',
      'source_uuid', 'target', 'target_uuid', 'uuid', 'valid_at',
    ]);
    assert.equal(row.source, 'Alice');
    assert.equal(row.target, 'Acme');
    assert.equal(row.source_uuid, (await srv.zep.store.findEntityByName('teamA', 'Alice'))?.uuid);
    assert.equal(row.target_uuid, (await srv.zep.store.findEntityByName('teamA', 'Acme'))?.uuid);
    assert.equal(row.reason, null);
    assert.equal(row.relation, 'WORKS_AT');
    assert.equal(row.valid_at, '2024-03-01T00:00:00.000Z');
    assert.deepEqual(row.episodes, [first.structured.episode_uuid]);

    const again = await call(a.client, 'add_memory', { content, valid_at: '2024-03-01T00:00:00Z' });
    assert.equal(again.isError, false);
    assert.equal(again.structured.status, 'duplicate');
    assert.match(again.text, /duplicate/);

    // validity shows the start, and search rows carry a score
    const found = await call(a.client, 'search_facts', { query: 'Alice Acme' });
    assert.match(found.text, /since 2024-03-01/);
    assert.equal(typeof found.structured.facts[0].score, 'number');
    assert.equal(found.structured.degraded, false);
  } finally {
    await srv.close();
  }
});

test('add_memory: facts whose entities could not be resolved are counted as dropped', async () => {
  const llm = new ScriptedLLM(() => ({
    entities: [entity('Alice'), entity('Acme', ['Organization'])],
    facts: [fact('Alice', 'Acme', 'WORKS_AT'), fact('Ghost', 'Acme', 'HAUNTS')],
    invalidations: [],
  }));
  const zep = new Minizep({ llm, embedder: deterministicEmbedder() });
  const srv = await startServer({ zep });
  try {
    const a = await connect(srv.base, 'tokA');
    const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme, which Ghost haunts.' });
    assert.deepEqual(r.structured.dropped, { facts: 1, invalidations: 0 });
    assert.match(r.text, /dropped: 1 fact, 0 invalidations/);
  } finally {
    await srv.close();
  }
});

/* ================================================================
 * Durable async ingestion (C3), on both backends
 * ================================================================ */

function resolveUrl(): string | undefined {
  if (process.env.MINIZEP_TEST_DATABASE_URL) return process.env.MINIZEP_TEST_DATABASE_URL;
  if (process.env.MINIZEP_DATABASE_URL) return process.env.MINIZEP_DATABASE_URL;
  try {
    return readFileSync('/var/tmp/minizep-pg/url', 'utf8').trim();
  } catch {
    return undefined;
  }
}
const PG_URL = resolveUrl();
const PG_SCHEMA = 'minizep_test_server'; // own schema: parallel test files must not truncate each other

async function pgAvailable(): Promise<boolean> {
  if (!PG_URL) return false;
  try {
    const probe = new PostgresStore({ connectionString: PG_URL, embeddingDims: 64, schema: PG_SCHEMA });
    await probe.health();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

interface Backend {
  name: string;
  make(): Promise<GraphStore>;
  dispose(store: GraphStore): Promise<void>;
}

const backends: Backend[] = [
  { name: 'memory', make: async () => new MemoryGraphStore(), dispose: async () => undefined },
];
if (await pgAvailable()) {
  backends.push({
    name: 'postgres',
    make: async () => {
      const s = new PostgresStore({ connectionString: PG_URL!, embeddingDims: 64, schema: PG_SCHEMA });
      await s.reset();
      return s;
    },
    dispose: (s) => (s as PostgresStore).close(),
  });
} else {
  test('[postgres] server tests (skipped: no database reachable)', { skip: true }, () => {});
}

const pendingEpisode = (groupId: string, content: string, status?: EpisodicNode['status']): EpisodicNode => ({
  type: 'episode',
  uuid: crypto.randomUUID(),
  groupId,
  name: content.slice(0, 20),
  source: 'text',
  sourceDescription: 'test',
  content,
  validAt: new Date(Date.now() - DAY),
  createdAt: new Date(Date.now() - DAY),
  status,
});

for (const backend of backends) {
  test(`[${backend.name}] async add_memory stores the episode as pending before answering`, async () => {
    const store = await backend.make();
    const srv = await startServer({ store });
    try {
      const a = await connect(srv.base, 'tokA');
      srv.llm.hold();
      const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
      assert.equal(r.structured.status, 'queued');
      assert.ok(r.structured.job_id);
      assert.match(r.text, /queued job [0-9a-f-]{36}/);
      const saved = await store.getEpisode(r.structured.episode_uuid);
      assert.equal(saved?.status, 'pending', 'the episode is durable before the job id is returned');

      srv.llm.release();
      await srv.app.jobs.drain();
      const status = await call(a.client, 'memory_job_status', { job_id: r.structured.job_id });
      assert.match(status.text, /status\s+: succeeded/);
      assert.equal(status.structured.result.status, 'processed');
      assert.equal((await store.getEpisode(r.structured.episode_uuid))?.status, 'processed');
    } finally {
      await srv.close();
      await backend.dispose(store);
    }
  });

  test(`[${backend.name}] an async job whose extraction fails is reported failed, not succeeded`, async () => {
    const store = await backend.make();
    const srv = await startServer({ store });
    try {
      const a = await connect(srv.base, 'tokA');
      srv.llm.failWith = 'LLM HTTP 500: upstream error';
      const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
      await srv.app.jobs.drain();
      const status = await call(a.client, 'memory_job_status', { job_id: r.structured.job_id });
      assert.match(status.text, /status\s+: failed/);
      assert.match(status.text, /HTTP 500.*stored for retry/);
      assert.equal((await store.getEpisode(r.structured.episode_uuid))?.status, 'failed');
    } finally {
      await srv.close();
      await backend.dispose(store);
    }
  });

  test(`[${backend.name}] startup re-enqueues pending episodes, never legacy ones without a status`, async () => {
    const store = await backend.make();
    const pending = pendingEpisode('teamA', 'Alice works at Acme.', 'pending');
    const legacy = pendingEpisode('teamA', 'Bob works at Borealis.', undefined);
    await store.addEpisode(pending);
    await store.addEpisode(legacy);
    const srv = await startServer({ store });
    try {
      await srv.app.jobs.drain();
      assert.equal((await store.getEpisode(pending.uuid))?.status, 'processed');
      assert.equal(srv.llm.calls, 1, 'only the pending episode is processed');
      const legacyNow = await store.getEpisode(legacy.uuid);
      assert.ok(!legacyNow?.status, 'a legacy episode stays as it was');
      const a = await connect(srv.base, 'tokA');
      const stats = await call(a.client, 'graph_stats');
      assert.deepEqual(stats.structured.episodes, { total: 2, pending: 0, processed: 2, failed: 0 });
    } finally {
      await srv.close();
      await backend.dispose(store);
    }
  });

  test(`[${backend.name}] invalidate_fact ends or retracts a fact, keeping what was believed before`, async () => {
    const store = await backend.make();
    const srv = await startServer({ store });
    try {
      const a = await connect(srv.base, 'tokA');
      const added = await call(a.client, 'add_memory', {
        content: 'Alice works at Acme. Bob likes Cyan.',
        valid_at: '2024-01-10T00:00:00Z',
      });
      const [works, likes] = ['WORKS_AT', 'LIKES'].map(
        (rel) => added.structured.facts.find((f: { relation: string }) => f.relation === rel),
      );

      const ended = await call(a.client, 'invalidate_fact', {
        uuid: works.uuid.slice(0, 8),
        at: '2024-06-01T00:00:00Z',
        reason: 'Alice changed jobs',
      });
      assert.equal(ended.isError, false, ended.text);
      assert.equal(ended.structured.fact.invalid_at, '2024-06-01T00:00:00.000Z');
      assert.match(ended.text, /true 2024-01-10 → 2024-06-01/);
      const inMarch = await call(a.client, 'facts_at', { timestamp: '2024-03-01T00:00:00Z' });
      assert.ok(inMarch.structured.facts.some((f: { uuid: string }) => f.uuid === works.uuid));
      const inJuly = await call(a.client, 'facts_at', { timestamp: '2024-07-01T00:00:00Z' });
      assert.ok(!inJuly.structured.facts.some((f: { uuid: string }) => f.uuid === works.uuid));
      const twice = await call(a.client, 'invalidate_fact', { uuid: works.uuid, at: '2024-07-01T00:00:00Z', reason: 'x' });
      assert.equal(twice.isError, true);
      assert.match(twice.text, /already ended/);

      const beforeRetraction = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      const retracted = await call(a.client, 'invalidate_fact', { uuid: likes.uuid, reason: 'never true', retract: true });
      assert.equal(retracted.isError, false, retracted.text);
      assert.match(retracted.text, /retracted/);
      const inFeb = await call(a.client, 'facts_at', { timestamp: '2024-02-01T00:00:00Z' });
      assert.ok(!inFeb.structured.facts.some((f: { uuid: string }) => f.uuid === likes.uuid), 'never true');
      const believed = await call(a.client, 'facts_at', { timestamp: '2024-02-01T00:00:00Z', as_of: beforeRetraction });
      assert.ok(believed.structured.facts.some((f: { uuid: string }) => f.uuid === likes.uuid), 'as_of shows the old belief');
      const hist = await call(a.client, 'search_facts', { query: 'Bob Cyan', as_of: beforeRetraction });
      assert.ok(hist.structured.facts.some((f: { uuid: string }) => f.uuid === likes.uuid));

      // another group's fact is not found, even by its full uuid
      const b = await connect(srv.base, 'tokB');
      const foreign = await call(b.client, 'invalidate_fact', { uuid: works.uuid, reason: 'x' });
      assert.equal(foreign.isError, true);
      assert.match(foreign.text, /fact not found/);
    } finally {
      await srv.close();
      await backend.dispose(store);
    }
  });
}

test('snapshot: async add_memory has written the pending episode to disk before answering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-http-'));
  const path = join(dir, 'graph.json');
  const srv = await startServer({ persistence: new FilePersistence(path) });
  try {
    const a = await connect(srv.base, 'tokA');
    srv.llm.hold();
    const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { episodes: EpisodicNode[] };
    const ep = onDisk.episodes.find((e) => e.uuid === r.structured.episode_uuid);
    assert.equal(ep?.status, 'pending');

    // a new process loading that snapshot recovers and processes it (the
    // first one stays blocked, as if it had died)
    const zep2 = new Minizep({ llm: new ControlledLLM(), embedder: deterministicEmbedder() });
    const copy = new FilePersistence(path);
    await copy.load(zep2);
    const srv2 = await startServer({ zep: zep2, persistence: copy });
    try {
      await srv2.app.jobs.drain();
      assert.equal((await zep2.store.getEpisode(r.structured.episode_uuid))?.status, 'processed');
    } finally {
      await srv2.close();
    }
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown: close() waits for queued ingestion and flushes the snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-http-'));
  const path = join(dir, 'graph.json');
  const srv = await startServer({ persistence: new FilePersistence(path) });
  try {
    const a = await connect(srv.base, 'tokA');
    srv.llm.hold();
    const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
    const closing = srv.app.close({ drainTimeoutMs: 5000 });
    await new Promise((res) => setTimeout(res, 20));
    srv.llm.release();
    assert.equal(await closing, true, 'drained in time');
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { episodes: EpisodicNode[] };
    assert.equal(onDisk.episodes.find((e) => e.uuid === r.structured.episode_uuid)?.status, 'processed');
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown: a drain that times out reports it and leaves the episode pending for the next start', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    srv.llm.hold();
    const r = await call(a.client, 'add_memory', { content: 'Alice works at Acme.', async: true });
    assert.equal(await srv.app.close({ drainTimeoutMs: 30 }), false);
    assert.equal((await srv.zep.store.getEpisode(r.structured.episode_uuid))?.status, 'pending');
  } finally {
    await srv.close();
  }
});

/* ================================================================
 * New and extended tools (C4)
 * ================================================================ */

test('get_episode: by uuid prefix, with the facts it produced and reinforced', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    const first = await call(a.client, 'add_memory', { content: 'Alice works at Acme.' });
    const second = await call(a.client, 'add_memory', { content: 'As said before, Alice works at Acme. Bob likes Cyan.' });

    const one = await call(a.client, 'get_episode', { id: first.structured.episode_uuid.slice(0, 8) });
    assert.equal(one.isError, false, one.text);
    assert.equal(one.structured.episode.content, 'Alice works at Acme.');
    assert.equal(one.structured.facts.length, 1);
    const two = await call(a.client, 'get_episode', { id: second.structured.episode_uuid });
    assert.equal(two.structured.facts.length, 1, 'Bob likes Cyan is new');
    assert.equal(two.structured.reinforced.length, 1, 'Alice works at Acme was already known');

    assert.match((await call(a.client, 'get_episode', { id: 'abc' })).text, /at least 8 characters/);
    assert.match((await call(a.client, 'get_episode', { id: 'ffffffff' })).text, /episode not found/);
    const b = await connect(srv.base, 'tokB');
    const foreign = await call(b.client, 'get_episode', { id: first.structured.episode_uuid });
    assert.equal(foreign.isError, true, 'another group\'s episode is not found');
  } finally {
    await srv.close();
  }
});

test('facts_at: limit defaults to 100 and is adjustable; graph_stats is per group', async () => {
  const srv = await startServer();
  try {
    const c = await connect(srv.base, 'tokC');
    const people = Array.from({ length: 105 }, (_, i) => `Person${String.fromCharCode(65 + (i % 26))}${i}`);
    const text = people.map((p) => `${p} works at Acme.`).join(' ');
    await call(c.client, 'add_memory', { content: text, group_id: 'shared' });
    assert.equal((await call(c.client, 'facts_at', { group_id: 'shared' })).structured.facts.length, 100);
    assert.equal((await call(c.client, 'facts_at', { group_id: 'shared', limit: 3 })).structured.facts.length, 3);
    assert.equal((await call(c.client, 'graph_stats', { group_id: 'shared' })).structured.facts.total, 105);
    assert.equal((await call(c.client, 'graph_stats')).structured.facts.total, 0, 'teamC is empty');
    const bad = await call(c.client, 'facts_at', { timestamp: 'yesterday-ish' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /invalid at/);
  } finally {
    await srv.close();
  }
});

test('facts_about: resolves a partial name and lists other candidates', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.base, 'tokA');
    await call(a.client, 'add_memory', { content: 'Alice Chen works at Acme. Alice Wang works at Borealis.' });
    const r = await call(a.client, 'facts_about', { entity: 'Alice' });
    assert.equal(r.isError, false);
    assert.ok(r.structured.entity.name.startsWith('Alice'));
    assert.equal(r.structured.candidates.length, 1);
    assert.match(r.text, /other matches: Alice/);
    assert.match((await call(a.client, 'facts_about', { entity: 'Zed' })).text, /no entity matches/);
  } finally {
    await srv.close();
  }
});

/* ================================================================
 * Listening (C6)
 * ================================================================ */

test('listen: several addresses serve the same app', async () => {
  const srv = await startServer();
  try {
    const [extra] = await srv.app.listen(['127.0.0.1'], 0);
    assert.equal(srv.app.addresses().length, 2);
    const viaExtra = await api(`http://127.0.0.1:${extra.port}`, 'POST', '/v1/memories', {
      token: 'tokA',
      body: { content: 'Alice works at Acme.' },
    });
    assert.equal(viaExtra.status, 201);
    const listed = await api(srv.base, 'GET', '/v1/episodes', { token: 'tokA' });
    assert.equal(listed.body.episodes.length, 1, 'both addresses share one graph');
  } finally {
    await srv.close();
  }
});

/* ================================================================
 * Web UI (MINIZEP_UI_GROUPS): no token, fixed groups, own page only
 * ================================================================ */

test('ui: the page is served without a token, and nothing is served while the UI is off', async () => {
  const srv = await startServer({ ui: { groups: ['teamA'] } });
  try {
    const page = await fetch(`${srv.base}/ui`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self';.*frame-ancestors 'none'/);
    assert.match(await page.text(), /minizep/i);
    for (const path of ['/', '/ui/']) {
      const r = await fetch(`${srv.base}${path}?x=1`, { redirect: 'manual' });
      assert.equal(r.status, 302, path);
      assert.equal(new URL(r.headers.get('location')!, `${srv.base}${path}`).href, `${srv.base}/ui?x=1`, path);
    }
    assert.equal((await fetch(`${srv.base}/ui/`)).status, 200, 'followed to the page');
    assert.equal((await fetch(`${srv.base}/ui`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${srv.base}/ui/elsewhere`)).status, 404);
    assert.equal((await api(srv.base, 'GET', '/v1/stats')).status, 401, '/v1 still needs a token');
  } finally {
    await srv.close();
  }
  const off = await startServer();
  try {
    for (const path of ['/', '/ui', '/ui/', '/ui/api/v1/stats']) {
      assert.equal((await fetch(`${off.base}${path}`)).status, 404, path);
    }
  } finally {
    await off.close();
  }
});

test('ui: other sites and foreign host names (DNS rebinding) are refused', async () => {
  const srv = await startServer({ ui: { groups: ['teamA'], hosts: parseUiHosts(' Minizep.Example ') } });
  try {
    const port = new URL(srv.base).port;
    const self = `127.0.0.1:${port}`;
    const json = { 'content-type': 'application/json' };
    const add = (headers: Record<string, string>) =>
      rawRequest(srv.base, 'POST', '/ui/api/v1/memories', { ...json, ...headers }, '{"content":"Mallory works at Evilcorp."}');

    const crossSite = await add({ origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.deepEqual([crossSite.status, crossSite.body], [403, { error: 'cross-origin request refused' }]);
    assert.equal((await add({ origin: `http://${self}`, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await add({ origin: `https://${self}` })).status, 403);
    // a rebinding page is same-origin for the browser, but under the attacker's name
    const evil = `evil.test:${port}`;
    assert.equal((await add({ host: evil, origin: `http://${evil}`, 'sec-fetch-site': 'same-origin' })).status, 403);
    assert.equal((await rawRequest(srv.base, 'GET', '/ui/api/v1/episodes', { host: evil })).status, 403);
    assert.equal((await rawRequest(srv.base, 'GET', '/ui', { host: evil })).status, 403);
    assert.equal((await rawRequest(srv.base, 'GET', '/ui', { host: `[::1]evil:${port}` })).status, 403);
    assert.equal((await srv.zep.store.getEpisodes()).length, 0, 'nothing was written');

    // the page itself: same origin under an IP address, localhost or a listed name
    const own = await add({ host: self, origin: `http://${self}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(own.status, 201);
    assert.equal(own.body.group_id, 'teamA');
    for (const host of [`localhost:${port}`, `[::1]:${port}`, `minizep.example:${port}`, 'minizep.example']) {
      const r = await rawRequest(srv.base, 'GET', '/ui/api/v1/stats', { host, origin: `http://${host}` });
      assert.equal(r.status, 200, host);
    }
    assert.equal((await rawRequest(srv.base, 'GET', '/ui/api/v1/stats', { host: self })).status, 200, 'no Origin');
    assert.equal((await add({ host: self, 'content-type': 'text/plain' })).status, 415, 'no form posts');
  } finally {
    await srv.close();
  }
});

test('ui: the UI acts only on the groups in MINIZEP_UI_GROUPS', async () => {
  assert.equal(uiFromEnv({}), undefined);
  assert.equal(uiFromEnv({ MINIZEP_UI_GROUPS: '  ' }), undefined);
  assert.throws(() => uiFromEnv({ MINIZEP_UI_GROUPS: 'teamA||shared' }), /MINIZEP_UI_GROUPS/);
  assert.throws(() => uiFromEnv({ MINIZEP_UI_GROUPS: 'teamA', MINIZEP_UI_HOSTS: 'minizep.example:8787' }), /MINIZEP_UI_HOSTS/);

  const srv = await startServer({ ui: uiFromEnv({ MINIZEP_UI_GROUPS: 'teamA|shared' }) });
  try {
    await api(srv.base, 'POST', '/v1/memories', { token: 'tokB', body: { content: 'Bob works at Borealis.' } });
    const ui = (method: string, path: string, body?: unknown) => api(srv.base, method, `/ui/api${path}`, { body });

    const added = await ui('POST', '/v1/memories', { content: 'Alice works at Acme.' });
    assert.equal(added.status, 201);
    assert.equal(added.body.group_id, 'teamA', 'the first group is the default');
    assert.equal((await ui('GET', '/v1/stats?group_id=shared')).status, 200);
    const refused: [string, string, unknown?][] = [
      ['GET', '/v1/graph?group_id=teamB'],
      ['GET', '/v1/episodes?group_id=teamB'],
      ['POST', '/v1/search', { query: 'Bob', group_id: 'teamB' }],
      ['POST', '/v1/memories', { content: 'Eve works at Borealis.', group_id: 'teamB' }],
    ];
    for (const [method, path, body] of refused) {
      const r = await ui(method, path, body);
      assert.deepEqual([r.status, r.body], [403, { error: 'group not permitted for this token' }], `${method} ${path}`);
    }
    const groups = await ui('GET', '/v1/groups');
    assert.equal(groups.body.default_group, 'teamA');
    assert.deepEqual(groups.body.groups.map((g: { group_id: string }) => g.group_id), ['teamA', 'shared']);
    const graph = await ui('GET', '/v1/graph');
    assert.deepEqual(graph.body.edges.map((e: { fact: string }) => e.fact), ['Alice works at Acme']);
    const status = await ui('GET', '/v1/status');
    assert.deepEqual([status.body.groups, status.body.sessions], [['teamA', 'shared'], 0]);
    assert.equal((await ui('POST', '/mcp', {})).status, 404, 'the UI path reaches REST only');
    assert.equal((await srv.zep.store.getEpisodes('teamB')).length, 1, 'team B untouched');
  } finally {
    await srv.close();
  }

  // "*": every group that holds data; the UI also works in anonymous mode, whose /v1 stays local-only
  const any = await startServer({ tokens: new Map(), allowAnonymous: true, ui: uiFromEnv({ MINIZEP_UI_GROUPS: '*' }) });
  try {
    await api(any.base, 'POST', '/v1/memories', { body: { content: 'Bob works at Borealis.', group_id: 'teamB' } });
    const groups = await api(any.base, 'GET', '/ui/api/v1/groups');
    assert.equal(groups.body.default_group, 'default');
    assert.deepEqual(groups.body.groups.map((g: { group_id: string }) => g.group_id), ['teamB']);
    const page = { 'content-type': 'application/json', origin: any.base, 'sec-fetch-site': 'same-origin' };
    const search = JSON.stringify({ query: 'Bob', group_id: 'teamB' });
    assert.equal((await rawRequest(any.base, 'POST', '/ui/api/v1/search', page, search)).status, 200);
    assert.equal((await rawRequest(any.base, 'POST', '/v1/search', page, search)).status, 403);
  } finally {
    await any.close();
  }
});
