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
 *   MINIZEP_UI_GROUPS  groups the UI may open (default "*")
 *   MINIZEP_UI_HOSTS   extra host names for the UI (see docs/API.md)
 *   MINIZEP_TOKENS     tokens for /v1 and /mcp (default none: /v1 answers 401)
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
import { createHttpApp } from '../src/server/app.js';
import { parseTokens } from '../src/server/auth.js';
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
    // a job change: the new employer replaces the old one, so the scripted
    // contradiction check sees Bob's Initech fact and ends it
    'Bob joined Globex.',
    {
      entities: [person('Bob', 'Engineer, now at Globex.'), org('Globex', 'A logistics company.')],
      facts: [{ sourceName: 'Bob', targetName: 'Globex', relation: 'WORKS_AT', fact: 'Bob joined Globex', replacesPrevious: true }],
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
    await new Promise((r) => setTimeout(r, 700));
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

await seed();
const facts = (await zep.store.getFacts()).length;
log(`seeded ${facts} facts in team-a, 中文示例 and edge-cases (today is ${now.toISOString().slice(0, 10)}; "future" starts ${nextMonth.toISOString().slice(0, 10)}, ${Math.round((nextMonth.getTime() - now.getTime()) / DAY)} days on)`);

const ui = uiFromEnv({ ...process.env, MINIZEP_UI_GROUPS: process.env.MINIZEP_UI_GROUPS?.trim() || '*' });
const tokens = parseTokens(process.env.MINIZEP_TOKENS);
const app = createHttpApp({
  zep,
  tokens,
  ui,
  llmLabel: 'scripted (ui-dev)',
  storeLabel: 'memory (ui-dev, not saved)',
  log,
});
const port = envInt('UI_DEV_PORT', 8788);
await app.listen(['127.0.0.1'], port);
log(`open http://127.0.0.1:${port}/ui  (/v1: ${tokens.size ? `${tokens.size} token(s)` : 'no tokens configured, 401'})`);

onShutdownSignal(async (signal) => {
  log(`${signal}: stopping`);
  await app.close({ drainTimeoutMs: 2000 });
  process.exit(0);
}, log);
