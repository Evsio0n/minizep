import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  parseTokens,
  authorize,
  resolveGroup,
  localPrincipal,
  GroupNotPermittedError,
  type Principal,
} from '../src/server/auth.js';
import { JobQueue } from '../src/jobs/queue.js';
import { SessionRegistry } from '../src/server/sessions.js';
import { listenWithRetry, parseHosts } from '../src/server/listen.js';
import { validity } from '../src/server/tools.js';
import type { FactRow } from '../src/server/service.js';
import { FilePersistence, Minizep } from '../src/index.js';

/* ---------------- auth ---------------- */

test('auth: tokens parse into token -> groups mappings', () => {
  const tokens = parseTokens('tokA:teamA,tokB:teamB');
  assert.deepEqual(tokens.get('tokA'), ['teamA']);
  assert.deepEqual(tokens.get('tokB'), ['teamB']);
});

test('auth: a token may hold several groups, the first being its default', () => {
  const tokens = parseTokens('tokA:teamA|shared|teamA, tokB:teamB');
  assert.deepEqual(tokens.get('tokA'), ['teamA', 'shared'], 'duplicates collapse, order kept');
  const r = authorize('Bearer tokA', tokens);
  assert.equal(r.ok && r.principal.defaultGroup, 'teamA');
});

test('auth: a token containing a colon still parses (groups are after the last colon)', () => {
  // base64-ish tokens legitimately contain ':' padding
  const tokens = parseTokens('abc:def:teamA');
  assert.deepEqual(tokens.get('abc:def'), ['teamA']);
});

test('auth: malformed entries are rejected instead of silently dropped', () => {
  assert.throws(() => parseTokens('no-colon'), /expected "token:group"/);
  assert.throws(() => parseTokens('token:'), /expected "token:group"/);
  assert.throws(() => parseTokens('token:teamA||teamB'), /empty group name/);
  assert.throws(() => parseTokens('same:g1,same:g2'), /duplicate token/);
});

test('auth: a valid bearer token resolves to its principal, which never carries the token', () => {
  const tokens = parseTokens('tokA:teamA');
  const result = authorize('Bearer tokA', tokens);
  assert.equal(result.ok, true);
  const p = (result as { principal: Principal }).principal;
  assert.deepEqual(p.groups, ['teamA']);
  assert.ok(!JSON.stringify(p).includes('tokA'), 'the principal id is a digest, not the secret');
  // stable across requests, distinct across tokens (sessions are bound to it)
  const again = authorize('Bearer tokA', tokens) as { principal: Principal };
  assert.equal(again.principal.id, p.id);
  const other = authorize('Bearer tokB', parseTokens('tokA:teamA,tokB:teamA')) as { principal: Principal };
  assert.notEqual(other.principal.id, p.id);
});

test('auth: missing, malformed and wrong tokens are refused with distinct statuses', () => {
  const tokens = parseTokens('tokA:teamA');
  assert.deepEqual(pick(authorize(undefined, tokens)), { status: 401, error: 'missing bearer token' });
  assert.deepEqual(pick(authorize('tokA', tokens)), { status: 401, error: 'missing bearer token' });
  assert.deepEqual(pick(authorize('Bearer wrong', tokens)), { status: 403, error: 'invalid token' });
  // a token that is a prefix of a real one must not pass
  assert.deepEqual(pick(authorize('Bearer tok', tokens)), { status: 403, error: 'invalid token' });
});

test('auth: an unconfigured server refuses everyone unless anonymous is explicitly allowed', () => {
  const empty = new Map<string, string[]>();
  assert.equal(authorize('Bearer anything', empty).ok, false);
  const anon = authorize(undefined, empty, true);
  assert.equal(anon.ok, true);
  assert.equal(anon.ok && anon.principal.defaultGroup, 'default');
  assert.equal(anon.ok && anon.principal.groups, 'any');
});

function pick(r: ReturnType<typeof authorize>) {
  return r.ok ? { status: r.status, groups: r.principal.groups } : { status: r.status, error: r.error };
}

test('groups: absent -> default, permitted -> itself, anything else -> not permitted', () => {
  const p = (authorize('Bearer tokC', parseTokens('tokC:teamC|shared')) as { principal: Principal }).principal;
  assert.equal(resolveGroup(p, undefined), 'teamC');
  assert.equal(resolveGroup(p, ''), 'teamC');
  assert.equal(resolveGroup(p, 'shared'), 'shared');
  assert.throws(() => resolveGroup(p, 'teamA'), GroupNotPermittedError);
  assert.throws(() => resolveGroup(p, 'Shared'), /group not permitted for this token/, 'names match exactly');
  assert.throws(() => resolveGroup(p, 'shared '), GroupNotPermittedError);
  assert.equal(new GroupNotPermittedError().status, 403);
});

test('groups: the local stdio user may use any group', () => {
  const p = localPrincipal('default');
  assert.equal(resolveGroup(p, undefined), 'default');
  assert.equal(resolveGroup(p, 'anything'), 'anything');
});

/* ---------------- sessions ---------------- */

class FakeSession {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

test('sessions: bound to the principal that created them', () => {
  const reg = new SessionRegistry<FakeSession>();
  assert.ok(reg.reserve());
  reg.add('s1', 'tok_a', new FakeSession());
  const own = reg.acquire('s1', 'tok_a');
  assert.equal(own.ok, true);
  const stolen = reg.acquire('s1', 'tok_b');
  assert.deepEqual(stolen, { ok: false, status: 403, error: 'session belongs to another token' });
  assert.equal(reg.acquire('nope', 'tok_a').ok, false);
});

test('sessions: idle ones expire after the TTL, busy ones never do', () => {
  let now = 0;
  const reg = new SessionRegistry<FakeSession>({ ttlMs: 100, now: () => now });
  const idle = new FakeSession();
  const busy = new FakeSession();
  reg.reserve();
  reg.add('idle', 'p', idle);
  reg.reserve();
  reg.add('busy', 'p', busy);
  const hold = reg.acquire('busy', 'p');
  assert.equal(hold.ok, true);
  now = 500;
  reg.sweep();
  assert.equal(idle.closed, true);
  assert.equal(busy.closed, false, 'a request in flight keeps the session');
  assert.deepEqual(reg.acquire('idle', 'p'), { ok: false, status: 404, error: 'Session not found' });
  if (hold.ok) hold.release();
  now = 550;
  // a GET (the client's standing SSE stream) touches the session without keeping it busy
  assert.equal(reg.acquire('busy', 'p', false).ok, true);
  now = 600;
  reg.sweep();
  assert.equal(busy.closed, false, 'idle for 50ms only');
  now = 1000;
  reg.sweep();
  assert.equal(busy.closed, true);
});

test('sessions: the cap evicts the longest idle session, and refuses when all are busy', () => {
  let now = 0;
  const reg = new SessionRegistry<FakeSession>({ maxSessions: 2, now: () => now });
  const a = new FakeSession();
  const b = new FakeSession();
  reg.reserve();
  reg.add('a', 'p', a);
  now = 10;
  reg.reserve();
  reg.add('b', 'p', b);
  now = 20;
  reg.acquire('a', 'p'); // a is busy now (never released)
  assert.equal(reg.reserve(), true);
  assert.equal(b.closed, true, 'b was idle longest');
  assert.equal(a.closed, false);
  reg.add('c', 'p', new FakeSession());
  reg.acquire('c', 'p');
  assert.equal(reg.reserve(), false, 'every session is busy');
  assert.equal(reg.size, 2);
});

/* ---------------- listening ---------------- */

test('listen: MINIZEP_HOST is a comma-separated list, loopback by default', () => {
  assert.deepEqual(parseHosts(undefined), ['127.0.0.1']);
  assert.deepEqual(parseHosts(''), ['127.0.0.1']);
  assert.deepEqual(parseHosts('127.0.0.1, 100.64.0.10 ,127.0.0.1'), ['127.0.0.1', '100.64.0.10']);
});

const errno = (code: string) => Object.assign(new Error(code), { code });

test('listen: an address that does not exist yet is retried with backoff until it binds', async () => {
  const addr: AddressInfo = { address: '100.64.0.10', family: 'IPv4', port: 8787 };
  let attempts = 0;
  const delays: number[] = [];
  const l = listenWithRetry(
    async () => {
      attempts++;
      if (attempts < 4) throw errno('EADDRNOTAVAIL');
      return addr;
    },
    { initialDelayMs: 2, maxDelayMs: 5, onRetry: (_err, delay) => delays.push(delay) },
  );
  assert.equal(await l.first, null, 'the first attempt reports "waiting" instead of failing');
  assert.deepEqual(await l.bound, addr);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [2, 4, 5], 'exponential, capped');
});

test('listen: any other bind error is fatal, and cancel() stops the retries', async () => {
  const inUse = listenWithRetry(async () => {
    throw errno('EADDRINUSE');
  });
  await assert.rejects(inUse.first, /EADDRINUSE/);
  await assert.rejects(inUse.bound, /EADDRINUSE/);

  let attempts = 0;
  const waiting = listenWithRetry(
    async () => {
      attempts++;
      throw errno('EADDRNOTAVAIL');
    },
    { initialDelayMs: 60_000 },
  );
  assert.equal(await waiting.first, null);
  waiting.cancel();
  await assert.rejects(waiting.bound, /cancelled/);
  assert.equal(attempts, 1);
});

/* ---------------- formatting ---------------- */

const row = (valid_at: string | null, invalid_at: string | null, expired_at: string | null = null): FactRow => ({
  uuid: '00000000-0000-0000-0000-000000000000',
  relation: 'WORKS_AT',
  source: 'Alice',
  target: 'Acme',
  fact: 'Alice works at Acme',
  valid_at,
  invalid_at,
  created_at: '2024-01-01T00:00:00.000Z',
  expired_at,
  episodes: [],
  score: null,
});

test('validity: shows when a fact started, ended or is scheduled to end', () => {
  const now = Date.parse('2025-01-01T00:00:00Z');
  assert.equal(validity(row('2024-03-01T00:00:00.000Z', null), now), 'since 2024-03-01');
  assert.equal(validity(row(null, null), now), 'still true');
  assert.equal(validity(row('2024-03-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z'), now), 'true 2024-03-01 → 2024-06-01');
  assert.equal(
    validity(row('2024-03-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'), now),
    'since 2024-03-01, until 2025-06-01',
  );
  assert.equal(validity(row('2025-03-01T00:00:00.000Z', null), now), 'from 2025-03-01');
  assert.equal(validity(row('2024-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'), now), 'retracted');
  assert.equal(validity(row(null, null, '2024-05-01T00:00:00.000Z'), now), 'retracted');
});

/* ---------------- snapshot writes ---------------- */

test('persistence: concurrent saves never overlap and the last state wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minizep-persist-'));
  try {
    const path = join(dir, 'graph.json');
    const zep = new Minizep();
    const persistence = new FilePersistence(path);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      await zep.store.addEpisode({
        type: 'episode',
        uuid: `00000000-0000-0000-0000-00000000000${i}`,
        groupId: 'g',
        name: `e${i}`,
        source: 'text',
        sourceDescription: 'test',
        content: `episode ${i}`,
        validAt: new Date(),
        createdAt: new Date(),
        status: 'pending',
      });
      saves.push(persistence.save(zep));
    }
    await Promise.all(saves);
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { episodes: unknown[] };
    assert.equal(onDisk.episodes.length, 5, 'every save resolves after a write that includes its state');
    await persistence.flush(zep);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- job queue ---------------- */

test('queue: a job runs and exposes its result', async () => {
  const q = new JobQueue();
  const job = q.submit('test', async () => 42);
  await q.drain();
  assert.equal(q.get(job.id)?.status, 'succeeded');
  assert.equal(q.get(job.id)?.result, 42);
});

test('queue: a failing job records the error instead of throwing at the caller', async () => {
  const q = new JobQueue();
  const job = q.submit('boom', async () => {
    throw new Error('llm exploded');
  });
  await q.drain();
  assert.equal(q.get(job.id)?.status, 'failed');
  assert.equal(q.get(job.id)?.error, 'llm exploded');
});

test('queue: concurrency is bounded — extra jobs wait their turn', async () => {
  const q = new JobQueue({ concurrency: 2 });
  let peak = 0;
  let active = 0;
  const jobs = Array.from({ length: 6 }, () =>
    q.submit('slow', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    }),
  );
  assert.equal(q.stats.running <= 2, true);
  await q.drain();
  assert.equal(peak, 2, `at most 2 jobs may run at once, saw ${peak}`);
  assert.equal(jobs.filter((j) => q.get(j.id)?.status === 'succeeded').length, 6);
});

test('queue: history is bounded but never evicts unfinished work', async () => {
  const q = new JobQueue({ concurrency: 1, historyLimit: 3 });
  const slow = q.submit('slow', () => new Promise((r) => setTimeout(r, 30)));
  for (let i = 0; i < 10; i++) q.submit('quick', async () => i);
  // the slow job is still queued/running while history churns
  assert.ok(q.get(slow.id), 'unfinished job must not be evicted');
  await q.drain();
  assert.ok(q.list(100).length <= 3, 'history stays bounded');
});

test('queue: list returns newest first', async () => {
  const q = new JobQueue();
  const a = q.submit('a', async () => 1);
  const b = q.submit('b', async () => 2);
  await q.drain();
  assert.deepEqual(q.list(2).map((j) => j.id), [b.id, a.id]);
});

test('queue: drain gives up after its timeout and reports it', async () => {
  const q = new JobQueue();
  let finish: () => void = () => undefined;
  q.submit('stuck', () => new Promise<void>((r) => (finish = r)));
  assert.equal(await q.drain(20), false);
  finish();
  assert.equal(await q.drain(1000), true);
});

test('queue: jobs carry their group and can be listed and counted per group', async () => {
  const q = new JobQueue();
  const a = q.submit('a', async () => 1, { group: 'teamA', ref: 'ep-1' });
  q.submit('b', async () => 2, { group: 'teamB' });
  await q.drain();
  assert.equal(q.get(a.id)?.ref, 'ep-1');
  assert.deepEqual(q.list(10, (j) => j.group === 'teamA').map((j) => j.id), [a.id]);
  assert.deepEqual(q.statsFor((j) => j.group === 'teamA'), { queued: 0, running: 0 });
});
