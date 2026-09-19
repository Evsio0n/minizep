import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokens, authorize } from '../src/server/auth.js';
import { JobQueue } from '../src/jobs/queue.js';

/* ---------------- auth ---------------- */

test('auth: tokens parse into token -> group mappings', () => {
  const tokens = parseTokens('tokA:teamA,tokB:teamB');
  assert.equal(tokens.get('tokA'), 'teamA');
  assert.equal(tokens.get('tokB'), 'teamB');
});

test('auth: a token containing a colon still parses (group is after the last colon)', () => {
  // base64-ish tokens legitimately contain ':' padding
  const tokens = parseTokens('abc:def:teamA');
  assert.equal(tokens.get('abc:def'), 'teamA');
});

test('auth: malformed entries are rejected instead of silently dropped', () => {
  assert.throws(() => parseTokens('no-colon'), /expected "token:group"/);
  assert.throws(() => parseTokens('token:'), /expected "token:group"/);
  assert.throws(() => parseTokens('same:g1,same:g2'), /duplicate token/);
});

test('auth: a valid bearer token resolves to its group', () => {
  const tokens = parseTokens('tokA:teamA');
  const result = authorize('Bearer tokA', tokens);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.group, 'teamA');
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
  const empty = new Map<string, string>();
  assert.equal(authorize('Bearer anything', empty).ok, false);
  const anon = authorize(undefined, empty, true);
  assert.equal(anon.ok, true);
  assert.equal(anon.ok && anon.group, 'default');
});

function pick(r: ReturnType<typeof authorize>) {
  return r.ok ? { status: r.status, group: r.group } : { status: r.status, error: r.error };
}

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
