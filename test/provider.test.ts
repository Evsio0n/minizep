import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep, OpenAICompatLLM, FallbackEmbedder, MockLLMProvider } from '../src/index.js';
import { buildExtractionPrompt, buildLLM, formatReferenceTime, parseContradiction } from '../src/provider/openai-llm.js';
import { HashEmbedder, type Embedder } from '../src/provider/interfaces.js';

/**
 * Replaces global fetch with a chat-completions stub for the duration of `fn`.
 * `reply` sees the parsed request body and returns the assistant's content.
 * Nothing leaves the process.
 */
async function withChatStub<T>(
  reply: (body: { messages: { role: string; content: string }[] }) => unknown,
  fn: (requests: { messages: { role: string; content: string }[] }[]) => Promise<T>,
): Promise<T> {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const content = JSON.stringify(reply(body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const stubLLM = () =>
  new OpenAICompatLLM({ baseUrl: 'http://llm.invalid', apiKey: 'test', model: 'stub', timeZone: 'UTC', retries: 1 });
const userOf = (body: { messages: { role: string; content: string }[] }) => body.messages.find((m) => m.role === 'user')!.content;
const systemOf = (body: { messages: { role: string; content: string }[] }) => body.messages.find((m) => m.role === 'system')!.content;

test('provider: regression R4 — the invalidation safety net never overwrites an entity summary', async () => {
  await withChatStub(
    (body) =>
      userOf(body).includes('Alice left.')
        ? // the LLM (legitimately) lists no entities, only the termination
          {
            entities: [],
            facts: [],
            invalidations: [{ sourceName: 'Alice', targetName: 'Acme', relation: 'WORKS_AT', invalidAt: null, reason: 'text states Alice left' }],
          }
        : {
            entities: [
              { name: 'Acme', labels: ['Organization'], summary: 'Acme is a fintech company in Hong Kong.' },
              { name: 'Alice', labels: ['Person'], summary: 'Engineer.' },
            ],
            facts: [{ sourceName: 'Alice', targetName: 'Acme', relation: 'WORKS_AT', fact: 'Alice works at Acme' }],
            invalidations: [],
          },
    async () => {
      const zep = new Minizep({ llm: stubLLM(), embedder: new HashEmbedder(64) });
      await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice works at Acme, a fintech company in Hong Kong.' });
      const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice left.' });

      assert.equal(res.invalidated.length, 1);
      assert.equal((await zep.store.findEntityByName('g', 'Acme'))!.summary, 'Acme is a fintech company in Hong Kong.');
      assert.equal((await zep.store.findEntityByName('g', 'Alice'))!.summary, 'Engineer.');
    },
  );
});

test('provider: the extraction prompt carries the reference time, known summaries and active relationships', async () => {
  await withChatStub(
    () => ({ entities: [], facts: [], invalidations: [] }),
    async (requests) => {
      await stubLLM().extract(
        '昨天的周会上，我们决定把 v2.0 的发布日期推迟到下周五',
        ['Alice Chen'],
        [{ sourceName: 'Alice Chen', targetName: 'Acme Corp', relation: 'WORKS_AT', fact: 'Alice Chen works at Acme Corp', validAt: new Date('2024-01-01') }],
        { referenceTime: new Date('2026-09-24T00:00:00Z'), knownEntities: [{ name: 'Alice Chen', summary: 'Backend engineer at Acme Corp.' }] },
      );
      const [req] = requests;
      const user = userOf(req);
      assert.match(user, /Reference time: 2026-09-24T00:00:00\+00:00 \(Thursday\)/);
      assert.match(user, /- Alice Chen: Backend engineer at Acme Corp\./);
      assert.match(user, /- Alice Chen --WORKS_AT--> Acme Corp: Alice Chen works at Acme Corp \(since 2024-01-01\)/);

      const system = systemOf(req);
      assert.match(system, /Resolve every relative expression against the reference time/);
      assert.match(system, /Literal values are NEVER entities: IP addresses, host:port, ports, URLs/);
      assert.match(system, /never a value node\. A value\s+that can change \(address, port, version, status, location, owner\) belongs in a fact/);
      assert.match(system, /"subject RELATION object"/);
      assert.match(system, /State each relationship once/);
      assert.match(system, /language of the text/);
      assert.match(system, /self-contained natural-language sentence/);
      assert.match(system, /Dependent relationships end with it/);
      assert.match(system, /UPDATED\s+summary/);
      // a changed property of one entity replaces its value in the summary, it is not a fact
      assert.match(system, /A summary states current values/);
      assert.match(system, /a new value for a changing property kept\s+in a fact \(address, port, version, status\), replaces the old one/);
      // one list of the relationships with one target at a time (a team is not one): they, and an
      // explicit replacement, let the pipeline end another target of the same relation
      assert.match(system, /replacesPrevious says the target of this fact replaces any earlier one/);
      assert.match(system, /one target at a time for its source \(employer, title or role, home city, manager, owner\),\s+however the fact is worded/);
      assert.equal(system.match(/employer, title/g)?.length, 1, 'one list');
      assert.match(system, /member of several teams, runs several jobs\): a new target there ends nothing/);
      assert.match(system, /A negation \("does not replace", "is not part of", 并不取代\) never sets it/);
      assert.match(system, /A negated relationship \("X does not replace Y", "X is not part of Y"\) is neither a fact nor an\s+invalidation/);
    },
  );
});

test('provider: the reference time is rendered in the configured zone with its offset', () => {
  const t = new Date('2026-09-24T00:00:00Z');
  assert.equal(formatReferenceTime(t, 'UTC'), '2026-09-24T00:00:00+00:00 (Thursday)');
  assert.equal(formatReferenceTime(t, 'Asia/Shanghai'), '2026-09-24T08:00:00+08:00 (Thursday)');
  assert.equal(formatReferenceTime(t, 'America/New_York'), '2026-09-23T20:00:00-04:00 (Wednesday)');
  assert.throws(() => new OpenAICompatLLM({ baseUrl: 'http://llm.invalid', apiKey: 'x', model: 'm', timeZone: 'Not/AZone' }));
});

test('provider: start dates are shown as calendar days of the configured zone, like the reference time', async () => {
  // midnight in Shanghai is the previous day in UTC
  const start = new Date('2026-03-01T00:00:00+08:00');
  const prompt = buildExtractionPrompt(
    'text',
    [],
    [{ sourceName: 'Alice', targetName: 'Acme', relation: 'WORKS_AT', fact: 'Alice works at Acme', validAt: start }],
    { referenceTime: new Date('2026-03-02T01:00:00Z') },
    'Asia/Shanghai',
  );
  assert.match(prompt, /Alice works at Acme \(since 2026-03-01\)/);

  await withChatStub(
    () => ({ contradicts: false, which: [] }),
    async (requests) => {
      const llm = new OpenAICompatLLM({ baseUrl: 'http://llm.invalid', apiKey: 'test', model: 'stub', timeZone: 'Asia/Shanghai', retries: 1 });
      await llm.detectContradiction({ sourceName: 'Alice', targetName: 'Globex', fact: 'Alice joined Globex', validAt: start, replacesPrevious: true }, [
        { fact: 'Alice works at Acme', validAt: start },
      ]);
      assert.equal(userOf(requests[0]).match(/\(since 2026-03-01\)/g)?.length, 2);
      assert.match(userOf(requests[0]), /^New fact \(it replaces an earlier value\): Alice joined Globex/);
    },
  );
});

test('provider: buildLLM fails on an invalid MINIZEP_TIMEZONE instead of falling back to the mock extractor', () => {
  const keys = ['MINIZEP_LLM_API_KEY', 'MINIZEP_LLM_BASE_URL', 'MINIZEP_TIMEZONE', 'MINIZEP_REQUIRE_REAL_PROVIDERS'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.MINIZEP_LLM_API_KEY = 'test';
    process.env.MINIZEP_LLM_BASE_URL = 'http://llm.invalid';
    delete process.env.MINIZEP_REQUIRE_REAL_PROVIDERS;
    process.env.MINIZEP_TIMEZONE = 'Asia/Shanghia';
    assert.throws(() => buildLLM(), /invalid time zone "Asia\/Shanghia"/);
    process.env.MINIZEP_TIMEZONE = 'Asia/Shanghai';
    assert.ok(buildLLM().llm instanceof OpenAICompatLLM);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('provider: facts may reference known entities that the reply did not list again', async () => {
  await withChatStub(
    () => ({
      entities: [{ name: 'Globex', labels: ['Organization'], summary: '' }],
      facts: [
        { sourceName: 'Alice Chen', targetName: 'Globex', relation: 'WORKS_AT', fact: 'Alice Chen joined Globex', validAt: '2026-02-27T00:00:00+00:00', replacesPrevious: true },
        { sourceName: 'Alice Chen', targetName: 'Globex', relation: 'OWNS_SHARES_IN', fact: 'Alice Chen owns shares in Globex', replacesPrevious: 'yes' },
      ],
      invalidations: [],
    }),
    async () => {
      const out = await stubLLM().extract('She joined Globex.', ['Alice Chen'], []);
      assert.equal(out.facts.length, 2, 'the pipeline, not the provider, decides whether an endpoint resolves');
      assert.equal(out.facts[0].validAt?.toISOString(), '2026-02-27T00:00:00.000Z');
      assert.deepEqual(out.facts.map((f) => f.replacesPrevious), [true, undefined], 'only an explicit true replaces');
    },
  );
});

test('provider: detectContradiction uses its own prompt and returns the indexes in "which"', async () => {
  await withChatStub(
    () => ({ contradicts: true, which: [2] }),
    async (requests) => {
      const ended = await stubLLM().detectContradiction(
        { sourceName: 'Alice', targetName: 'Acme', fact: 'Alice was promoted to CTO of Acme', validAt: new Date('2025-01-01') },
        [{ fact: 'Alice owns shares in Acme' }, { fact: 'Alice is a senior engineer at Acme', validAt: new Date('2024-01-01') }],
      );
      assert.deepEqual(ended, [1], '"which" is 1-based in the prompt');
      const system = systemOf(requests[0]);
      assert.doesNotMatch(system, /extract a temporal knowledge graph/, 'not the extraction prompt');
      assert.match(system, /"which"/);
      // strict: only facts that cannot both hold are ended, and doubt ends nothing
      assert.match(system, /ended ONLY when it and the new fact cannot both be true at the same time/);
      assert.match(system, /a restatement, elaboration or confirmation of the same relationship/);
      assert.match(system, /another value of a relationship that can have several at once/);
      assert.match(system, /does not replace, is separate from, or is in addition to another/);
      assert.match(system, /When unsure, the existing fact is not ended/);
      assert.match(userOf(requests[0]), /^New fact: Alice was promoted/);
      assert.match(userOf(requests[0]), /2\. Alice is a senior engineer at Acme \(since 2024-01-01\)/);
    },
  );
  assert.deepEqual(await stubLLM().detectContradiction({ sourceName: 'a', targetName: 'b', fact: 'x' }, []), [], 'no call for nothing');
});

test('provider: parseContradiction tolerates the shapes models actually return', () => {
  assert.deepEqual(parseContradiction({ contradicts: true, which: [1] }, 3), [0]);
  assert.deepEqual(parseContradiction({ contradicts: true, which: ['3', 1, 1] }, 3), [2, 0]);
  assert.deepEqual(parseContradiction({ contradicts: true, which: 2 }, 3), [1], 'a bare number');
  // an off-by-one (0-based) or out-of-range answer must not close every candidate
  assert.deepEqual(parseContradiction({ contradicts: true, which: [0] }, 3), [], 'no usable index: none');
  assert.deepEqual(parseContradiction({ contradicts: true, which: [0, 9] }, 3), []);
  assert.deepEqual(parseContradiction({ contradicts: true, which: [] }, 3), []);
  assert.deepEqual(parseContradiction({ contradicts: true }, 2), [0, 1], 'no list at all: the old boolean contract');
  assert.deepEqual(parseContradiction({ contradicts: true, which: null }, 2), [0, 1]);
  assert.deepEqual(parseContradiction({ contradicts: false, which: [1] }, 2), []);
  assert.deepEqual(parseContradiction({ which: [2] }, 2), [1]);
  assert.deepEqual(parseContradiction({}, 2), []);
});

test('provider: the mock provider follows the index contract and leaves the end time to the pipeline', async () => {
  const mock = new MockLLMProvider();
  assert.deepEqual(await mock.detectContradiction({ sourceName: 'a', targetName: 'b', fact: 'Alice left' }, [{ fact: 'x' }, { fact: 'Alice joins' }]), [1]);
  const out = await mock.extract('Alice left Acme', [], []);
  assert.equal(out.invalidations[0].invalidAt, undefined);
});

/* ---------------- FallbackEmbedder ---------------- */

const failing = (message: string): Embedder => ({
  async embed() {
    throw new Error(message);
  },
});

test('embedder: FallbackEmbedder throws when every tier fails, instead of switching to hash vectors', async () => {
  await assert.rejects(new FallbackEmbedder([failing('fetch failed')]).embed('x'), /all embedding tiers failed.*fetch failed/);
});

test('embedder: the hash fallback is opt-in, and one instance never mixes vector spaces', async () => {
  const offline = new FallbackEmbedder([failing('down')], { allowHash: true, dims: 32 });
  assert.equal((await offline.embed('x')).length, 32);
  assert.equal(offline.dims, 32);

  let up = true;
  const flaky: Embedder = {
    async embed(t: string) {
      if (!up) throw new Error('down');
      return new HashEmbedder(16).embed(t);
    },
  };
  const model = new FallbackEmbedder([flaky], { allowHash: true });
  assert.equal((await model.embed('x')).length, 16);
  up = false;
  await assert.rejects(model.embed('y'), /all embedding tiers failed/, 'model vectors were served: no hash from now on');

  const hashFirst = new FallbackEmbedder([flaky], { allowHash: true, dims: 16 });
  assert.equal((await hashFirst.embedTraced('x')).tier, 'HashEmbedder');
  up = true;
  assert.equal((await hashFirst.embedTraced('y')).tier, 'HashEmbedder', 'hash vectors were served: stay in that space');
});

test('embedder: a tier answering with another dimension is skipped', async () => {
  const e = new FallbackEmbedder([new HashEmbedder(16), new HashEmbedder(8)]);
  assert.equal((await e.embed('x')).length, 16);
  const second = new FallbackEmbedder([failing('down'), new HashEmbedder(8)]);
  assert.equal((await second.embed('x')).length, 8);
  const mixed = new FallbackEmbedder([
    { embed: async (t: string) => (t === 'a' ? new HashEmbedder(16).embed(t) : new HashEmbedder(8).embed(t)) },
  ]);
  await mixed.embed('a');
  await assert.rejects(mixed.embed('b'), /8 dims, expected 16/);
});
