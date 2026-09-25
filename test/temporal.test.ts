import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { isFactActive } from '../src/model/types.js';
import { ScriptedLLM, deterministicEmbedder, entity, fact, invalidation } from './helpers.js';

/** Build a Minizep instance driven by a scripted extraction per content string. */
function build(script: Record<string, ReturnType<typeof scenario>>, contradictions = false) {
  const llm = new ScriptedLLM((content) => script[content] ?? { entities: [], facts: [], invalidations: [] }, contradictions);
  return new Minizep({ llm, embedder: deterministicEmbedder() });
}
function scenario(entities: ReturnType<typeof entity>[], facts: ReturnType<typeof fact>[], invalidations: ReturnType<typeof invalidation>[] = []) {
  return { entities, facts, invalidations };
}

const TODAY = scenario(
  [entity('Alice'), entity('Acme', ['Organization'])],
  [fact('Alice', 'Acme', 'WORKS_AT')],
);

test('temporal: a fresh fact is active and reports no end', async () => {
  const zep = build({ 'alice works at acme': TODAY });
  const { episode } = await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });

  const [row] = await zep.factsAbout('Alice', { groupId: 'g' });
  assert.ok(row, 'fact should exist');
  assert.equal(row.fact.name, 'WORKS_AT');
  assert.equal(row.fact.invalidAt, undefined);
  assert.equal(row.fact.expiredAt, undefined);
  assert.equal(row.fact.validAt?.getTime(), episode.validAt.getTime());
  assert.equal(isFactActive(row.fact), true);
});

test('temporal: an invalidation closes the relation without creating a new edge', async () => {
  const zep = build({
    'alice works at acme': TODAY,
    'alice left acme': scenario(
      [entity('Alice'), entity('Acme', ['Organization'])],
      [],
      [invalidation('Alice', 'Acme', 'WORKS_AT')],
    ),
  });

  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  // the termination must not be modelled as its own relationship
  assert.equal(res.facts.length, 0, 'no LEFT/ENDED edge may be created');
  assert.equal(res.invalidated.length, 1);

  const all = await zep.store.getFacts('g');
  assert.equal(all.length, 1, 'graph still has exactly one edge');

  const closed = all[0];
  assert.ok(closed.expiredAt, 'expiredAt must be set (we no longer believe it)');
  assert.ok(closed.invalidAt, 'invalidAt must be set (it stopped being true)');
  assert.equal(isFactActive(closed), false);
});

test('temporal: invalidated facts are kept for history, not deleted', async () => {
  const zep = build({
    'alice works at acme': TODAY,
    'alice left acme': scenario([], [], [invalidation('Alice', 'Acme', 'WORKS_AT')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  const current = await zep.factsAbout('Alice', { groupId: 'g' });
  assert.equal(current.length, 0, 'no active facts remain');

  const historical = await zep.factsAbout('Alice', { groupId: 'g', includeHistorical: true });
  assert.equal(historical.length, 1, 'the superseded fact is still retrievable');
});

test('temporal: time travel returns what was true at an instant', async () => {
  const past = new Date('2020-01-01T00:00:00Z');
  const zep = build({
    'alice worked at oldco in 2020': scenario(
      [entity('Alice'), entity('OldCo', ['Organization'])],
      [fact('Alice', 'OldCo', 'WORKS_AT', { validAt: past, invalidAt: new Date('2021-01-01T00:00:00Z') })],
    ),
    'alice works at acme': TODAY,
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice worked at oldco in 2020' });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme' });

  const in2020 = await zep.factsAt(new Date('2020-06-01T00:00:00Z'), 'g');
  assert.deepEqual(in2020.map((f) => f.targetName), ['OldCo']);

  const now = await zep.factsAt(new Date(), 'g');
  assert.deepEqual(now.map((f) => f.targetName), ['Acme']);

  const in2025 = await zep.factsAt(new Date('2025-06-01T00:00:00Z'), 'g');
  assert.equal(in2025.length, 0, 'between the two jobs nothing was true');
});

test('temporal: a fact dated in the future is not yet active', async () => {
  const future = new Date(Date.now() + 86_400_000);
  const zep = build({
    'alice will join futureco': scenario(
      [entity('Alice'), entity('FutureCo', ['Organization'])],
      [fact('Alice', 'FutureCo', 'WORKS_AT', { validAt: future })],
    ),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice will join futureco' });

  assert.equal((await zep.factsAbout('Alice', { groupId: 'g' })).length, 0);
  assert.equal((await zep.factsAbout('Alice', { groupId: 'g', includeHistorical: true })).length, 1);
  assert.equal((await zep.factsAt(future, 'g')).length, 1);
});

test('temporal: fact windows are half-open — a fact is inactive at its own invalidAt', async () => {
  const end = new Date('2024-06-01T00:00:00Z');
  const f = {
    validAt: new Date('2024-01-01T00:00:00Z'),
    invalidAt: end,
  } as Parameters<typeof isFactActive>[0];
  assert.equal(isFactActive(f, new Date(end.getTime() - 1)), true);
  assert.equal(isFactActive(f, end), false, 'inactive exactly at invalidAt');
  assert.equal(isFactActive(f, new Date(end.getTime() + 1)), false);
});

/* ---------------- out-of-order and superseding episodes ---------------- */

const d = (s: string) => new Date(s);
const says = (source: string, target: string, relation: string, text: string, extra: Partial<{ validAt: Date; invalidAt: Date }> = {}) => ({
  sourceName: source,
  targetName: target,
  relation,
  fact: text,
  ...extra,
});

/** A Minizep driven by a content -> extraction script plus a contradiction script. */
function scripted(
  script: Record<string, ReturnType<typeof scenario>>,
  contradictions: ConstructorParameters<typeof ScriptedLLM>[1] = false,
) {
  const llm = new ScriptedLLM((content) => script[content] ?? { entities: [], facts: [], invalidations: [] }, contradictions);
  return { llm, zep: new Minizep({ llm, embedder: deterministicEmbedder() }) };
}

test('temporal: regression R1 — backfilling an older document does not resurrect an ended relation', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  const { zep } = scripted({
    'Bob works at Initech': scenario(people, [fact('Bob', 'Initech', 'WORKS_AT')]),
    'Bob left Initech in Feb 2025': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-02-01'))]),
    // an OLDER document (2024-06) ingested after the termination
    'Bob is a senior developer at Initech': scenario(people, [fact('Bob', 'Initech', 'WORKS_AT')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2024-01-15') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech in Feb 2025', validAt: d('2025-03-01') });
  const backfill = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob is a senior developer at Initech', validAt: d('2024-06-01') });

  assert.equal((await zep.factsAt(new Date(), 'g')).length, 0, 'Bob is not currently at Initech');
  const all = await zep.store.getFacts('g');
  assert.equal(all.length, 1, 'the older mention reinforces the historical edge instead of creating one');
  assert.equal(backfill.reinforced.length, 1);
  assert.equal(all[0].invalidAt?.getTime(), d('2025-02-01').getTime(), 'the known end is kept');
  assert.equal(all[0].episodes.length, 2);
  assert.equal((await zep.factsAt(d('2024-09-01'), 'g')).length, 1, 'and it was true in 2024');
});

test('temporal: regression R2 — a contradiction closes the old fact at the new fact\'s valid time', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const { zep } = scripted(
    {
      'Alice is a junior engineer at Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice is a junior engineer at Acme')]),
      'In Jan 2022 Alice became CTO of Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice became CTO of Acme')]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice is a junior engineer at Acme', validAt: d('2020-01-01') });
  // ingested today, but describes 2022
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'In Jan 2022 Alice became CTO of Acme', validAt: d('2022-01-01') });

  const mid2023 = await zep.factsAt(d('2023-06-01'), 'g');
  assert.deepEqual(mid2023.map((r) => r.fact.fact), ['Alice became CTO of Acme'], 'exactly one title in mid-2023');
  assert.deepEqual((await zep.factsAt(d('2021-06-01'), 'g')).map((r) => r.fact.fact), ['Alice is a junior engineer at Acme']);

  const [old] = res.invalidated;
  assert.equal(old.invalidAt?.getTime(), d('2022-01-01').getTime(), 'closed at 2022-01-01, not at wall-clock now');
  assert.ok(old.expiredAt, 'expiredAt records when we learned it');
  for (const f of await zep.store.getFacts('g')) {
    assert.ok(!f.invalidAt || !f.validAt || f.invalidAt > f.validAt, `no inverted window: ${f.fact}`);
  }
});

test('temporal: regression R3 — only the facts the LLM names in "which" are closed', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const { zep, llm } = scripted(
    {
      'Alice is a senior engineer at Acme and owns shares in it': scenario(pair, [
        says('Alice', 'Acme', 'HAS_TITLE', 'Alice is a senior engineer at Acme'),
        says('Alice', 'Acme', 'OWNS_SHARES_IN', 'Alice owns shares in Acme'),
      ]),
      'Alice was promoted to CTO of Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice was promoted to CTO of Acme')]),
    },
    (_cand, existing) => existing.flatMap((e, i) => (e.fact.includes('senior engineer') ? [i] : [])),
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice is a senior engineer at Acme and owns shares in it', validAt: d('2024-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice was promoted to CTO of Acme', validAt: d('2025-01-01') });

  assert.equal(llm.contradictionCalls.length, 1, 'facts from one episode are not checked against each other');
  assert.equal(llm.contradictionCalls[0].existing.length, 2, 'both active facts between the pair were offered');
  assert.deepEqual(res.invalidated.map((f) => f.name), ['HAS_TITLE']);
  const now = await zep.factsAt(new Date(), 'g');
  assert.deepEqual(now.map((r) => r.fact.name).sort(), ['HAS_TITLE', 'OWNS_SHARES_IN'], 'the shareholding survives');
});

test('temporal: a new value of a functional attribute supersedes the old one (same source + relation, other target)', async () => {
  const { zep, llm } = scripted(
    {
      'Alice Chen is a backend engineer on the payments team': scenario(
        [entity('Alice Chen'), entity('backend engineer', ['Role']), entity('payments team', ['Organization'])],
        [
          says('Alice Chen', 'backend engineer', 'HAS_ROLE', 'Alice Chen works as a backend engineer'),
          says('Alice Chen', 'payments team', 'MEMBER_OF', 'Alice Chen is on the payments team'),
        ],
      ),
      'Alice Chen is now a Staff Engineer': scenario(
        [entity('Alice Chen'), entity('Staff Engineer', ['Role'])],
        [says('Alice Chen', 'Staff Engineer', 'HAS_ROLE', 'Alice Chen is a Staff Engineer')],
      ),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen is a backend engineer on the payments team', validAt: d('2024-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen is now a Staff Engineer', validAt: d('2026-03-01') });

  assert.deepEqual(
    llm.contradictionCalls[0].existing.map((e) => e.fact),
    ['Alice Chen works as a backend engineer'],
    'the same-slot fact is a candidate; the team membership (another relation) is not',
  );
  assert.deepEqual(res.invalidated.map((f) => f.fact), ['Alice Chen works as a backend engineer']);
  assert.equal(res.invalidated[0].invalidAt?.getTime(), d('2026-03-01').getTime());
  const roles = (await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact).sort();
  assert.deepEqual(roles, ['Alice Chen is a Staff Engineer', 'Alice Chen is on the payments team']);
});

test('temporal: leaving a company ends the facts that depended on it (dependent invalidations)', async () => {
  const { zep } = scripted({
    'Alice Chen is a backend engineer on the payments team at Acme Corp': scenario(
      [entity('Alice Chen'), entity('Acme Corp', ['Organization']), entity('backend engineer', ['Role']), entity('payments team', ['Organization'])],
      [
        says('Alice Chen', 'Acme Corp', 'WORKS_AT', 'Alice Chen works at Acme Corp'),
        says('Alice Chen', 'backend engineer', 'HAS_ROLE', 'Alice Chen is a backend engineer at Acme Corp'),
        says('Alice Chen', 'payments team', 'MEMBER_OF', 'Alice Chen is on the payments team at Acme Corp'),
      ],
    ),
    'Alice Chen left Acme Corp and joined Globex as a Staff Engineer': scenario(
      [entity('Alice Chen'), entity('Globex', ['Organization']), entity('Staff Engineer', ['Role'])],
      [
        says('Alice Chen', 'Globex', 'WORKS_AT', 'Alice Chen joined Globex as a Staff Engineer'),
        says('Alice Chen', 'Staff Engineer', 'HAS_ROLE', 'Alice Chen is a Staff Engineer at Globex'),
      ],
      [
        invalidation('Alice Chen', 'Acme Corp', 'WORKS_AT', d('2026-02-27')),
        invalidation('Alice Chen', 'backend engineer', 'HAS_ROLE', d('2026-02-27')),
        invalidation('Alice Chen', 'payments team', 'MEMBER_OF', d('2026-02-27')),
      ],
    ),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen is a backend engineer on the payments team at Acme Corp', validAt: d('2024-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen left Acme Corp and joined Globex as a Staff Engineer', validAt: d('2026-03-02') });

  assert.deepEqual(res.invalidated.map((f) => f.name).sort(), ['HAS_ROLE', 'MEMBER_OF', 'WORKS_AT']);
  for (const f of res.invalidated) assert.equal(f.invalidAt?.getTime(), d('2026-02-27').getTime());
  const now = (await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact).sort();
  assert.deepEqual(now, ['Alice Chen is a Staff Engineer at Globex', 'Alice Chen joined Globex as a Staff Engineer']);
});

test('temporal: an older statement that contradicts a newer fact is stored already closed', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const { zep } = scripted(
    {
      'Alice became CTO of Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice is CTO of Acme')]),
      'Alice is a junior engineer at Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice is a junior engineer at Acme')]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice became CTO of Acme', validAt: d('2022-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice is a junior engineer at Acme', validAt: d('2020-01-01') });

  assert.equal(res.invalidated.length, 0, 'an older episode cannot end a newer fact');
  const [junior] = res.facts;
  assert.equal(junior.validAt?.getTime(), d('2020-01-01').getTime());
  assert.equal(junior.invalidAt?.getTime(), d('2022-01-01').getTime(), 'it ends where the newer fact begins');
  assert.deepEqual((await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact), ['Alice is CTO of Acme']);
  assert.deepEqual((await zep.factsAt(d('2021-01-01'), 'g')).map((r) => r.fact.fact), ['Alice is a junior engineer at Acme']);
});

test('temporal: an older mention of the same fact extends its start back instead of adding an edge', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  const { zep } = scripted({
    'Bob works at Initech (2025)': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
    'Bob works at Initech (2024)': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech (2025)', validAt: d('2025-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech (2024)', validAt: d('2024-06-01') });

  const all = await zep.store.getFacts('g');
  assert.equal(all.length, 1);
  assert.equal(res.reinforced.length, 1);
  assert.equal(all[0].validAt?.getTime(), d('2024-06-01').getTime());
  assert.equal((await zep.factsAt(d('2024-09-01'), 'g')).length, 1);
});

test('temporal: an invalidation dated before a newer fact does not close it', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  const { zep } = scripted({
    'Bob rejoined Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob rejoined Initech')]),
    'Bob left Initech': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-02-01'))]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob rejoined Initech', validAt: d('2025-06-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech', validAt: d('2025-03-01') });

  assert.equal(res.invalidated.length, 0);
  assert.equal((await zep.factsAt(new Date(), 'g')).length, 1);
});

test('temporal: a change effective in the future keeps the old fact active until then', async () => {
  const day = 86_400_000;
  const start = new Date(Date.now() + 3 * day); // "effective next Monday"
  const { zep } = scripted(
    {
      'Tom Rivera is VP Finance at Initech': scenario(
        [entity('Tom Rivera'), entity('VP Finance', ['Role'])],
        [says('Tom Rivera', 'VP Finance', 'HAS_ROLE', 'Tom Rivera is VP Finance at Initech')],
      ),
      'Yesterday Tom Rivera was appointed CFO of Initech, effective next Monday': scenario(
        [entity('Tom Rivera'), entity('CFO', ['Role'])],
        [says('Tom Rivera', 'CFO', 'HAS_ROLE', 'Tom Rivera was appointed CFO of Initech', { validAt: start })],
      ),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Tom Rivera is VP Finance at Initech', validAt: d('2025-01-01') });
  const res = await zep.ingest.addEpisode({
    groupId: 'g',
    content: 'Yesterday Tom Rivera was appointed CFO of Initech, effective next Monday',
    validAt: new Date(Date.now() - day),
  });

  assert.equal(res.invalidated[0].invalidAt?.getTime(), start.getTime(), 'the old role ends when the new one starts');
  assert.equal(res.facts[0].validAt?.getTime(), start.getTime());
  const titles = async (at: Date) => (await zep.factsAt(at, 'g')).map((r) => r.targetName);
  assert.deepEqual(await titles(new Date()), ['VP Finance'], 'still VP Finance today');
  assert.deepEqual(await titles(new Date(start.getTime() + day)), ['CFO']);
});

test('temporal: paraphrases between the same endpoints reinforce one edge (embedding similarity)', async () => {
  // both sentences embed to the same vector; a real model puts them close
  const same = [1, 0, 0, 0];
  const embedder = {
    async embed(text: string) {
      return /works at|employed by/.test(text) ? same : [0, 1, 0, 0];
    },
  };
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const llm = new ScriptedLLM((content) =>
    content === 'one'
      ? scenario(pair, [says('Alice', 'Acme', 'WORKS_AT', 'Alice works at Acme')])
      : scenario(pair, [says('Alice', 'Acme', 'WORKS_AT', 'Alice is employed by Acme')]),
  );
  const zep = new Minizep({ llm, embedder });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'one' });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'two' });

  assert.equal(res.reinforced.length, 1);
  assert.equal(res.facts.length, 0);
  assert.equal((await zep.store.getFacts('g')).length, 1);
});

/* ---------------- bi-temporal queries ---------------- */

test('temporal: isFactActive separates valid time from knowledge time', () => {
  const learned = d('2025-01-01');
  const endLearned = d('2025-06-01');
  const f = {
    validAt: d('2024-01-01'),
    invalidAt: d('2025-03-01'),
    createdAt: learned,
    expiredAt: endLearned,
  } as Parameters<typeof isFactActive>[0];

  assert.equal(isFactActive(f, d('2024-06-01')), true, 'true in mid-2024');
  assert.equal(isFactActive(f, d('2025-04-01')), false, 'ended in March 2025');
  assert.equal(isFactActive(f, d('2025-04-01'), d('2025-05-01')), true, 'in May we did not know it had ended');
  assert.equal(isFactActive(f, d('2024-06-01'), d('2024-12-01')), false, 'in Dec 2024 we did not know the fact');
  // an end that came with the fact is known as soon as the fact is
  const withEnd = { ...f, expiredAt: undefined };
  assert.equal(isFactActive(withEnd, d('2025-04-01'), d('2025-02-01')), false);
  // an end scheduled in the future is not in effect yet
  const scheduled = { ...f, invalidAt: new Date(Date.now() + 86_400_000), expiredAt: new Date() };
  assert.equal(isFactActive(scheduled), true);
  // expired without any valid-time end: retracted as a whole once known
  const retracted = { ...f, invalidAt: undefined };
  assert.equal(isFactActive(retracted, d('2024-06-01')), false);
  assert.equal(isFactActive(retracted, d('2024-06-01'), d('2025-05-01')), true);
});

test('temporal: factsAt with asOf answers "what did we believe back then"', async () => {
  const { zep } = scripted({
    'alice works at acme': TODAY,
    'alice left acme': scenario([], [], [invalidation('Alice', 'Acme', 'WORKS_AT', d('2025-01-01'))]),
  });
  const beforeAnything = new Date(Date.now() - 1000);
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice works at acme', validAt: d('2024-01-01') });
  await new Promise((r) => setTimeout(r, 5));
  const beforeTheEnd = new Date();
  await new Promise((r) => setTimeout(r, 5));
  await zep.ingest.addEpisode({ groupId: 'g', content: 'alice left acme' });

  const mid2025 = d('2025-06-01');
  assert.equal((await zep.factsAt(mid2025, 'g')).length, 0, 'today we know it ended in January');
  assert.equal((await zep.factsAt(mid2025, 'g', { asOf: beforeTheEnd })).length, 1, 'back then we did not');
  assert.equal((await zep.factsAt(mid2025, 'g', { asOf: beforeAnything })).length, 0, 'before ingestion we knew nothing');
  assert.equal((await zep.factsAt(d('2024-06-01'), 'g', { limit: 0 })).length, 0, 'limit applies');
});
