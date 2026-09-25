import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, call, connect, startServer, waitFor } from './server-helpers.js';

test('rest: requests need a valid bearer token', async () => {
  const srv = await startServer();
  try {
    const none = await api(srv.base, 'GET', '/v1/stats');
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(none.body, { error: 'missing bearer token' });
    assert.equal((await api(srv.base, 'GET', '/v1/stats', { token: 'wrong' })).status, 403);
    assert.equal((await api(srv.base, 'GET', '/v1/stats', { token: 'tokA' })).status, 200);
  } finally {
    await srv.close();
  }
});

test('rest: anonymous mode (no tokens configured, explicitly allowed) accepts any group', async () => {
  const srv = await startServer({ tokens: new Map(), allowAnonymous: true });
  try {
    const r = await api(srv.base, 'POST', '/v1/memories', { body: { content: 'Alice works at Acme.', group_id: 'x' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.group_id, 'x');
    const refused = await startServer({ tokens: new Map() });
    try {
      assert.equal((await api(refused.base, 'GET', '/v1/stats')).status, 401);
    } finally {
      await refused.close();
    }
  } finally {
    await srv.close();
  }
});

test('rest: POST /v1/memories reports processed (201), then duplicate (200)', async () => {
  const srv = await startServer();
  try {
    const body = { content: 'Alice works at Acme.', valid_at: '2024-03-01T09:00:00Z', name: 'note', source: 'text' };
    const first = await api(srv.base, 'POST', '/v1/memories', { token: 'tokA', body });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'processed');
    assert.equal(first.body.group_id, 'teamA');
    assert.equal(first.body.error, null);
    assert.equal(first.body.facts[0].fact, 'Alice works at Acme');
    assert.equal(first.body.facts[0].valid_at, '2024-03-01T09:00:00.000Z');
    assert.deepEqual(first.body.dropped, { facts: 0, invalidations: 0 });

    const again = await api(srv.base, 'POST', '/v1/memories', { token: 'tokA', body });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'duplicate');
    assert.equal(again.body.episode_uuid, first.body.episode_uuid);
  } finally {
    await srv.close();
  }
});

test('rest: idempotency_key makes a resend a duplicate whatever its content', async () => {
  const srv = await startServer();
  try {
    const one = await api(srv.base, 'POST', '/v1/memories', {
      token: 'tokA',
      body: { content: 'Alice works at Acme.', idempotency_key: 'msg-42' },
    });
    const two = await api(srv.base, 'POST', '/v1/memories', {
      token: 'tokA',
      body: { content: 'Alice works at Acme (edited).', idempotency_key: 'msg-42' },
    });
    assert.equal(one.status, 201);
    assert.equal(two.body.status, 'duplicate');
    // keys are per group: another tenant's identical key is unrelated
    const other = await api(srv.base, 'POST', '/v1/memories', {
      token: 'tokB',
      body: { content: 'Bob works at Borealis.', idempotency_key: 'msg-42' },
    });
    assert.equal(other.status, 201);
  } finally {
    await srv.close();
  }
});

test('rest: a failed extraction is 502, keeps the episode and says so', async () => {
  const srv = await startServer();
  try {
    srv.llm.failWith = 'LLM HTTP 500: upstream error';
    const r = await api(srv.base, 'POST', '/v1/memories', { token: 'tokA', body: { content: 'Alice works at Acme.' } });
    assert.equal(r.status, 502);
    assert.equal(r.body.status, 'failed');
    assert.match(r.body.error, /extraction failed: LLM HTTP 500.*stored for retry/);
    const ep = await api(srv.base, 'GET', `/v1/episodes/${r.body.episode_uuid}`, { token: 'tokA' });
    assert.equal(ep.body.episode.status, 'failed');
    assert.match(ep.body.episode.error, /HTTP 500/);

    srv.llm.failWith = null;
    const retry = await api(srv.base, 'POST', '/v1/episodes/retry-failed', { token: 'tokA' });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, { group_id: 'teamA', retried: 1, succeeded: 1, still_failing: 0 });
  } finally {
    await srv.close();
  }
});

test('rest: async ingestion answers 202 with a job to poll', async () => {
  const srv = await startServer();
  try {
    srv.llm.hold();
    const r = await api(srv.base, 'POST', '/v1/memories', {
      token: 'tokA',
      body: { content: 'Alice works at Acme.', async: true },
    });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'queued');
    const pending = await api(srv.base, 'GET', `/v1/episodes/${r.body.episode_uuid}`, { token: 'tokA' });
    assert.equal(pending.body.episode.status, 'pending');

    const job = await api(srv.base, 'GET', `/v1/memories/jobs/${r.body.job_id}`, { token: 'tokA' });
    assert.equal(job.status, 200);
    assert.ok(['queued', 'running'].includes(job.body.status));
    assert.equal(job.body.episode_uuid, r.body.episode_uuid);
    assert.equal(job.body.group_id, 'teamA');

    // another tenant cannot see it
    assert.equal((await api(srv.base, 'GET', `/v1/memories/jobs/${r.body.job_id}`, { token: 'tokB' })).status, 404);

    srv.llm.release();
    await waitFor(async () => {
      const j = await api(srv.base, 'GET', `/v1/memories/jobs/${r.body.job_id}`, { token: 'tokA' });
      return j.body.status === 'succeeded';
    });
    const done = await api(srv.base, 'GET', `/v1/memories/jobs/${r.body.job_id}`, { token: 'tokA' });
    assert.equal(done.body.result.status, 'processed');
    assert.equal(done.body.result.facts.length, 1);
    assert.equal((await api(srv.base, 'GET', '/v1/memories/jobs/nope', { token: 'tokA' })).status, 404);
  } finally {
    await srv.close();
  }
});

test('rest: every route applies the token\'s group rules', async () => {
  const srv = await startServer();
  try {
    await api(srv.base, 'POST', '/v1/memories', { token: 'tokB', body: { content: 'Bob works at Borealis.' } });
    const refused: [string, string, unknown?][] = [
      ['POST', '/v1/memories', { content: 'x works at Y.', group_id: 'teamB' }],
      ['POST', '/v1/search', { query: 'Bob', group_id: 'teamB' }],
      ['GET', '/v1/entities?group_id=teamB'],
      ['GET', '/v1/entities/Bob/facts?group_id=teamB'],
      ['GET', '/v1/facts?group_id=teamB'],
      ['GET', '/v1/episodes?group_id=teamB'],
      ['GET', '/v1/episodes/00000000?group_id=teamB'],
      ['POST', '/v1/facts/00000000/invalidate', { reason: 'x', group_id: 'teamB' }],
      ['POST', '/v1/episodes/retry-failed', { group_id: 'teamB' }],
      ['GET', '/v1/stats?group_id=teamB'],
    ];
    for (const [method, path, body] of refused) {
      const r = await api(srv.base, method, path, { token: 'tokA', body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.deepEqual(r.body, { error: 'group not permitted for this token' }, `${method} ${path}`);
    }
    // the multi-group token may use its second group
    const shared = await api(srv.base, 'GET', '/v1/stats?group_id=shared', { token: 'tokC' });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.group_id, 'shared');
    assert.equal((await srv.zep.store.getEpisodes('teamB')).length, 1, 'team B untouched');
  } finally {
    await srv.close();
  }
});

test('rest: search, entities, facts about an entity, facts at an instant', async () => {
  const srv = await startServer();
  try {
    const tok = { token: 'tokA' };
    await api(srv.base, 'POST', '/v1/memories', {
      ...tok,
      body: { content: 'Alice works at Acme. Alice likes Borealis.', valid_at: '2024-01-15T00:00:00Z' },
    });
    await api(srv.base, 'POST', '/v1/memories', {
      ...tok,
      body: { content: 'Alice left Acme.', valid_at: '2024-06-01T00:00:00Z' },
    });

    const search = await api(srv.base, 'POST', '/v1/search', { ...tok, body: { query: 'Alice Acme' } });
    assert.equal(search.status, 200);
    assert.equal(search.body.degraded, false);
    assert.ok(!search.body.facts.some((f: { relation: string }) => f.relation === 'WORKS_AT'), 'ended: not current');
    const back = await api(srv.base, 'POST', '/v1/search', {
      ...tok,
      body: { query: 'Alice Acme', at: '2024-03-01T00:00:00Z' },
    });
    assert.ok(back.body.facts.some((f: { relation: string }) => f.relation === 'WORKS_AT'), 'true in March');
    const hist = await api(srv.base, 'POST', '/v1/search', {
      ...tok,
      body: { query: 'Alice Acme', include_historical: true, limit: 5 },
    });
    assert.ok(hist.body.facts.some((f: { invalid_at: string }) => f.invalid_at === '2024-06-01T00:00:00.000Z'));

    const entities = await api(srv.base, 'GET', '/v1/entities?query=ac&limit=5', tok);
    assert.deepEqual(entities.body.entities.map((e: { name: string }) => e.name), ['Acme']);

    const about = await api(srv.base, 'GET', '/v1/entities/alice/facts?include_historical=true', tok);
    assert.equal(about.status, 200);
    assert.equal(about.body.entity.name, 'Alice');
    assert.equal(about.body.facts.length, 2);
    const current = await api(srv.base, 'GET', '/v1/entities/Alice/facts', tok);
    assert.deepEqual(current.body.facts.map((f: { relation: string }) => f.relation), ['LIKES']);
    assert.equal((await api(srv.base, 'GET', '/v1/entities/Nobody/facts', tok)).status, 404);

    const march = await api(srv.base, 'GET', '/v1/facts?at=2024-03-01T00:00:00Z', tok);
    assert.equal(march.body.facts.length, 2);
    const july = await api(srv.base, 'GET', '/v1/facts?at=2024-07-01T00:00:00Z&limit=10', tok);
    assert.equal(july.body.facts.length, 1);
    const knownBefore = await api(srv.base, 'GET', `/v1/facts?at=2024-01-20T00:00:00Z&as_of=2000-01-01T00:00:00Z`, tok);
    assert.equal(knownBefore.body.facts.length, 0, 'nothing was known in 2000');
  } finally {
    await srv.close();
  }
});

test('rest: episodes list and lookup by prefix', async () => {
  const srv = await startServer();
  try {
    const tok = { token: 'tokA' };
    const one = await api(srv.base, 'POST', '/v1/memories', { ...tok, body: { content: 'Alice works at Acme.' } });
    await new Promise((r) => setTimeout(r, 2));
    await api(srv.base, 'POST', '/v1/memories', { ...tok, body: { content: 'Bob works at Borealis.' } });

    const list = await api(srv.base, 'GET', '/v1/episodes?limit=1', tok);
    assert.equal(list.body.episodes.length, 1);
    assert.equal(list.body.episodes[0].content, 'Bob works at Borealis.', 'newest first');

    const byPrefix = await api(srv.base, 'GET', `/v1/episodes/${one.body.episode_uuid.slice(0, 8)}`, tok);
    assert.equal(byPrefix.status, 200);
    assert.equal(byPrefix.body.episode.uuid, one.body.episode_uuid);
    assert.equal(byPrefix.body.facts[0].source, 'Alice');
    assert.equal((await api(srv.base, 'GET', '/v1/episodes/abc', tok)).status, 400);
    assert.equal((await api(srv.base, 'GET', '/v1/episodes/ffffffff', tok)).status, 404);
    assert.equal(
      (await api(srv.base, 'GET', `/v1/episodes/${one.body.episode_uuid}`, { token: 'tokB' })).status,
      404,
      'another group\'s episode does not exist for this token',
    );
  } finally {
    await srv.close();
  }
});

test('rest: invalidate a fact, with 400/404/409 for bad requests', async () => {
  const srv = await startServer();
  try {
    const tok = { token: 'tokA' };
    const added = await api(srv.base, 'POST', '/v1/memories', {
      ...tok,
      body: { content: 'Alice works at Acme.', valid_at: '2024-01-01T00:00:00Z' },
    });
    const uuid = added.body.facts[0].uuid as string;
    const path = `/v1/facts/${uuid}/invalidate`;

    assert.equal((await api(srv.base, 'POST', path, { ...tok, body: {} })).status, 400, 'reason is required');
    assert.equal((await api(srv.base, 'POST', path, { ...tok, body: { reason: 'x', at: 'soon' } })).status, 400);
    const early = await api(srv.base, 'POST', path, { ...tok, body: { reason: 'x', at: '2023-01-01T00:00:00Z' } });
    assert.equal(early.status, 409, 'cannot end before it started');
    assert.equal(
      (await api(srv.base, 'POST', '/v1/facts/ffffffff/invalidate', { ...tok, body: { reason: 'x' } })).status,
      404,
    );

    const ok = await api(srv.base, 'POST', path, { ...tok, body: { reason: 'left', at: '2024-05-01T00:00:00Z' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.fact.invalid_at, '2024-05-01T00:00:00.000Z');
    assert.ok(ok.body.fact.expired_at);
    assert.equal((await api(srv.base, 'POST', path, { ...tok, body: { reason: 'again' } })).status, 409);

    const stats = await api(srv.base, 'GET', '/v1/stats', tok);
    assert.deepEqual(stats.body.facts, { total: 1, active: 0, historical: 1 });
    assert.deepEqual(stats.body.episodes, { total: 1, pending: 0, processed: 1, failed: 0 });
    assert.deepEqual(stats.body.jobs, { queued: 0, running: 0 });
  } finally {
    await srv.close();
  }
});

test('rest: malformed requests get JSON errors with proper status codes', async () => {
  const srv = await startServer();
  try {
    const tok = { token: 'tokA' };
    const badJson = await api(srv.base, 'POST', '/v1/memories', { ...tok, rawBody: '{"content": ' });
    assert.equal(badJson.status, 400);
    assert.deepEqual(badJson.body, { error: 'request body is not valid JSON' });
    assert.equal((await api(srv.base, 'POST', '/v1/memories', { ...tok, body: ['x'] })).status, 400);
    const missing = await api(srv.base, 'POST', '/v1/memories', { ...tok, body: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /content/);
    assert.equal((await api(srv.base, 'GET', '/v1/entities?limit=zero', tok)).status, 400);
    assert.equal((await api(srv.base, 'GET', '/v1/entities?limit=500', tok)).status, 400);
    assert.equal((await api(srv.base, 'GET', '/v1/facts?as_of=later', tok)).status, 400);

    const big = await api(srv.base, 'POST', '/v1/memories', {
      ...tok,
      body: { content: 'x'.repeat(1024 * 1024 + 10) },
    });
    assert.equal(big.status, 413);
    assert.match(big.body.error, /too large/);
    assert.equal(srv.llm.calls, 0);

    const unknown = await api(srv.base, 'GET', '/v1/nothing-here', tok);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'not found' });
    const wrongMethod = await api(srv.base, 'GET', '/v1/memories', tok);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    assert.equal((await api(srv.base, 'GET', '/elsewhere')).status, 404);
  } finally {
    await srv.close();
  }
});

test('rest: a name with non-ASCII characters is addressed URL-encoded', async () => {
  const srv = await startServer();
  try {
    const tok = { token: 'tokA' };
    await api(srv.base, 'POST', '/v1/memories', { ...tok, body: { content: '张伟在阿里巴巴工作' } });
    const r = await api(srv.base, 'GET', `/v1/entities/${encodeURIComponent('张伟')}/facts`, tok);
    assert.equal(r.status, 200);
    assert.equal(r.body.entity.name, '张伟');
    assert.equal(r.body.facts[0].target, '阿里巴巴');
  } finally {
    await srv.close();
  }
});

test('rest and MCP share one graph and one job queue', async () => {
  const srv = await startServer();
  try {
    const viaRest = await api(srv.base, 'POST', '/v1/memories', {
      token: 'tokA',
      body: { content: 'Alice works at Acme.', async: true },
    });
    await srv.app.jobs.drain();
    const a = await connect(srv.base, 'tokA');
    const found = await call(a.client, 'search_facts', { query: 'Alice' });
    assert.match(found.text, /Alice --WORKS_AT--> Acme/);
    const job = await call(a.client, 'memory_job_status', { job_id: viaRest.body.job_id });
    assert.match(job.text, /succeeded/);
    const status = await api(srv.base, 'GET', '/v1/status', { token: 'tokA' });
    assert.equal(status.body.sessions, 1, 'the MCP session of this token');
  } finally {
    await srv.close();
  }
});

test('rest: a non-JSON body or a browser origin is refused before anything is stored (cross-site writes)', async () => {
  const srv = await startServer({ tokens: new Map(), allowAnonymous: true });
  try {
    const body = JSON.stringify({ content: 'Alice works at Evilcorp', group_id: 'victim' });
    const simple = await fetch(`${srv.base}/v1/memories`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    assert.equal(simple.status, 415);
    const page = await fetch(`${srv.base}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body,
    });
    assert.equal(page.status, 403);
    assert.equal((await srv.zep.store.getEpisodes('victim')).length, 0);
  } finally {
    await srv.close();
  }
});
