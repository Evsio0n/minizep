/**
 * Web UI development server: the HTTP app in-process with the UI enabled, an
 * in-memory graph, a scripted LLM and the hash embedder. Nothing leaves the
 * machine and every start seeds the same graph, so each fact state can be
 * looked at in the browser (active, ended, future, retracted, a failed
 * episode, a Chinese group).
 *
 *   npm run ui:dev          # then open http://127.0.0.1:8788/ui
 *
 * ui/index.html is read on every request: edit it and reload the page.
 *
 *   UI_DEV_PORT        port (default 8788; the host is always 127.0.0.1)
 *   MINIZEP_UI         1 = the UI with login: users "root" (admin) and "ana" (owner of
 *                      team-a, reader of 中文示例, nothing else) are added and their
 *                      tokens printed
 *   MINIZEP_UI_GROUPS  without MINIZEP_UI: groups the UI may open without login (default "*")
 *   MINIZEP_UI_HOSTS   extra host names for the UI (see docs/API.md)
 *   MINIZEP_TOKENS     tokens for /v1 and /mcp (default none: /v1 answers 401)
 *
 * Performance aids (the size of a real group, and writes landing while you look):
 *   UI_DEV_BIG=1       also seed "big-zh": ~530 entities, ~720 facts (a few hubs;
 *                      ended, retracted and future ones), 140 episodes, CJK names,
 *                      written straight into the store (no LLM)
 *   UI_DEV_LLM_MS      how long the scripted LLM takes for typed text (default 700)
 *   MINIZEP_JOB_CONCURRENCY  jobs run at once (default 2; 1 = they finish one by one)
 *   UI_DEV_DRIP_S      every N seconds a background writer (like an MCP agent) adds
 *                      an async memory to big-zh (default off; needs UI_DEV_BIG=1)
 *
 * A development tool, not a test: the data is invented and nothing is saved.
 */
import { Minizep } from '../src/index.js';
import { HashEmbedder, MockLLMProvider } from '../src/provider/index.js';
import type {
  ContradictionCandidate,
  ExtractionResult,
  KnownFact,
  LLMProvider,
} from '../src/provider/interfaces.js';
import { JobQueue } from '../src/jobs/queue.js';
import { uuid } from '../src/model/types.js';
import { createHttpApp } from '../src/server/app.js';
import { localPrincipal, parseTokens } from '../src/server/auth.js';
import { envInt, onShutdownSignal } from '../src/server/runtime.js';
import { uiFromEnv } from '../src/server/ui.js';

const log = (...args: unknown[]) => console.error('[ui-dev]', ...args);
const DAY = 86_400_000;
const now = new Date();
const d = (iso: string) => new Date(iso);
/** the first day of next month (UTC): a start that is still in the future */
const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

type Script = Pick<ExtractionResult, 'facts'> & Partial<ExtractionResult>;
const person = (name: string, summary: string) => ({ name, labels: ['Person'], summary });
const org = (name: string, summary: string) => ({ name, labels: ['Organization'], summary });

/** What the scripted LLM extracts from each seed text (exact match). */
const SCRIPTS = new Map<string, Script>([
  [
    'Bob works at Initech.',
    {
      entities: [person('Bob', 'Engineer.'), org('Initech', 'A software company.')],
      facts: [{ sourceName: 'Bob', targetName: 'Initech', relation: 'WORKS_AT', fact: 'Bob works at Initech' }],
    },
  ],
  [
    'Alice works at Acme. Alice likes Bob.',
    {
      entities: [person('Alice', 'Product manager at Acme.'), org('Acme', 'A manufacturer.'), person('Bob', 'Engineer.')],
      facts: [
        { sourceName: 'Alice', targetName: 'Acme', relation: 'WORKS_AT', fact: 'Alice works at Acme' },
        { sourceName: 'Alice', targetName: 'Bob', relation: 'LIKES', fact: 'Alice likes Bob' },
      ],
    },
  ],
  [
    // a job change: the scripted contradiction check ends Bob's Initech fact
    'Bob joined Globex.',
    {
      entities: [person('Bob', 'Engineer, now at Globex.'), org('Globex', 'A logistics company.')],
      facts: [{ sourceName: 'Bob', targetName: 'Globex', relation: 'WORKS_AT', fact: 'Bob joined Globex' }],
    },
  ],
  [
    'Carol will join Umbrella next month.',
    {
      entities: [person('Carol', 'Chemist.'), org('Umbrella', 'A pharmaceutical company.')],
      facts: [
        { sourceName: 'Carol', targetName: 'Umbrella', relation: 'WORKS_AT', fact: 'Carol will work at Umbrella', validAt: nextMonth },
      ],
    },
  ],
  [
    'Erin worked at Hooli from January 2022 until January 2025.',
    {
      entities: [person('Erin', 'Designer.'), org('Hooli', 'A tech company.')],
      facts: [
        {
          sourceName: 'Erin',
          targetName: 'Hooli',
          relation: 'WORKS_AT',
          fact: 'Erin worked at Hooli',
          validAt: d('2022-01-10T00:00:00Z'),
          invalidAt: d('2025-01-15T00:00:00Z'),
        },
      ],
    },
  ],
  [
    'Heidi works at Wayne Enterprises until the end of 2026.',
    {
      entities: [person('Heidi', 'Contractor.'), org('Wayne Enterprises', 'A conglomerate.')],
      facts: [
        {
          sourceName: 'Heidi',
          targetName: 'Wayne Enterprises',
          relation: 'WORKS_AT',
          fact: 'Heidi works at Wayne Enterprises on a contract',
          validAt: d('2025-06-01T00:00:00Z'),
          invalidAt: d('2027-01-01T00:00:00Z'),
        },
      ],
    },
  ],
  [
    // retracted below: it was never true
    'Dave likes Pineapple Pizza.',
    {
      entities: [person('Dave', 'Alice\'s colleague.'), { name: 'Pineapple Pizza', labels: ['Food'], summary: 'A pizza.' }],
      facts: [{ sourceName: 'Dave', targetName: 'Pineapple Pizza', relation: 'LIKES', fact: 'Dave likes Pineapple Pizza' }],
    },
  ],
  [
    'Frank is new to the team.',
    { entities: [person('Frank', 'Joined the team recently; no relationships known yet.')], facts: [] },
  ],
  [
    '{"event":"hire","person":"Grace","company":"Stark Industries"}',
    {
      entities: [person('Grace', 'Hired by Stark Industries.'), org('Stark Industries', 'A defense contractor.')],
      facts: [{ sourceName: 'Grace', targetName: 'Stark Industries', relation: 'WORKS_AT', fact: 'Grace was hired by Stark Industries' }],
    },
  ],
  [
    '# Notes\n\n- Ivan **likes** the *Lisbon* office.',
    {
      entities: [person('Ivan', 'Travels a lot.'), { name: 'Lisbon office', labels: ['Place'], summary: 'An office in Lisbon.' }],
      facts: [{ sourceName: 'Ivan', targetName: 'Lisbon office', relation: 'LIKES', fact: 'Ivan likes the Lisbon office' }],
    },
  ],
  [
    // names and fact text come from an LLM: the UI must show markup as text
    'Mallory wrote <b>bold</b> into a name.',
    {
      entities: [
        person('<img src=x onerror=alert(1)>', 'Summary with <script>alert(1)</script> and <b>tags</b>.'),
        org('<b>Bold Corp</b>', 'An entity whose name is markup.'),
      ],
      facts: [
        {
          sourceName: '<img src=x onerror=alert(1)>',
          targetName: '<b>Bold Corp</b>',
          relation: 'WORKS_AT',
          fact: '<i>Mallory</i> works at <b>Bold Corp</b> <script>alert(1)</script>',
        },
      ],
    },
  ],
  [
    '张伟在星辰科技工作。',
    {
      entities: [person('张伟', '工程师。'), org('星辰科技', '一家科技公司。')],
      facts: [{ sourceName: '张伟', targetName: '星辰科技', relation: 'WORKS_AT', fact: '张伟在星辰科技工作' }],
    },
  ],
  [
    '李娜喜欢故宫。王芳在云帆网络工作。',
    {
      entities: [person('李娜', '学生。'), { name: '故宫', labels: ['Place'], summary: '北京的博物馆。' }, person('王芳', '产品经理。'), org('云帆网络', '一家互联网公司。')],
      facts: [
        { sourceName: '李娜', targetName: '故宫', relation: 'LIKES', fact: '李娜喜欢故宫' },
        { sourceName: '王芳', targetName: '云帆网络', relation: 'WORKS_AT', fact: '王芳在云帆网络工作' },
      ],
    },
  ],
  [
    '张伟离开了星辰科技。',
    {
      entities: [person('张伟', '工程师，已离开星辰科技。'), org('星辰科技', '一家科技公司。')],
      facts: [],
      invalidations: [{ sourceName: '张伟', targetName: '星辰科技', relation: 'WORKS_AT', reason: '文本说“离开”' }],
    },
  ],
]);

/**
 * Seed texts get their scripted extraction; anything else (typed into "Add
 * memory") goes to the rule-based mock ("X works at Y", "X likes Y", "X left
 * Y"), after a short pause so async jobs are visibly queued and running.
 * Text containing "[fail]" fails like an LLM answering HTTP 500.
 */
class DevLLM implements LLMProvider {
  private readonly rules = new MockLLMProvider();

  async extract(content: string, known: string[], knownFacts?: KnownFact[]): Promise<ExtractionResult> {
    if (content.includes('[fail]')) throw new Error('scripted failure (the text contains "[fail]")');
    const script = SCRIPTS.get(content);
    if (script) return { entities: [], invalidations: [], ...script };
    await new Promise((r) => setTimeout(r, envInt('UI_DEV_LLM_MS', 700)));
    return this.rules.extract(content, known, knownFacts);
  }

  /** A new WORKS_AT ends the person's other jobs; nothing else contradicts. */
  async detectContradiction(candidate: ContradictionCandidate, existing: unknown[]): Promise<number[]> {
    return candidate.relation === 'WORKS_AT' ? existing.map((_, i) => i) : [];
  }
}

const zep = new Minizep({ llm: new DevLLM(), embedder: new HashEmbedder(64) });

type Extra = { source?: 'text' | 'json' | 'markdown'; name?: string; sourceDescription?: string };

async function add(groupId: string, content: string, validAt?: Date, extra: Extra = {}) {
  const r = await zep.ingest.addEpisode({ groupId, content, validAt, sourceDescription: 'ui-dev seed', ...extra });
  if (r.status !== 'processed' && !content.includes('[fail]')) throw new Error(`seeding "${content}" ended ${r.status}: ${r.error}`);
  return r;
}

async function factNamed(groupId: string, text: string) {
  const f = (await zep.store.getFacts(groupId)).find((x) => x.fact === text);
  if (!f) throw new Error(`seed fact not found: ${text}`);
  return f;
}

/** Every fact state, with ordered knowledge times (one episode after another). */
async function seed(): Promise<void> {
  const team = 'team-a';
  await add(team, 'Bob works at Initech.', d('2023-02-01T09:00:00Z'), { name: 'Bob joins Initech' });
  await add(team, 'Alice works at Acme. Alice likes Bob.', d('2024-03-01T00:00:00Z'), { name: 'Alice at Acme' });
  await add(team, 'Bob joined Globex.', d('2025-05-01T00:00:00Z'), { name: 'Bob changes jobs' }); // ends Bob -> Initech
  await add(team, 'Carol will join Umbrella next month.', now, { name: 'Carol offer' }); // future
  await add(team, 'Erin worked at Hooli from January 2022 until January 2025.', undefined, { name: 'Erin CV' }); // ended, end known
  await add(team, 'Heidi works at Wayne Enterprises until the end of 2026.', d('2025-06-01T00:00:00Z')); // active with an end
  await add(team, 'Dave likes Pineapple Pizza.', d('2025-09-01T00:00:00Z'), { name: 'Lunch chat' });
  await add(team, 'Frank is new to the team.', undefined, { name: 'Frank' }); // an entity without facts
  await add(team, '{"event":"hire","person":"Grace","company":"Stark Industries"}', d('2026-02-02T00:00:00Z'), {
    source: 'json',
    name: 'HR event',
    sourceDescription: 'HR system export',
  });
  await add(team, '# Notes\n\n- Ivan **likes** the *Lisbon* office.', d('2026-04-10T00:00:00Z'), {
    source: 'markdown',
    name: 'Travel notes',
    sourceDescription: 'notes app',
  });
  // corrections made through the API, as the fact panel would
  const likes = await factNamed(team, 'Alice likes Bob');
  await zep.ingest.invalidateFact(likes.uuid, { groupId: team, at: d('2026-01-15T00:00:00Z'), reason: 'They fell out over a code review' });
  const pizza = await factNamed(team, 'Dave likes Pineapple Pizza');
  await zep.ingest.invalidateFact(pizza.uuid, { groupId: team, retract: true, reason: 'It was a joke, never true' });

  const zh = '中文示例';
  await add(zh, '张伟在星辰科技工作。', d('2021-07-01T00:00:00Z'), { name: '入职' });
  await add(zh, '李娜喜欢故宫。王芳在云帆网络工作。', d('2023-10-01T00:00:00Z'));
  await add(zh, '张伟离开了星辰科技。', d('2024-09-01T00:00:00Z'), { name: '离职' }); // ends 张伟 -> 星辰科技

  const edge = 'edge-cases';
  await add(edge, 'Mallory wrote <b>bold</b> into a name.', d('2026-03-03T00:00:00Z'), { name: '<script>alert(1)</script>' });
  await add(edge, 'This text makes the scripted LLM fail. [fail]', undefined, { name: 'A failed episode' });
}

/**
 * A group the size of a real one, written straight into the store: entity
 * weights follow a Zipf curve, so a few hubs carry most facts; most other
 * entities have one to three and ~30 none. Deterministic (seeded PRNG).
 */
const BIG = 'big-zh';
async function seedBig(): Promise<void> {
  let seedN = 42;
  const rnd = () => { // mulberry32
    seedN = (seedN + 0x6d2b79f5) | 0;
    let t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const HAN = '學校國家經濟文化歷史社會政治教育言語漢字意味音韻語彙文法發音聲調辭典訓練評價資料模型';
  const SUR = '金李朴崔鄭姜趙尹張林';
  const GIV = ['敏俊', '瑞妍', '志勳', '秀賢', '惠媛', '東玄', '智雅', '成民', '夏恩', '俊浩', '藝琳', '在元'];
  const KINDS: Array<[string, number, (i: number) => string]> = [
    ['Person', 70, (i) => SUR[i % SUR.length] + GIV[Math.floor(i / SUR.length) % GIV.length]],
    ['Concept', 200, () => pick([...HAN]) + pick([...HAN]) + (rnd() < 0.3 ? pick([...HAN]) : '')],
    ['Dataset', 40, (i) => `${pick(['AIHub', 'KsponSpeech', '漢字語', 'Zeroth'])} ${pick(['訓練', '評價', 'dev', 'test'])}-${i}`],
    ['Model', 30, (i) => `${pick(['whisper', 'wav2vec2', 'klue-bert', 'hanja-wsd'])}-${pick(['base', 'large', 'turbo', 'ft'])}-v${i}`],
    ['Tool', 60, (i) => `${pick(['train', 'eval', 'align', 'dump', 'score'])}_${pick(['asr', 'wsd', 'gold', 'lm'])}${i}.${pick(['py', 'sh', 'ts'])}`],
    ['Job', 80, () => `slurm-${100000 + Math.floor(rnd() * 900000)}`],
    ['Document', 30, (i) => `docs/${pick(['PLAN', 'ASR-PLAN', 'EVAL', 'NOTES', '實驗'])}-${i}.md`],
    ['Machine', 15, (i) => `${pick(['storage', 'gpu', 'v100', 'b100'])}-${String(i).padStart(2, '0')}`],
  ];
  const HUBS: Array<[string, string]> = [
    ['Hanja Lab', 'Organization'], ['Whisper Turbo', 'Model'], ['漢字語 WSD', 'Project'], ['storage-01', 'Machine'], ['AIHub 한자', 'Dataset'], ['論文 CP7', 'Document'],
  ];
  const names = new Set<string>();
  const ents: Array<{ name: string; label: string }> = HUBS.map(([name, label]) => { names.add(name); return { name, label }; });
  for (const [label, n, make] of KINDS) {
    for (let i = 0; i < n; i++) {
      let name = make(i);
      if (names.has(name)) name = `${name}·${i}`;
      names.add(name);
      ents.push({ name, label });
    }
  }
  for (let i = ents.length - 1; i > HUBS.length; i--) { // shuffle all but the hubs
    const j = HUBS.length + Math.floor(rnd() * (i - HUBS.length + 1));
    [ents[i], ents[j]] = [ents[j], ents[i]];
  }
  const w = ents.map((_, i) => 1 / (i + 1) ** 0.9);
  const total = w.reduce((a, b) => a + b, 0);
  const zipf = () => { let r = rnd() * total; for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return i; return w.length - 1; };

  const start = now.getTime() - 90 * DAY;
  const eps = Array.from({ length: 140 }, (_, k) => {
    const at = new Date(start + (k + rnd()) * ((90 * DAY) / 140));
    const failed = k % 60 === 59;
    return {
      type: 'episode' as const, uuid: uuid(), groupId: BIG, name: `實驗記錄 ${k + 1}`, source: 'text' as const, sourceDescription: 'ui-dev big seed',
      content: Array.from({ length: 4 + Math.floor(rnd() * 8) }, () => `${pick(ents).name}與${pick(ents).name}有關；${pick([...HAN])}${pick([...HAN])}。`).join(' '),
      validAt: at, createdAt: at, status: failed ? ('failed' as const) : ('processed' as const), error: failed ? 'scripted: LLM answered HTTP 500' : undefined, attempts: 1,
    };
  });
  for (const ep of eps) await zep.store.addEpisode(ep);

  const RELS = ['USES', 'PART_OF', 'TRAINED_ON', 'EVALUATED_ON', 'DEPENDS_ON', 'RUNS_ON', 'AUTHORED', 'MENTIONS', 'RELATED_TO', 'IMPROVES', 'REPLACES', 'MEANS'];
  const facts: Array<Parameters<typeof zep.store.addFact>[0]> = [];
  const firstSeen = new Map<number, Date>();
  const uuids = ents.map(() => uuid());
  for (let k = 0; k < 720; k++) {
    const s = k < 470 ? HUBS.length + k : zipf(); // most entities get at least one fact
    let t = zipf();
    while (t === s) t = zipf();
    const ep = eps[Math.floor((k / 720) * eps.length)];
    const created = ep.createdAt;
    const rel = pick(RELS);
    const r = rnd();
    const later = new Date(Math.min(now.getTime() - DAY, created.getTime() + (1 + rnd() * 30) * DAY));
    for (const i of [s, t]) if (!firstSeen.has(i)) firstSeen.set(i, created);
    facts.push({
      type: 'fact', uuid: uuid(), groupId: BIG, sourceNodeUuid: uuids[s], targetNodeUuid: uuids[t], name: rel,
      fact: `${ents[s].name} ${rel.toLowerCase().replace(/_/g, ' ')} ${ents[t].name}（${pick([...HAN])}${pick([...HAN])}）`,
      episodes: [ep.uuid], createdAt: created, attributes: {},
      validAt: r > 0.97 ? new Date(now.getTime() + (10 + rnd() * 50) * DAY) : created, // 3% future
      invalidAt: r < 0.12 ? later : undefined, // 12% ended
      expiredAt: r < 0.12 || (r >= 0.12 && r < 0.16) ? later : undefined, // 4% retracted
    });
  }
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    await zep.store.upsertEntity({
      type: 'entity', uuid: uuids[i], groupId: BIG, name: e.name, labels: [e.label], attributes: {},
      summary: `${e.name}：${Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => pick([...HAN]) + pick([...HAN])).join('、')}。`,
      nameEmbedding: await zep.embedder.embed(e.name),
      createdAt: firstSeen.get(i) ?? pick(eps).createdAt,
    });
  }
  for (const f of facts) await zep.store.addFact({ ...f, factEmbedding: await zep.embedder.embed(f.fact) });
  const deg = new Map<string, number>();
  for (const f of facts) for (const id of [f.sourceNodeUuid, f.targetNodeUuid]) deg.set(id, (deg.get(id) ?? 0) + 1);
  const top = [...deg.values()].sort((a, b) => b - a);
  log(`seeded ${BIG}: ${ents.length} entities (${ents.length - deg.size} isolated; top degrees ${top.slice(0, 6).join(', ')}), ${facts.length} facts, ${eps.length} episodes`);
}

await seed();
if (process.env.UI_DEV_BIG === '1') await seedBig();
const facts = (await zep.store.getFacts()).length;
log(`seeded ${facts} facts in team-a, 中文示例 and edge-cases (today is ${now.toISOString().slice(0, 10)}; "future" starts ${nextMonth.toISOString().slice(0, 10)}, ${Math.round((nextMonth.getTime() - now.getTime()) / DAY)} days on)`);

const login = process.env.MINIZEP_UI === '1';
const ui = uiFromEnv(login ? process.env : { ...process.env, MINIZEP_UI_GROUPS: process.env.MINIZEP_UI_GROUPS?.trim() || '*' });
const tokens = parseTokens(process.env.MINIZEP_TOKENS);
const app = createHttpApp({
  zep,
  jobs: new JobQueue({ concurrency: envInt('MINIZEP_JOB_CONCURRENCY', 2) }),
  tokens,
  ui,
  llmLabel: 'scripted (ui-dev)',
  storeLabel: 'memory (ui-dev, not saved)',
  log,
});
if (login) {
  const admin = localPrincipal('team-a');
  const root = await app.access.createUser(admin, { name: 'root', admin: true });
  const ana = await app.access.createUser(admin, { name: 'ana', default_group: 'team-a', workspace: false });
  await app.access.setGrant(admin, { user: 'ana', pattern: 'team-a', role: 'owner' });
  await app.access.setGrant(admin, { user: 'ana', pattern: '中文示例', role: 'reader' });
  log(`log in as root (admin): ${root.token}`);
  log(`log in as ana (owner of team-a, reader of 中文示例): ${ana.token}`);
}
const port = envInt('UI_DEV_PORT', 8788);
await app.listen(['127.0.0.1'], port);
const v1 = login || tokens.size ? `${tokens.size} env token(s)${login ? ' and the users above' : ''}` : 'no tokens configured, 401';
log(`open http://127.0.0.1:${port}/ui  (/v1: ${v1})`);

const dripS = envInt('UI_DEV_DRIP_S', 0);
let dripTimer: NodeJS.Timeout | undefined;
if (dripS > 0 && process.env.UI_DEV_BIG === '1') {
  let n = 0;
  const hubs = ['Hanja Lab', 'Whisper Turbo'];
  dripTimer = setInterval(() => {
    n++;
    const content = `Agent${n} works at ${hubs[n % hubs.length]}. Agent${n} likes Tester${n}.`;
    app.service.addMemory(localPrincipal(BIG), { group_id: BIG, content, async: true, name: `drip ${n}` })
      .then((r) => log(`drip ${n}: ${r.status}`), (e) => log(`drip ${n} failed: ${e}`));
  }, dripS * 1000);
  log(`background writer: an async memory into ${BIG} every ${dripS}s`);
}

onShutdownSignal(async (signal) => {
  clearInterval(dripTimer);
  log(`${signal}: stopping`);
  await app.close({ drainTimeoutMs: 2000 });
  process.exit(0);
}, log);
