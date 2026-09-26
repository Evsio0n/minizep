import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Minizep } from '../src/index.js';
import { factView, isFactActive, isFactKnown, type EntityEdge } from '../src/model/types.js';
import { ScriptedLLM, deterministicEmbedder, entity, fact, invalidation } from './helpers.js';
import type { LLMProvider } from '../src/provider/interfaces.js';

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
const says = (source: string, target: string, relation: string, text: string, extra: Partial<{ validAt: Date; invalidAt: Date; replacesPrevious: boolean }> = {}) => ({
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

test('temporal: a new value of a one-target relation supersedes the old one (same source + relation, other target); another value of a relation that holds several does not', async () => {
  const { zep, llm } = scripted(
    {
      'Alice Chen is a backend engineer on the payments team': scenario(
        [entity('Alice Chen'), entity('backend engineer', ['Role']), entity('payments team', ['Organization'])],
        [
          says('Alice Chen', 'backend engineer', 'HAS_ROLE', 'Alice Chen works as a backend engineer'),
          says('Alice Chen', 'payments team', 'MEMBER_OF', 'Alice Chen is on the payments team'),
        ],
      ),
      // a relation that holds several values at once: nothing is replaced
      'Alice Chen also joined the platform team': scenario(
        [entity('Alice Chen'), entity('platform team', ['Organization'])],
        [says('Alice Chen', 'platform team', 'MEMBER_OF', 'Alice Chen also joined the platform team')],
      ),
      // HAS_ROLE holds one value at a time, whether or not the extraction marks it
      'Alice Chen is now a Staff Engineer': scenario(
        [entity('Alice Chen'), entity('Staff Engineer', ['Role'])],
        [says('Alice Chen', 'Staff Engineer', 'HAS_ROLE', 'Alice Chen is a Staff Engineer')],
      ),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen is a backend engineer on the payments team', validAt: d('2024-01-01') });
  const also = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen also joined the platform team', validAt: d('2025-01-01') });
  assert.equal(llm.contradictionCalls.length, 0, 'the other team is not even a candidate');
  assert.equal(also.invalidated.length, 0);
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice Chen is now a Staff Engineer', validAt: d('2026-03-01') });

  assert.deepEqual(
    llm.contradictionCalls[0].existing.map((e) => e.fact),
    ['Alice Chen works as a backend engineer'],
    'the same-slot fact is a candidate; the team memberships (another relation) are not',
  );
  assert.deepEqual(res.invalidated.map((f) => f.fact), ['Alice Chen works as a backend engineer']);
  assert.equal(res.invalidated[0].invalidAt?.getTime(), d('2026-03-01').getTime());
  const roles = (await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact).sort();
  assert.deepEqual(roles, ['Alice Chen also joined the platform team', 'Alice Chen is a Staff Engineer', 'Alice Chen is on the payments team']);

  // a relation the pipeline does not know holds one target: the extraction's replacesPrevious says so
  const owned = (team: string, extra = {}) =>
    scenario([entity('Atlas', ['Project']), entity(team, ['Organization'])], [says('Atlas', team, 'OWNED_BY', `Atlas is owned by the ${team}`, extra)]);
  const owners = scripted(
    { platform: owned('platform team', { replacesPrevious: true }), payments: owned('payments team'), data: owned('data team', { replacesPrevious: true }) },
    true,
  );
  await owners.zep.ingest.addEpisode({ groupId: 'g', content: 'platform', validAt: d('2025-06-01') });
  // an older document added late, not marked: the value that replaced it later still caps it
  await owners.zep.ingest.addEpisode({ groupId: 'g', content: 'payments', validAt: d('2025-01-01') });
  await owners.zep.ingest.addEpisode({ groupId: 'g', content: 'data', validAt: d('2026-01-01') });
  assert.deepEqual(owners.llm.contradictionCalls.map((c) => c.existing.map((e) => e.fact)), [
    ['Atlas is owned by the platform team'],
    ['Atlas is owned by the platform team'],
  ]);
  const owner = async (at: string) => (await owners.zep.factsAt(d(at), 'g')).map((r) => r.targetName);
  assert.deepEqual(await owner('2025-03-01'), ['payments team']);
  assert.deepEqual(await owner('2025-09-01'), ['platform team']);
  assert.deepEqual(await owner('2026-03-01'), ['data team']);
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
  // a model may also judge the older statement not to end the newer one: an
  // earlier record of the same (source, relation, target) still ends there.
  // The newer fact is dated by its episode, or by its own text in a note
  // written today without valid_at: either way its start is known, and it wins
  for (const datedBy of ['episode', 'text'] as const) for (const contradicts of [true, false]) {
    const cto = says('Alice', 'Acme', 'HAS_TITLE', 'Alice is CTO of Acme', datedBy === 'text' ? { validAt: d('2022-01-01') } : {});
    const { zep } = scripted(
      {
        'Alice became CTO of Acme': scenario(pair, [cto]),
        'Alice is a junior engineer at Acme': scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice is a junior engineer at Acme')]),
      },
      contradicts,
    );
    const newer = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice became CTO of Acme', validAt: datedBy === 'episode' ? d('2022-01-01') : undefined });
    assert.deepEqual([newer.facts[0].validAt, newer.facts[0].attributes.startFromEpisode], [d('2022-01-01'), undefined], `a known start (${datedBy})`);
    const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice is a junior engineer at Acme', validAt: d('2020-01-01') });

    assert.equal(res.invalidated.length, 0, 'an older episode cannot end a newer fact');
    const [junior] = res.facts;
    assert.equal(junior.validAt?.getTime(), d('2020-01-01').getTime());
    assert.equal(junior.invalidAt?.getTime(), d('2022-01-01').getTime(), `it ends where the newer fact begins (contradicts: ${contradicts}, dated by ${datedBy})`);
    assert.deepEqual((await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact), ['Alice is CTO of Acme']);
    assert.deepEqual((await zep.factsAt(d('2021-01-01'), 'g')).map((r) => r.fact.fact), ['Alice is a junior engineer at Acme']);
  }
});

test('temporal: an earlier-dated change ends a fact whose start is only when its note was written, whether the judge or an invalidation says so', async () => {
  const day = 86_400_000;
  const moved = new Date(Date.now() - 90 * day); // "in July"
  const between = new Date(Date.now() - 45 * day); // a day in August
  const STALE = "Dana Wu's home is at Maple Court, Block 1";
  const MOVE = 'Dana Wu moved from Maple Court to Cedar Tower in July; the old address is no longer used';
  // the city is the entity, the address only in the sentence
  const home = (text: string, ends: ReturnType<typeof invalidation>[] = []) =>
    scenario([entity('Dana Wu'), entity('Riverton', ['Location'])], [says('Dana Wu', 'Riverton', 'LIVES_IN', text)], ends);
  // the change is read as replacing the note by the judge, or only by an explicit invalidation;
  // the stale note carries no valid_at, or one an agent set to the moment it wrote it
  for (const [invalidates, judge] of [[false, true], [true, false]] as const) {
    for (const staleValidAt of [undefined, new Date()]) {
      const where = `invalidation: ${invalidates}, valid_at: ${staleValidAt ? 'now' : 'none'}`;
      const { zep } = scripted(
        { stale: home(STALE), move: home(MOVE, invalidates ? [invalidation('Dana Wu', 'Riverton', 'LIVES_IN', moved)] : []) },
        judge,
      );
      const [note] = (await zep.ingest.addEpisode({ groupId: 'g', content: 'stale', validAt: staleValidAt })).facts;
      assert.equal(note.attributes.startFromEpisode, true, 'the start is only when the note was written');
      const change = await zep.ingest.addEpisode({ groupId: 'g', content: 'move', validAt: moved });

      const [cedar] = change.facts;
      assert.deepEqual([cedar.validAt, cedar.invalidAt, cedar.attributes.startFromEpisode], [moved, undefined, undefined], `not capped at the note's start (${where})`);
      assert.deepEqual(change.invalidated.map((f) => f.uuid), [note.uuid]);
      const stale = (await zep.store.getFact(note.uuid))!;
      assert.deepEqual([stale.invalidAt, stale.attributes.outdatedWhenWritten], [note.validAt, true], 'an empty window at its recorded start');
      assert.equal(factView(stale)?.state, 'retracted');
      const homes = async (at: Date) => (await zep.factsAt(at, 'g')).map((r) => r.fact.fact);
      assert.deepEqual(await homes(new Date()), [MOVE], `Cedar Tower now, not Maple Court (${where})`);
      assert.deepEqual(await homes(between), [MOVE]);

      // forgetting the change brings the note back as it was
      const undone = await zep.ingest.forgetEpisode(change.episode.uuid, { groupId: 'g', reason: 'wrong note' });
      assert.deepEqual(undone.reopened.map((r) => r.previous.uuid), [note.uuid]);
      assert.deepEqual(await homes(new Date()), [STALE]);
    }
  }

  // an earlier value that had ended before the note was written does not make it out of date
  const lakeside = says('Dana Wu', 'Lakeside', 'LIVES_IN', 'Dana Wu lived in Lakeside', { validAt: d('2019-01-01'), invalidAt: d('2020-01-01') });
  const { zep, llm } = scripted({ stale: home(STALE), earlier: scenario([entity('Dana Wu'), entity('Lakeside', ['Location'])], [lakeside]) }, true);
  await zep.ingest.addEpisode({ groupId: 'g', content: 'stale' });
  const earlier = await zep.ingest.addEpisode({ groupId: 'g', content: 'earlier', validAt: d('2019-01-01') });
  assert.deepEqual(llm.contradictionCalls.map((c) => c.existing.map((e) => e.fact)), [[STALE]], 'the judge ends the note');
  assert.deepEqual(earlier.invalidated, [], 'but Lakeside was over before it was written');
  assert.deepEqual((await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact), [STALE]);
});

test('temporal: an older, differently worded statement before an ended stint does not reopen the relation', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  const { zep } = scripted({
    'Bob works at Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
    'Bob left Initech': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-06-01'))]),
    'Bob is a senior developer at Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob is a senior developer at Initech')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2025-01-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech', validAt: d('2025-07-01') });
  // older than anything known, and not covered by the ended record
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob is a senior developer at Initech', validAt: d('2024-06-01') });

  assert.equal(res.facts[0].invalidAt?.getTime(), d('2025-01-01').getTime(), 'it runs into the later record');
  assert.equal((await zep.factsAt(new Date(), 'g')).length, 0, 'Bob is not at Initech today');
  assert.equal((await zep.factsAt(d('2024-09-01'), 'g')).length, 1);
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

test('temporal: a statement the judge says holds alongside a fact of the same pair and relation is a fact of its own; a restatement is evidence', async () => {
  const pair = [entity('model M', ['Product']), entity('benchmark B1', ['Concept'])];
  const run = (text: string) => scenario(pair, [says('model M', 'benchmark B1', 'EVALUATED_ON', text)]);
  const { zep, llm } = scripted(
    {
      'job 11': run('Job 11 evaluated model M on benchmark B1 with a score of 0.71'),
      'job 12': run('Job 12 evaluated model M on benchmark B1 with a score of 0.74; it does not replace job 11'),
      'job 11 again': run('The job 11 score of 0.71 for model M on benchmark B1 still stands'),
    },
    // nothing ends; only the confirmation restates a fact, job 11's
    (cand, existing) => ({
      ended: [],
      same: cand.fact.startsWith('The job 11') ? existing.flatMap((e, i) => (e.fact.startsWith('Job 11') ? [i] : [])) : [],
    }),
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'job 11', validAt: d('2026-01-01') });
  const twelve = await zep.ingest.addEpisode({ groupId: 'g', content: 'job 12', validAt: d('2026-02-01') });
  assert.deepEqual([twelve.facts.length, twelve.reinforced.length, twelve.invalidated.length], [1, 0, 0], 'not folded into job 11');

  const again = await zep.ingest.addEpisode({ groupId: 'g', content: 'job 11 again', validAt: d('2026-03-01') });
  assert.equal(llm.contradictionCalls.at(-1)!.existing.length, 2);
  assert.deepEqual([again.facts.length, again.reinforced.map((f) => f.fact)], [0, ['Job 11 evaluated model M on benchmark B1 with a score of 0.71']]);
  const now = (await zep.factsAt(new Date(), 'g')).map((r) => r.fact.fact).sort();
  assert.deepEqual(now, [
    'Job 11 evaluated model M on benchmark B1 with a score of 0.71',
    'Job 12 evaluated model M on benchmark B1 with a score of 0.74; it does not replace job 11',
  ]);
});

test('temporal: regression R1 — a backfilled document worded differently does not resurrect the relation either', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  // whether the model says the new wording ends the old one, restates it or holds alongside it, Bob
  // is not at Initech today
  for (const contradicts of [false, true, 'alongside'] as const) {
    const { zep, llm } = scripted(
      {
        'Bob works at Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
        'Bob left Initech in Feb 2025': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-02-01'))]),
        // the prompt asks for detailed sentences, so a later mention rarely repeats the words
        'Bob is a senior developer at Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob is a senior developer at Initech')]),
      },
      contradicts === 'alongside' ? () => ({ ended: [], same: [] }) : contradicts,
    );
    await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2024-01-15') });
    await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech in Feb 2025', validAt: d('2025-03-01') });
    const backfill = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob is a senior developer at Initech', validAt: d('2024-06-01') });

    assert.deepEqual(llm.contradictionCalls.map((c) => c.existing.map((e) => e.fact)), [['Bob works at Initech']], 'the ended record is checked');
    assert.equal((await zep.factsAt(new Date(), 'g')).length, 0, `Bob is not at Initech today (contradicts: ${contradicts})`);
    assert.equal((await zep.factsAt(d('2024-09-01'), 'g')).length, contradicts === 'alongside' ? 2 : 1, 'he was in 2024');
    const windows = (await zep.store.getFacts('g')).map((f) => [f.fact, f.validAt?.toISOString().slice(0, 10), f.invalidAt?.toISOString().slice(0, 10)]);
    if (contradicts === 'alongside') {
      // a fact of its own next to the old one, within the old one's known end
      assert.deepEqual(windows, [
        ['Bob works at Initech', '2024-01-15', '2025-02-01'],
        ['Bob is a senior developer at Initech', '2024-06-01', '2025-02-01'],
      ]);
    } else if (contradicts) {
      // the new wording took over from the old one, within its known end
      assert.deepEqual(windows, [
        ['Bob works at Initech', '2024-01-15', '2024-06-01'],
        ['Bob is a senior developer at Initech', '2024-06-01', '2025-02-01'],
      ]);
    } else {
      // the same relationship, described differently: more evidence for it
      assert.deepEqual(windows, [['Bob works at Initech', '2024-01-15', '2025-02-01']]);
      assert.equal(backfill.reinforced.length, 1);
    }
  }
});

test('temporal: a statement dated only by an episode written the day a relation ended reinforces it; an explicit start there is a new stint', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  const works = scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]);
  const { zep, llm } = scripted(
    {
      'Bob works at Initech': works,
      'Bob left Initech': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-02-01'))]),
      'email signed "Bob, Initech"': works,
      'email signed "Bob, senior developer, Initech"': scenario(people, [
        says('Bob', 'Initech', 'WORKS_AT', 'Bob is a senior developer at Initech'),
      ]),
      'Bob rejoined Initech on 2025-02-01': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech', { validAt: d('2025-02-01') })]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2024-01-15') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech', validAt: d('2025-03-01') });

  // date-only episode time, the day he left: still the relationship that ended,
  // however it is worded (and it had already ended: nothing to check against)
  for (const content of ['email signed "Bob, Initech"', 'email signed "Bob, senior developer, Initech"']) {
    const email = await zep.ingest.addEpisode({ groupId: 'g', content, validAt: d('2025-02-01') });
    assert.equal(email.reinforced.length, 1, content);
    assert.equal(email.facts.length, 0);
    assert.equal((await zep.factsAt(new Date(), 'g')).length, 0, 'not resurrected');
  }
  assert.equal(llm.contradictionCalls.length, 0);

  // the text itself says a stint starts at that instant: windows are half-open, so it is a new one
  const rejoined = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob rejoined Initech on 2025-02-01', validAt: d('2025-06-01') });
  assert.equal(rejoined.facts.length, 1);
  const windows = (await zep.store.getFacts('g')).map((f) => [f.validAt?.toISOString().slice(0, 10), f.invalidAt?.toISOString().slice(0, 10)]);
  assert.deepEqual(windows, [
    ['2024-01-15', '2025-02-01'],
    ['2025-02-01', undefined],
  ]);
});

test('temporal: a window whose end does not follow its start is never stored open-ended', async () => {
  const { zep } = scripted({
    // "joined Acme in 2020 and left later that year": year precision collapses both dates
    'Alice joined Acme in 2020 and left later that year': scenario(
      [entity('Alice'), entity('Acme', ['Organization'])],
      [says('Alice', 'Acme', 'WORKS_AT', 'Alice worked at Acme in 2020', { validAt: d('2020-01-01'), invalidAt: d('2020-01-01') })],
    ),
    // a model mixing up the two dates
    'Alice worked at Globex': scenario(
      [entity('Alice'), entity('Globex', ['Organization'])],
      [says('Alice', 'Globex', 'WORKS_AT', 'Alice worked at Globex', { validAt: d('2022-06-01'), invalidAt: d('2021-01-01') })],
    ),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice joined Acme in 2020 and left later that year', validAt: d('2024-05-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice worked at Globex', validAt: d('2024-05-02') });

  const [acme, globex] = await zep.store.getFacts('g');
  assert.deepEqual([acme.validAt?.toISOString(), acme.invalidAt?.toISOString()], ['2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z'], 'the same instant: that day');
  assert.deepEqual([globex.validAt, globex.invalidAt?.toISOString()], [undefined, '2021-01-01T00:00:00.000Z'], 'inverted: the end is kept');
  assert.equal((await zep.factsAt(new Date(), 'g')).length, 0, 'neither is current');
  assert.equal((await zep.factsAt(d('2020-01-01T12:00:00Z'), 'g')).length, 2);
});

test('temporal: when coarse dates give the old and the new value the same start, the old one keeps a non-empty window', async () => {
  // month precision: "in March 2024" is 2024-03-01 for both
  const { zep } = scripted(
    {
      'Alice joined Acme as an engineer in March': scenario(
        [entity('Alice'), entity('engineer', ['Role'])],
        [says('Alice', 'engineer', 'HAS_ROLE', 'Alice joined Acme as an engineer', { validAt: d('2024-03-01') })],
      ),
      'Alice was promoted to senior engineer in March': scenario(
        [entity('Alice'), entity('senior engineer', ['Role'])],
        [says('Alice', 'senior engineer', 'HAS_ROLE', 'Alice was promoted to senior engineer', { validAt: d('2024-03-01') })],
      ),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice joined Acme as an engineer in March', validAt: d('2024-03-05') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice was promoted to senior engineer in March', validAt: d('2024-03-28') });

  assert.equal(res.invalidated[0].invalidAt?.getTime(), d('2024-03-28').getTime(), 'the change had happened when it was written');
  const roles = async (at: Date) => (await zep.factsAt(at, 'g')).map((r) => r.targetName).sort();
  assert.deepEqual(await roles(d('2024-03-10')), ['engineer', 'senior engineer'], 'the engineer role still existed');
  assert.deepEqual(await roles(d('2024-04-01')), ['senior engineer']);
  for (const f of await zep.store.getFacts('g')) assert.ok(!f.invalidAt || f.invalidAt > f.validAt!, `non-empty window: ${f.fact}`);
});

test('temporal: two same-day notes (nothing later known) still leave the old value a non-empty window', async () => {
  const { zep } = scripted(
    {
      'Alice lives in Paris': scenario([entity('Alice'), entity('Paris', ['Location'])], [says('Alice', 'Paris', 'LIVES_IN', 'Alice lives in Paris')]),
      'Alice lives in Berlin': scenario([entity('Alice'), entity('Berlin', ['Location'])], [says('Alice', 'Berlin', 'LIVES_IN', 'Alice lives in Berlin')]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice lives in Paris', validAt: d('2025-01-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice lives in Berlin', validAt: d('2025-01-01') });

  const paris = (await zep.store.getFacts('g')).find((f) => f.fact.includes('Paris'))!;
  assert.ok(paris.invalidAt! > paris.validAt!, 'not an empty (retracted) window');
  assert.ok((await zep.factsAt(d('2025-01-01'), 'g')).some((r) => r.targetName === 'Paris'), 'Paris is still in history');
  assert.deepEqual((await zep.factsAt(new Date(), 'g')).map((r) => r.targetName), ['Berlin']);
});

test('temporal: an invalidation dated at the start of a fact (coarse dates) ends it when it was written', async () => {
  const { zep } = scripted({
    'Alice joined Acme in March': scenario(
      [entity('Alice'), entity('Acme', ['Organization'])],
      [says('Alice', 'Acme', 'WORKS_AT', 'Alice joined Acme', { validAt: d('2024-03-01') })],
    ),
    'Alice left Acme in March': scenario([], [], [invalidation('Alice', 'Acme', 'WORKS_AT', d('2024-03-01'))]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice joined Acme in March', validAt: d('2024-03-05') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice left Acme in March', validAt: d('2024-04-02') });

  assert.equal(res.invalidated[0].invalidAt?.getTime(), d('2024-04-02').getTime());
  assert.equal((await zep.factsAt(d('2024-03-10'), 'g')).length, 1, 'not erased from history');
  assert.equal((await zep.factsAt(new Date(), 'g')).length, 0);
});

test('temporal: a backfilled value is checked against the value that held then, not only against the live ones', async () => {
  // plain statements, none marked as replacing a value; the promotion also
  // invalidates the old title, as the extraction prompt asks
  const roles = (title: string, ends: ReturnType<typeof invalidation>[] = []) =>
    scenario([entity('Alice'), entity(title, ['Role'])], [says('Alice', title, 'HAS_ROLE', `Alice is ${title} at Acme`)], ends);
  const { zep, llm } = scripted(
    {
      junior: roles('junior engineer'),
      cto: roles('CTO', [invalidation('Alice', 'junior engineer', 'HAS_ROLE', d('2022-01-01'))]),
      senior: roles('senior engineer'),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'junior', validAt: d('2020-01-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'cto', validAt: d('2022-01-01') });
  // an older document, ingested last: in 2021 Alice was a senior engineer
  await zep.ingest.addEpisode({ groupId: 'g', content: 'senior', validAt: d('2021-01-01') });

  assert.deepEqual(
    llm.contradictionCalls.at(-1)!.existing.map((e) => e.fact).sort(),
    ['Alice is CTO at Acme', 'Alice is junior engineer at Acme'],
    'the (already ended) role that held in 2021 is a candidate too',
  );
  const at = async (t: string) => (await zep.factsAt(d(t), 'g')).map((r) => r.targetName);
  assert.deepEqual(await at('2020-06-01'), ['junior engineer']);
  assert.deepEqual(await at('2021-06-01'), ['senior engineer'], 'exactly one role in mid-2021');
  assert.deepEqual(await at('2023-06-01'), ['CTO']);
  assert.deepEqual(await at(new Date().toISOString()), ['CTO'], 'one current title');
});

test('temporal: a fact that starts in the future is a contradiction candidate', async () => {
  const soon = new Date(Date.now() + 30 * 86_400_000);
  const { zep, llm } = scripted(
    {
      'Alice will join Globex next month': scenario(
        [entity('Alice'), entity('Globex', ['Organization'])],
        [says('Alice', 'Globex', 'WORKS_AT', 'Alice will join Globex', { validAt: soon })],
      ),
      'Alice works at Acme': scenario([entity('Alice'), entity('Acme', ['Organization'])], [says('Alice', 'Acme', 'WORKS_AT', 'Alice works at Acme')]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice will join Globex next month' });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice works at Acme', validAt: d('2024-01-01') });

  assert.deepEqual(llm.contradictionCalls[0].existing.map((e) => e.fact), ['Alice will join Globex']);
  assert.equal(res.facts[0].invalidAt?.getTime(), soon.getTime(), 'Acme ends when Globex begins');
  assert.equal(res.invalidated.length, 0, 'an older statement does not end the newer fact');
});

test('temporal: an invalidation never moves an end that is already known', async () => {
  const { zep } = scripted({
    'Bob works at Initech': scenario([entity('Bob'), entity('Initech', ['Organization'])], [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
    'Bob left Initech in February': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-02-01'))]),
    'Bob no longer works at Initech': scenario([], [], [invalidation('Bob', 'Initech', 'WORKS_AT', d('2025-06-01'))]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2024-01-15') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Initech in February', validAt: d('2025-03-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob no longer works at Initech', validAt: d('2025-07-01') });

  assert.equal(res.invalidated.length, 0);
  const [f] = await zep.store.getFacts('g');
  assert.equal(f.invalidAt?.getTime(), d('2025-02-01').getTime(), 'the earlier end stands');
});

test('temporal: an earlier mention separated from a later stint by a transition is its own edge', async () => {
  const works = (org: string, text: string) => scenario([entity('Bob'), entity(org, ['Organization'])], [says('Bob', org, 'WORKS_AT', text)]);
  const { zep } = scripted({
    'Bob works at Globex': works('Globex', 'Bob works at Globex'),
    'Bob left Globex': scenario([], [], [invalidation('Bob', 'Globex', 'WORKS_AT', d('2023-12-01'))]),
    'Bob works at Initech (2024)': works('Initech', 'Bob works at Initech'),
    'Bob works at Initech (2022)': works('Initech', 'Bob works at Initech'),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Globex', validAt: d('2023-01-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob left Globex', validAt: d('2023-12-15') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech (2024)', validAt: d('2024-01-01') });
  // Bob was at Initech in 2022 too, but he worked elsewhere in between
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech (2022)', validAt: d('2022-06-01') });

  assert.equal(res.reinforced.length, 0);
  const initech = (await zep.store.getFacts('g')).filter((f) => f.fact.includes('Initech'));
  assert.deepEqual(
    initech.map((f) => [f.validAt?.toISOString().slice(0, 10), f.invalidAt?.toISOString().slice(0, 10)]),
    [
      ['2024-01-01', undefined],
      ['2022-06-01', '2024-01-01'],
    ],
    'the 2024 stint keeps its start',
  );
});

test('temporal: a provider answering with the old boolean `true` ends every candidate', async () => {
  const pair = [entity('Alice'), entity('Acme', ['Organization'])];
  const script: Record<string, ReturnType<typeof scenario>> = {
    one: scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice is a senior engineer at Acme'), says('Alice', 'Acme', 'OWNS_SHARES_IN', 'Alice owns shares in Acme')]),
    two: scenario(pair, [says('Alice', 'Acme', 'HAS_TITLE', 'Alice was promoted to CTO of Acme')]),
  };
  const legacy: LLMProvider = {
    async extract(content: string) {
      return script[content];
    },
    // written against the old contract: a bare boolean
    async detectContradiction() {
      return true as unknown as number[];
    },
  };
  const zep = new Minizep({ llm: legacy, embedder: deterministicEmbedder() });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'one', validAt: d('2024-01-01') });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'two', validAt: d('2025-01-01') });

  assert.deepEqual(res.invalidated.map((f) => f.name).sort(), ['HAS_TITLE', 'OWNS_SHARES_IN']);
});

test('temporal: a statement giving the end of an open relationship closes it', async () => {
  const people = [entity('Bob'), entity('Initech', ['Organization'])];
  for (const text of ['Bob works at Initech', 'Bob worked at Initech as a developer until February 2025']) {
    const { zep } = scripted({
      'Bob works at Initech': scenario(people, [says('Bob', 'Initech', 'WORKS_AT', 'Bob works at Initech')]),
      // "worked there until February": an end and no start
      until: scenario(people, [says('Bob', 'Initech', 'WORKS_AT', text, { invalidAt: d('2025-02-01') })]),
    });
    await zep.ingest.addEpisode({ groupId: 'g', content: 'Bob works at Initech', validAt: d('2024-01-15') });
    const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'until', validAt: d('2025-03-01') });

    assert.equal(res.facts.length, 0, `no second edge (${text})`);
    assert.equal(res.invalidated.length, 1);
    const all = await zep.store.getFacts('g');
    assert.equal(all.length, 1);
    assert.equal(all[0].invalidAt?.getTime(), d('2025-02-01').getTime());
    assert.equal((await zep.factsAt(new Date(), 'g')).length, 0);
  }
});

test('temporal: a contradiction never extends a fact that ends before the new one starts', async () => {
  const day = 86_400_000;
  const vpEnds = new Date(Date.now() + 10 * day);
  const cfoStarts = new Date(Date.now() + 20 * day);
  const { zep } = scripted(
    {
      'Tom is VP Finance until the end of next week': scenario(
        [entity('Tom'), entity('VP Finance', ['Role'])],
        [says('Tom', 'VP Finance', 'HAS_ROLE', 'Tom is VP Finance', { validAt: d('2025-01-01'), invalidAt: vpEnds })],
      ),
      'Tom will be CFO': scenario([entity('Tom'), entity('CFO', ['Role'])], [says('Tom', 'CFO', 'HAS_ROLE', 'Tom will be CFO', { validAt: cfoStarts })]),
    },
    true,
  );
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Tom is VP Finance until the end of next week' });
  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'Tom will be CFO' });

  assert.equal(res.invalidated.length, 0);
  const vp = (await zep.store.getFacts('g')).find((f) => f.name === 'HAS_ROLE' && f.fact.includes('VP'))!;
  assert.equal(vp.invalidAt?.getTime(), vpEnds.getTime());
});

test('temporal: an invalidation of the relation the same text introduces does not erase it', async () => {
  const { zep } = scripted({
    // a model listing the new relation among the ones that ended
    'Alice joined Globex': {
      entities: [entity('Alice'), entity('Globex', ['Organization'])],
      facts: [says('Alice', 'Globex', 'WORKS_AT', 'Alice joined Globex')],
      invalidations: [invalidation('Alice', 'Globex', 'WORKS_AT')],
    },
    'Alice worked at Initech from 2020 and left last month': {
      entities: [entity('Alice'), entity('Initech', ['Organization'])],
      facts: [says('Alice', 'Initech', 'WORKS_AT', 'Alice worked at Initech', { validAt: d('2020-01-01') })],
      invalidations: [invalidation('Alice', 'Initech', 'WORKS_AT', d('2026-08-01'))],
    },
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice joined Globex', validAt: d('2026-09-01') });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'Alice worked at Initech from 2020 and left last month', validAt: d('2026-09-02') });

  const byOrg = new Map((await zep.store.getFacts('g')).map((f) => [f.fact, f]));
  assert.equal(byOrg.get('Alice joined Globex')?.invalidAt, undefined, 'a relation that begins with this text does not end with it');
  assert.equal(byOrg.get('Alice worked at Initech')?.invalidAt?.getTime(), d('2026-08-01').getTime(), 'one that began earlier does');
});

test('temporal: a retracted fact is not revived by a later mention of the same statement', async () => {
  const people = [entity('Alice'), entity('Acme', ['Organization'])];
  const { zep } = scripted({
    one: scenario(people, [says('Alice', 'Acme', 'WORKS_AT', 'Alice works at Acme')]),
    two: scenario(people, [says('Alice', 'Acme', 'WORKS_AT', 'Alice works at Acme')]),
  });
  await zep.ingest.addEpisode({ groupId: 'g', content: 'one', validAt: d('2025-01-01') });
  // retracted as a whole (it was never true): expired without a valid-time end
  const [wrong] = await zep.store.getFacts('g');
  await zep.store.updateFact({ ...wrong, expiredAt: new Date() });

  const res = await zep.ingest.addEpisode({ groupId: 'g', content: 'two', validAt: d('2025-06-01') });
  assert.equal(res.reinforced.length, 0, 'the retraction stands');
  assert.equal(res.facts.length, 1, 'the new statement is its own fact');
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

test('temporal: factView agrees with isFactActive and tells future, ended and retracted apart', () => {
  const base = {
    validAt: d('2024-01-01'),
    invalidAt: d('2025-03-01'),
    createdAt: d('2025-01-01'),
    expiredAt: d('2025-06-01'),
    attributes: {},
  } as unknown as EntityEdge;
  const open = { ...base, invalidAt: undefined, expiredAt: undefined };
  const fixtures: Record<string, EntityEdge> = {
    'ended, end learned later': base,
    'end came with the fact': { ...base, expiredAt: undefined },
    'retracted as a whole': { ...base, invalidAt: undefined },
    'retracted: empty window': { ...base, invalidAt: base.validAt },
    'stored with an empty window': { ...base, invalidAt: base.validAt, expiredAt: undefined },
    'open': open,
    'start unknown': { ...open, validAt: undefined },
    'starts later': { ...open, validAt: d('2026-01-01') },
    'end scheduled': { ...base, invalidAt: d('2026-01-01') },
    'no createdAt': { ...open, createdAt: undefined } as unknown as EntityEdge,
  };
  const instants = ['2023-06-01', '2024-01-01', '2024-06-01', '2025-01-01', '2025-03-01', '2025-04-01', '2025-06-01', '2026-01-01', '2027-01-01'].map(d);
  for (const [name, f] of Object.entries(fixtures)) {
    for (const at of [...instants, undefined]) {
      for (const asOf of [...instants, undefined]) {
        const view = factView(f, at, asOf);
        const where = `${name} at ${at?.toISOString() ?? 'now'} as of ${asOf?.toISOString() ?? 'now'}`;
        assert.equal(view?.state === 'active', isFactActive(f, at, asOf), where);
        assert.equal(view === undefined, !isFactKnown(f, asOf ?? new Date()), where);
      }
    }
  }

  assert.deepEqual(factView(base, d('2025-04-01')), { state: 'ended', endsAt: d('2025-03-01'), revisedLater: false });
  assert.deepEqual(factView(base, d('2025-04-01'), d('2025-05-01')), { state: 'active', endsAt: undefined, revisedLater: true });
  assert.equal(factView(base, d('2023-06-01'))?.state, 'future');
  assert.equal(factView(fixtures['end scheduled'], d('2025-04-01'))?.endsAt?.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(factView(fixtures['retracted as a whole'], d('2024-06-01'))?.state, 'retracted');
  assert.equal(factView(fixtures['retracted: empty window'], d('2023-06-01'))?.state, 'retracted', 'at every valid time');
  assert.equal(factView(fixtures['retracted: empty window'], d('2024-06-01'), d('2025-05-01'))?.state, 'active', 'before the retraction');
  assert.equal(factView(base, d('2024-06-01'), d('2024-12-01')), undefined, 'not known yet');
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
