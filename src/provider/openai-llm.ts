import type {
  ContradictionCandidate,
  ContradictionExisting,
  Embedder,
  ExtractedFact,
  ExtractedInvalidation,
  ExtractionResult,
  ExtractOptions,
  KnownFact,
  LLMProvider,
} from './interfaces.js';
import { calendarDay, localTimeZone } from '../util/time.js';
import { MockLLMProvider } from './mock-llm.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OpenAI-compatible chat-completions client used as the graph extraction LLM.
 * Verified against DeepSeek (`api.deepseek.com`): use `deepseek-flash`, NOT
 * `deepseek-v4-pro` — the pro model is a reasoning model whose entire
 * max_tokens budget gets consumed by reasoning_content, yielding empty content.
 */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** reasoning models spend tokens before emitting content */
  maxTokens?: number;
  timeoutMs?: number;
  /** retry attempts for transient failures (default 3) */
  retries?: number;
  /** base backoff in ms, doubled per attempt (default 500) */
  backoffMs?: number;
  /**
   * IANA time zone the reference time is expressed in, so "yesterday" and
   * "下周五" resolve to the writer's calendar days (default: MINIZEP_TIMEZONE,
   * else this process's zone).
   */
  timeZone?: string;
}

const EXTRACTION_SYSTEM = `You extract a temporal knowledge graph from one text.
Return ONLY a JSON object, no prose, no markdown fences:
{"entities":[{"name":"string","labels":["Person"|"Organization"|"Product"|"Host"|"Project"|"Job"|"Role"|"Concept"|"Event"|"Location"|"Preference"],"summary":"string"}],
 "facts":[{"sourceName":"string","targetName":"string","relation":"SCREAMING_SNAKE_CASE","fact":"self-contained sentence","validAt":"ISO-8601 or null","invalidAt":"ISO-8601 or null","replacesPrevious":false}],
 "invalidations":[{"sourceName":"string","targetName":"string","relation":"SCREAMING_SNAKE_CASE or null","invalidAt":"ISO-8601 or null","reason":"short justification"}]}

Time — the message starts with a reference time: when the text was written, with its UTC offset and weekday.
- Resolve every relative expression against the reference time, never against today's date:
  "yesterday", "next Monday", "last month", "in two weeks", "昨天", "下周五", "上个月", "明年".
  Put the absolute ISO-8601 result (with the reference offset) in validAt/invalidAt, and write the
  absolute date into the fact sentence as well.
- validAt is when the fact starts being true, which is not always when the text was written:
  "appointed CFO yesterday, effective next Monday" starts on that Monday.
- When only a month or a year is known, use its first day ("上个月" written on 2025-02-01 -> 2025-01-01).
- Use null when the text gives no time for a fact; never guess.
- Entity names never contain time words: "下周五", "next Monday", "last year" are times; "昨天的周会" is
  at most the entity "周会".

Language:
- Keep entity names, summaries and fact sentences in the language of the text. Do not translate:
  a Chinese text gets Chinese summaries and fact sentences.

Entities:
- An entity is a named thing: a person, organisation, role, product, service or software, machine or
  host, project, job with a name or id ("job 4711", not "4711"), place, event or concept.
- Literal values are NEVER entities: IP addresses, host:port, ports, URLs, file paths, versions, amounts,
  quantities, bare numbers, dates, weekdays, times and durations. A value stays in the sentence of the
  fact between the named entities it qualifies ("Grafana on web-1 listens on 192.0.2.10:3000" is the fact
  Grafana --RUNS_ON--> web-1), or in the summary of the one entity it describes.
- Reuse the exact name of a known entity when the text refers to it, also by a shorter or longer form.
- summary: one or two sentences on who or what the entity is, with the properties the text gives it.
  For a known entity return an UPDATED summary that keeps what its known summary says and adds what
  this text says; if the text adds nothing about it, return "". A summary states current values: when
  the text gives a property a new value (another address, port, version or status), the new value
  replaces the old one, which stays at most as history ("moved from port 3000 to 3001 on 2026-03-02").

Facts:
- "fact" is one self-contained natural-language sentence that keeps every detail the text gives:
  role, title, team, organisation, amounts, dates, addresses. Write "Alice Chen joined Globex as a
  Staff Engineer", never "Alice Chen --WORKS_AT--> Globex".
- Both endpoints must be named entities of this text or known entities, never a value node. A value
  that can change (address, port, version, status, location, owner) belongs in a fact, so its history
  is kept: relate the entity to the named entity it runs on or belongs to (its host, owner, project) and
  put the value in that fact's sentence. Only when no second named entity exists at all does the value
  go into the entity's summary.
- relation is a short label such as WORKS_AT, HAS_ROLE, MEMBER_OF, LIVES_IN, REPORTS_TO, RUNS_ON, USES.
  It reads from sourceName to targetName as "subject RELATION object": for "Billing uses Redis",
  Billing --USES--> Redis is correct; Billing --PROVIDES--> Redis and Redis --USES--> Billing are wrong.
- State each relationship once: never repeat a fact sentence under another relation.
- Never invent facts that the text does not support.

facts vs invalidations — this distinction is critical:
- "facts" are relationships that hold (or start holding) according to the text.
- "invalidations" are relationships that the text says have ENDED or no longer hold.
  An ending is NOT a new relationship. If the text says someone left, quit, resigned, moved away,
  stopped, broke up, cancelled, or no longer does something, put it in "invalidations" and reference
  the ORIGINAL relation it terminates — do NOT invent a LEFT/QUIT/ENDED fact.
- Dependent relationships end with it: when a relationship ends, also invalidate every active
  relationship that only held because of it — leaving a company ends the role, title, team
  membership, manager and project relationships held there. Copy sourceName, targetName and
  relation exactly from the "Active relationships" list.
- A new value for a single-valued relationship (employer, title, role, team, home city, manager) or
  for a changing property kept in a fact (address, port, version, status) replaces the old one: emit
  the new fact and invalidate the old one. Only a property kept in a summary is updated there.
- replacesPrevious is true ONLY when the text says the new value replaces an earlier one ("moved to",
  "switched to", "now works at", "changed from X to Y", "was replaced by", 改为, 搬到, 换成, 取代);
  otherwise false. Another value of a relationship that can have several (evaluated on several
  datasets, uses several tools, member of several teams) replaces nothing.
- A negated relationship ("X does not replace Y", "X is not part of Y") is neither a fact nor an
  invalidation: keep what it says in the sentence of a positive fact or in an entity summary.
- invalidAt = when it ended, resolved against the reference time; null when the text gives no clue.
- If a relationship both starts and ends within this text, put it in "facts" with invalidAt.
- Emit empty arrays when a category has no entries.

Example. Reference time 2026-03-02T09:00:00+00:00 (Monday). Active relationships:
- Alice Chen --WORKS_AT--> Acme Corp: Alice Chen is a backend engineer at Acme Corp
- Alice Chen --HAS_ROLE--> backend engineer: Alice Chen works as a backend engineer at Acme Corp
- Alice Chen --MEMBER_OF--> payments team: Alice Chen is on the payments team at Acme Corp
Text: "Alice Chen left Acme Corp last Friday and has joined Globex as a Staff Engineer."
Output:
{"entities":[{"name":"Alice Chen","labels":["Person"],"summary":"Alice Chen, formerly a backend engineer on Acme Corp's payments team, is a Staff Engineer at Globex."},
  {"name":"Globex","labels":["Organization"],"summary":"Globex is a company that Alice Chen joined as a Staff Engineer."},
  {"name":"Staff Engineer","labels":["Role"],"summary":"Staff Engineer is Alice Chen's role at Globex."}],
 "facts":[{"sourceName":"Alice Chen","targetName":"Globex","relation":"WORKS_AT","fact":"Alice Chen joined Globex as a Staff Engineer after leaving Acme Corp on 2026-02-27","validAt":null,"invalidAt":null,"replacesPrevious":true},
  {"sourceName":"Alice Chen","targetName":"Staff Engineer","relation":"HAS_ROLE","fact":"Alice Chen is a Staff Engineer at Globex","validAt":null,"invalidAt":null,"replacesPrevious":true}],
 "invalidations":[{"sourceName":"Alice Chen","targetName":"Acme Corp","relation":"WORKS_AT","invalidAt":"2026-02-27T00:00:00+00:00","reason":"left Acme Corp last Friday"},
  {"sourceName":"Alice Chen","targetName":"backend engineer","relation":"HAS_ROLE","invalidAt":"2026-02-27T00:00:00+00:00","reason":"the role ended with leaving Acme Corp"},
  {"sourceName":"Alice Chen","targetName":"payments team","relation":"MEMBER_OF","invalidAt":"2026-02-27T00:00:00+00:00","reason":"the team membership ended with leaving Acme Corp"}]}`;

const CONTRADICTION_SYSTEM = `You maintain a temporal knowledge graph. You get one NEW fact and a numbered
list of EXISTING facts, and decide which existing facts stop being true once the new fact holds.
An existing fact is ended ONLY when it and the new fact cannot both be true at the same time: another
employer, title, manager, home, owner, status or value for a thing that has one at a time; a reversal.
These are NOT contradictions, the existing fact stays true:
- a restatement, elaboration or confirmation of the same relationship ("still valid", "remains",
  "confirmed", more detail about it);
- another value of a relationship that can have several at once (evaluated on several datasets, uses
  several tools, member of several teams, runs several jobs; working at a company and owning shares in
  it; a role and a team membership);
- a statement that something does not replace, is separate from, or is in addition to another;
- a fact about a different scope (another dataset, version or run) or a period that does not overlap.
When unsure, the existing fact is not ended.
Examples:
- NEW "Model M was also evaluated on benchmark B2"; EXISTING 1. "Model M was evaluated on benchmark B1"
  -> {"contradicts": false, "which": []}
- NEW "The Q3 test result of service S still stands"; EXISTING 1. "Service S passed the Q3 test"
  -> {"contradicts": false, "which": []}
- NEW "Dana moved from Initech to Globex"; EXISTING 1. "Dana works at Initech" -> {"contradicts": true, "which": [1]}
Dates in parentheses are when each fact started. The new fact may be OLDER than an existing one (a
document added late): still list every existing fact it cannot hold together with; the order in time is
taken from the dates.
Return ONLY JSON: {"contradicts": true|false, "which": [numbers of the ended facts from the list]}`;

export class OpenAICompatLLM implements LLMProvider {
  private readonly timeZone: string;

  constructor(private cfg: LLMConfig) {
    this.timeZone = cfg.timeZone ?? process.env.MINIZEP_TIMEZONE ?? localTimeZone();
    // an unknown zone would fail every extraction; fail at construction instead
    try {
      formatReferenceTime(new Date(), this.timeZone);
    } catch (err) {
      throw new Error(`invalid time zone "${this.timeZone}" (MINIZEP_TIMEZONE): ${(err as Error).message}`);
    }
  }

  /**
   * One chat completion, with retries.
   *
   * Two failure modes are treated as retryable because they are transient and
   * observed in practice against DeepSeek:
   *   - HTTP 429 / 5xx (rate limit, upstream hiccup)
   *   - empty `content` because the reasoning budget consumed all max_tokens
   */
  private async chat(system: string, userPrompt: string, maxTokens: number): Promise<string> {
    const attempts = this.cfg.retries ?? 3;
    let lastErr: Error | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        return await this.chatOnce(system, userPrompt, maxTokens);
      } catch (err) {
        lastErr = err as Error;
        const retryable = /empty content|HTTP (429|5\d\d)|fetch failed|timeout|aborted/i.test(lastErr.message);
        if (!retryable || i === attempts - 1) break;
        const backoff = (this.cfg.backoffMs ?? 500) * 2 ** i;
        console.error(`[minizep] LLM attempt ${i + 1}/${attempts} failed (${lastErr.message.slice(0, 80)}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  private async chatOnce(system: string, userPrompt: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices: { message: { content?: string; reasoning_content?: string } }[];
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const msg = data.choices?.[0]?.message;
    const content = msg?.content ?? '';
    if (!content.trim()) {
      const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
      throw new Error(
        `empty content (reasoning_tokens=${reasoning ?? '?'}) — raise max_tokens or use a non-reasoning model`,
      );
    }
    return content;
  }

  async extract(
    content: string,
    knownEntityNames: string[],
    knownFacts: KnownFact[] = [],
    options: ExtractOptions = {},
  ): Promise<ExtractionResult> {
    // the pipeline always passes the episode's time; a direct caller gets now
    const opts = { ...options, referenceTime: options.referenceTime ?? new Date() };
    const raw = await this.chat(
      EXTRACTION_SYSTEM,
      buildExtractionPrompt(content, knownEntityNames, knownFacts, opts, this.timeZone),
      this.cfg.maxTokens ?? 8000,
    );
    const parsed = parseJsonObject(raw) as {
      entities?: { name: string; labels?: string[]; summary?: string }[];
      facts?: {
        sourceName: string;
        targetName: string;
        relation: string;
        fact: string;
        validAt?: string | null;
        invalidAt?: string | null;
        replacesPrevious?: boolean | null;
      }[];
      invalidations?: {
        sourceName: string;
        targetName: string;
        relation?: string | null;
        invalidAt?: string | null;
        reason?: string;
      }[];
    };

    const entities = (parsed.entities ?? [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => ({
        name: e.name.trim(),
        labels: Array.isArray(e.labels) ? e.labels.filter((l) => typeof l === 'string') : [],
        summary: typeof e.summary === 'string' ? e.summary.trim() : '',
      }));

    // endpoints may be entities of this text or known ones; the pipeline
    // resolves them against the graph and counts the ones it cannot resolve
    const names = new Set(entities.map((e) => e.name.toLowerCase()));
    const facts: ExtractedFact[] = (parsed.facts ?? [])
      .filter(
        (f) =>
          f &&
          typeof f.sourceName === 'string' &&
          typeof f.targetName === 'string' &&
          typeof f.fact === 'string' &&
          f.sourceName.trim() &&
          f.targetName.trim(),
      )
      .map((f) => ({
        sourceName: f.sourceName.trim(),
        targetName: f.targetName.trim(),
        relation: (typeof f.relation === 'string' && f.relation.trim()) || 'RELATES_TO',
        fact: f.fact.trim(),
        validAt: toDate(f.validAt),
        invalidAt: toDate(f.invalidAt),
        // only an explicit true: a missing or malformed flag replaces nothing
        ...(f.replacesPrevious === true ? { replacesPrevious: true } : {}),
      }));

    // invalidations may name endpoints that already exist; they do not have to
    // appear in `entities`, but we drop any that name nothing at all
    const invalidations: ExtractedInvalidation[] = (parsed.invalidations ?? [])
      .filter(
        (iv) =>
          iv &&
          typeof iv.sourceName === 'string' &&
          typeof iv.targetName === 'string' &&
          iv.sourceName.trim() &&
          iv.targetName.trim(),
      )
      .map((iv) => ({
        sourceName: iv.sourceName.trim(),
        targetName: iv.targetName.trim(),
        relation: iv.relation ? iv.relation.trim() : undefined,
        invalidAt: toDate(iv.invalidAt),
        reason: iv.reason,
      }));

    // safety net: an invalidation whose endpoints are absent from the graph
    // would be silently dropped downstream, so make sure they exist. The
    // summary stays empty: the pipeline keeps an existing entity's summary
    // when the candidate's is empty, so this can never overwrite it.
    for (const iv of invalidations) {
      for (const n of [iv.sourceName, iv.targetName]) {
        if (!names.has(n.toLowerCase())) {
          entities.push({ name: n, labels: [], summary: '' });
          names.add(n.toLowerCase());
        }
      }
    }

    return { entities, facts, invalidations };
  }

  async detectContradiction(
    candidate: ContradictionCandidate,
    existing: ContradictionExisting[],
  ): Promise<number[]> {
    if (existing.length === 0) return [];
    const list = existing.map((e, i) => `${i + 1}. ${e.fact}${since(e.validAt, this.timeZone)}`).join('\n');
    const raw = await this.chat(
      CONTRADICTION_SYSTEM,
      `New fact${candidate.replacesPrevious ? ' (the text says it replaces an earlier value)' : ''}: ` +
        `${candidate.fact}${since(candidate.validAt, this.timeZone)}\n\nExisting facts:\n${list}`,
      this.cfg.maxTokens ?? 8000,
    );
    return parseContradiction(parseJsonObject(raw), existing.length);
  }
}

/**
 * {"contradicts": true, "which": [1]} -> [0]. "which" is 1-based in the
 * prompt; entries outside 1..count are ignored. Only a "contradicts": true
 * without any "which" means all of them, like the old boolean contract: a list
 * naming nothing usable (a 0-based [0], an out-of-range number) closes none,
 * since closing every candidate is the most destructive misreading.
 */
export function parseContradiction(parsed: unknown, count: number): number[] {
  const p = (parsed ?? {}) as { contradicts?: unknown; which?: unknown };
  if (p.contradicts === false) return [];
  if (p.which === undefined || p.which === null) {
    return p.contradicts === true ? Array.from({ length: count }, (_, i) => i) : [];
  }
  const listed = Array.isArray(p.which) ? p.which : [p.which];
  const which = [...new Set(listed.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))].map(
    (n) => n - 1,
  );
  if (which.length === 0 && p.contradicts === true) {
    console.error(
      `[minizep] contradiction answer names no fact of 1..${count} (which=${JSON.stringify(p.which).slice(0, 80)}); closing none`,
    );
  }
  return which;
}

/** The user message of an extraction call. */
export function buildExtractionPrompt(
  content: string,
  knownEntityNames: string[],
  knownFacts: KnownFact[],
  options: ExtractOptions,
  timeZone = 'UTC',
): string {
  const parts: string[] = [];
  if (options.referenceTime) {
    parts.push(`Reference time: ${formatReferenceTime(options.referenceTime, timeZone)}`);
  }
  parts.push(`Text:\n${content}`);
  const summaries = new Map((options.knownEntities ?? []).map((e) => [e.name, e.summary]));
  if (knownEntityNames.length) {
    parts.push(
      'Known entities (reuse these exact names; the summary is what is already known):\n' +
        knownEntityNames.map((n) => `- ${n}: ${summaries.get(n) || '(no summary yet)'}`).join('\n'),
    );
  }
  if (knownFacts.length) {
    parts.push(
      'Active relationships (reference these exactly when the text ends one, or ends what they depend on):\n' +
        knownFacts
          .map((f) => `- ${f.sourceName} --${f.relation}--> ${f.targetName}: ${f.fact}${since(f.validAt, timeZone)}`)
          .join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** " (since 2026-03-01)": the calendar day in the zone the reference time is given in. */
const since = (d: Date | undefined, timeZone: string) => (d ? ` (since ${calendarDay(d, timeZone)})` : '');

/**
 * "2026-09-24T08:00:00+08:00 (Thursday)": the instant in the given zone, with
 * its offset and weekday, which is what "next Monday" is computed from.
 */
export function formatReferenceTime(d: Date, timeZone = 'UTC'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${zone}` +
    ` (${parts.weekday})`
  );
}

/** Tolerates fenced code blocks and surrounding prose. */
function parseJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object in LLM output: ${raw.slice(0, 160)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function toDate(v: string | null | undefined): Date | undefined {
  if (!v || typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Build the extraction LLM, or fail loudly.
 *
 * Falling back to the offline mock extractor is fine for a demo and dangerous
 * in production: it would silently write junk into the graph. Set
 * MINIZEP_REQUIRE_REAL_PROVIDERS=1 in production so a missing key is fatal.
 */
export function buildLLM(): { llm: LLMProvider; label: string } {
  let cfg: LLMConfig;
  try {
    cfg = loadLLMConfigSync();
  } catch (err) {
    const message = (err as Error).message;
    if (process.env.MINIZEP_REQUIRE_REAL_PROVIDERS === '1') {
      console.error(
        `fatal: no extraction LLM configured (${message}).\n` +
          '  set MINIZEP_LLM_API_KEY + MINIZEP_LLM_BASE_URL (+ MINIZEP_LLM_MODEL),\n' +
          '  or unset MINIZEP_REQUIRE_REAL_PROVIDERS to allow the offline mock extractor.',
      );
      process.exit(1);
    }
    console.error(
      `[minizep] WARNING: no extraction LLM configured (${message}); ` +
        'falling back to MockLLMProvider — extracted facts will be meaningless. ' +
        'Set MINIZEP_LLM_API_KEY/MINIZEP_LLM_BASE_URL, or MINIZEP_REQUIRE_REAL_PROVIDERS=1 to make this fatal.',
    );
    return { llm: new MockLLMProvider(), label: `MockLLMProvider (${message})` };
  }
  // an LLM is configured: a bad setting (e.g. an unknown MINIZEP_TIMEZONE) is
  // an error to fix, never a reason to fall back to the mock extractor
  return { llm: new OpenAICompatLLM(cfg), label: `${cfg.model} @ ${cfg.baseUrl}` };
}

/** Env-only config, so it works where the developer's dotfiles do not exist. */
export function loadLLMConfigSync(
  model = process.env.MINIZEP_LLM_MODEL ?? 'deepseek-flash',
): LLMConfig {
  const apiKey = process.env.MINIZEP_LLM_API_KEY;
  const baseUrl = process.env.MINIZEP_LLM_BASE_URL;
  if (apiKey && baseUrl) return { baseUrl, apiKey, model };
  if (apiKey || baseUrl) {
    throw new Error('MINIZEP_LLM_API_KEY and MINIZEP_LLM_BASE_URL must be set together');
  }
  // fall back to the machine's existing provider credentials (development)
  const provider = process.env.MINIZEP_LLM_PROVIDER ?? 'deepseek';
  const raw = readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8');
  const cfg = (JSON.parse(raw) as { models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> } })
    .models?.providers?.[provider];
  if (!cfg?.apiKey || !cfg?.baseUrl) throw new Error(`provider "${provider}" not found in ~/.openclaw/openclaw.json`);
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model };
}

/**
 * Development convenience: reuse the provider credentials already configured
 * for this machine instead of duplicating secrets into a .env file.
 * Explicit env vars always win.
 */
export async function loadLLMConfig(
  provider = process.env.MINIZEP_LLM_PROVIDER ?? 'deepseek',
  model = process.env.MINIZEP_LLM_MODEL ?? 'deepseek-flash',
): Promise<LLMConfig> {
  const envKey = process.env.MINIZEP_LLM_API_KEY;
  const envBase = process.env.MINIZEP_LLM_BASE_URL;
  if (envKey && envBase) return { baseUrl: envBase, apiKey: envKey, model };

  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const raw = await readFile(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8');
  const cfg = (JSON.parse(raw) as {
    models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
  }).models?.providers?.[provider];
  if (!cfg?.apiKey || !cfg?.baseUrl) {
    throw new Error(`provider "${provider}" not found in ~/.openclaw/openclaw.json`);
  }
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model };
}

// re-exported for symmetry with the embedders
export type { Embedder };
