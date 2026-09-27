import type {
  ContradictionCandidate,
  ContradictionExisting,
  ContradictionVerdict,
  Embedder,
  ExtractedEntity,
  ExtractedFact,
  ExtractedInvalidation,
  ExtractionResult,
  ExtractOptions,
  KnownFact,
  LLMCallContext,
  LLMProvider,
} from './interfaces.js';
import { calendarDay, localTimeZone } from '../util/time.js';
import { MockLLMProvider } from './mock-llm.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OpenAI-compatible chat-completions client used as the graph extraction LLM.
 * Verified against DeepSeek (`api.deepseek.com`). Both `deepseek-flash` and
 * `deepseek-v4-pro` reason before they answer, and the reasoning counts
 * against max_tokens: a budget spent on it yields empty or cut-off content
 * (see chat()).
 */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** max_tokens of a first request; reasoning models spend tokens before emitting content (default 8000) */
  maxTokens?: number;
  /** a reply cut off by max_tokens is asked again with the budget doubled, up to this (default 4 × maxTokens) */
  maxTokensCap?: number;
  /** per request at maxTokens, in proportion for a larger budget (default 120000) */
  timeoutMs?: number;
  /** attempts in all for transient failures (default 3) */
  retries?: number;
  /** base backoff in ms, doubled per attempt (default 500) */
  backoffMs?: number;
  /**
   * IANA time zone the reference time is expressed in, so "yesterday" and
   * "下周五" resolve to the writer's calendar days (default: MINIZEP_TIMEZONE,
   * else this process's zone).
   */
  timeZone?: string;
  /**
   * Ask for JSON mode (`response_format: {type: "json_object"}`), which
   * DeepSeek and OpenAI support (default: MINIZEP_LLM_JSON_MODE, else on).
   * Turn it off for an endpoint that rejects the field.
   */
  jsonMode?: boolean;
  /**
   * Fields merged into every request body, for provider-specific switches
   * such as turning reasoning off. The model, messages and max_tokens stay
   * this client's.
   */
  extraBody?: Record<string, unknown>;
}

const DEFAULT_MAX_TOKENS = 8000;

/** The longest delay a Node timer takes: a longer AbortSignal.timeout fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** No model answers with more; a larger max_tokens is a typo. */
const MAX_TOKENS_LIMIT = 1_000_000;

/** Empty content from a reply that used this share of max_tokens: the budget ran out, most likely on reasoning. */
const NEAR_BUDGET = 0.9;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** An on/off environment variable: 0, false, off and no are off; unset is `fallback`. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

const EXTRACTION_SYSTEM = `You extract a temporal knowledge graph from one text.
Return ONLY a JSON object, no prose, no markdown fences:
{"entities":[{"name":"string","mention":"string, optional","labels":["Person"|"Organization"|"Product"|"Host"|"Project"|"Job"|"Role"|"Concept"|"Event"|"Location"|"Preference"],"summary":"string"}],
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
- Reuse the exact name of a known entity only for the same referent: the text uses its name, or an
  alias, abbreviation or other spelling of it. A name with a qualifier ("unified KEEP", "U arm", "seed 2",
  "job 749", "KEEP 試驗模型") is a different entity from the bare name ("KEEP") unless the text says
  they are the same: reuse a known entity with that same qualifier, else create one with the text's name.
  Example: known "KEEP" (a method); text "unified U (unified KEEP) scored 0.9408 on dev2, Slurm array
  866" -> the result belongs to "unified KEEP" (or the known entity with that qualifier), never "KEEP".
- mention: when you reuse a known name for different words in the text, those words ("Alice" for the
  known "Alice Chen"); omit it otherwise.
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
- replacesPrevious says the target of this fact replaces any earlier one. It is true for a relationship
  that holds one target at a time for its source (employer, title or role, home city, manager, owner),
  however the fact is worded ("Alice is CTO at Acme" too), and when the text says an earlier value was
  replaced ("moved to", "switched to", "changed from X to Y", "was replaced by", 改为, 搬到, 换成).
  It is false for a relationship that can have several targets at once (evaluated on several datasets,
  uses several tools, member of several teams, runs several jobs): a new target there ends nothing and
  invalidates nothing. A negation ("does not replace", "is not part of", 并不取代) never sets it.
- A new target for a relationship with replacesPrevious, or a new value for a changing property kept
  in a fact (address, port, version, status), replaces the old one: emit the new fact and invalidate
  the old one. Only a property kept in a summary is updated there.
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
employer, title, manager, home, owner, status or value for a thing that has one at a time (a new
version, port, address or status of the same thing ends the old one); a reversal.
These are NOT contradictions, the existing fact stays true:
- a restatement, elaboration or confirmation of the same relationship ("still valid", "remains",
  "confirmed", more detail about it);
- another value of a relationship that can have several at once (evaluated on several datasets, uses
  several tools, member of several teams, runs several jobs; working at a company and owning shares in
  it; a role and a team membership);
- a statement that something does not replace, is separate from, or is in addition to another;
- a result for another dataset, split or experiment run.
When unsure, the existing fact is not ended.
"same" lists the existing facts that the new fact only restates, confirms or adds detail to: the same
relationship, not a separate one that holds alongside it (another job, run or result between the same
two things is separate).
Examples:
- NEW "Model M was also evaluated on benchmark B2"; EXISTING 1. "Model M was evaluated on benchmark B1"
  -> {"contradicts": false, "which": [], "same": []}
- NEW "Job 12 evaluated model M on benchmark B1"; EXISTING 1. "Job 11 evaluated model M on benchmark B1"
  -> {"contradicts": false, "which": [], "same": []}
- NEW "The Q3 test result of service S still stands"; EXISTING 1. "Service S passed the Q3 test"
  -> {"contradicts": false, "which": [], "same": [1]}
- NEW "Service S on host H was upgraded to version 2.1"; EXISTING 1. "Service S version 2.0 runs on host H"
  -> {"contradicts": true, "which": [1], "same": []}
- NEW "Dana moved from Initech to Globex"; EXISTING 1. "Dana works at Initech"
  -> {"contradicts": true, "which": [1], "same": []}
Dates in parentheses are when each fact started. The system handles the order in time: decide as if both
facts held at the same moment. The new fact may be OLDER than an existing one (a document added late):
still list every existing fact it cannot hold together with.
Return ONLY JSON: {"contradicts": true|false, "which": [numbers of the ended facts from the list],
"same": [numbers of the facts it only restates]}`;

export class OpenAICompatLLM implements LLMProvider {
  private readonly timeZone: string;
  private readonly jsonMode: boolean;
  private readonly maxTokens: number;
  private readonly maxTokensCap: number;
  private readonly timeoutMs: number;

  constructor(private cfg: LLMConfig) {
    this.timeZone = cfg.timeZone ?? process.env.MINIZEP_TIMEZONE ?? localTimeZone();
    this.jsonMode = cfg.jsonMode ?? envFlag('MINIZEP_LLM_JSON_MODE', true);
    this.maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxTokensCap = Math.max(cfg.maxTokensCap ?? 4 * this.maxTokens, this.maxTokens);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
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
   * Transient failures are sent again as they are, after a backoff, up to
   * `retries` attempts in all: HTTP 429 / 5xx, a network error or timeout,
   * and empty content. A reply cut off by max_tokens is not: a reasoning
   * model that spent the budget thinking would spend it again, so the request
   * goes again with the budget doubled, up to maxTokensCap, and fails there.
   * A request has time in proportion to its budget (see timeoutFor); one with
   * a raised budget that times out all the same is not sent again, as another
   * try would take as long. A call the caller aborts (`signal`) stops at once
   * with the signal's reason; `onRequest` is told of every request sent.
   * Returns the reply and the budget it took.
   */
  private async chat(
    messages: ChatMessage[],
    maxTokens: number,
    label: string,
    context?: LLMCallContext,
  ): Promise<{ content: string; maxTokens: number }> {
    const signal = context?.signal;
    const attempts = this.cfg.retries ?? 3;
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      context?.onRequest?.(maxTokens);
      try {
        return { content: await this.chatOnce(messages, maxTokens, label, signal), maxTokens };
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (err instanceof BudgetExhaustedError) {
          if (maxTokens >= this.maxTokensCap) {
            throw new BudgetExhaustedError(
              `${err.message}; that is the cap: raise MINIZEP_LLM_MAX_TOKENS_CAP, or turn reasoning off with MINIZEP_LLM_EXTRA_BODY`,
            );
          }
          maxTokens = Math.min(maxTokens * 2, this.maxTokensCap);
          console.error(`[minizep] LLM ${label}: ${err.message}; asking again with max_tokens=${maxTokens}`);
          continue;
        }
        const e = err as Error;
        // (AbortSignal.timeout rejects fetch with a TimeoutError)
        if (e?.name === 'TimeoutError' && maxTokens > this.maxTokens) {
          throw new Error(
            `LLM request timed out after ${this.timeoutFor(maxTokens)}ms at max_tokens=${maxTokens}, a budget raised ` +
              'after a cut-off reply; not sent again: raise MINIZEP_LLM_TIMEOUT_MS (the time a request at ' +
              'MINIZEP_LLM_MAX_TOKENS gets, in proportion above it) or lower MINIZEP_LLM_MAX_TOKENS_CAP',
          );
        }
        failures++;
        const retryable = /empty content|HTTP (429|5\d\d)|fetch failed|timeout|aborted/i.test(e.message);
        if (!retryable || failures >= attempts) throw e;
        const backoff = (this.cfg.backoffMs ?? 500) * 2 ** (failures - 1);
        console.error(`[minizep] LLM attempt ${failures}/${attempts} failed (${e.message.slice(0, 80)}); retrying in ${backoff}ms`);
        await sleep(backoff, signal);
      }
    }
  }

  /**
   * A request's timeout: timeoutMs at the first budget, and in proportion
   * above it, since a reply that uses its budget takes time in proportion to
   * it (a doubled budget gets twice as long).
   */
  private timeoutFor(maxTokens: number): number {
    return Math.min(Math.round((this.timeoutMs * maxTokens) / this.maxTokens), MAX_TIMEOUT_MS);
  }

  /**
   * A chat answered with one JSON object. A complete reply that does not
   * parse is handed back once with the parse error, with the budget that
   * reply took; a second bad reply throws, which fails the episode like any
   * other extraction error. A cut-off reply never gets here (see chat()).
   */
  private async chatJson(system: string, userPrompt: string, kind: string, context?: LLMCallContext): Promise<unknown> {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ];
    const label = callLabel(kind, context);
    const first = await this.chat(messages, this.maxTokens, label, context);
    try {
      return parseJsonObject(first.content);
    } catch (err) {
      if (!(err instanceof JsonReplyError)) throw err;
      console.error(`[minizep] LLM ${label}: reply is not valid JSON (${err.problem}); asking once more`);
      const again = await this.chat(
        [
          ...messages,
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content:
              `Your reply is not valid JSON: ${err.problem}. ` +
              'Return valid JSON only: the whole object, no prose, no markdown fences.',
          },
        ],
        first.maxTokens,
        `${label} (repair)`,
        context,
      );
      return parseJsonObject(again.content);
    }
  }

  /** One request, logged in one line: what it was for, how long it took, what the budget went to. */
  private async chatOnce(messages: ChatMessage[], maxTokens: number, label: string, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    let outcome = '';
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          temperature: 0,
          ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...this.cfg.extraBody,
          model: this.cfg.model,
          messages,
          max_tokens: maxTokens,
        }),
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(this.timeoutFor(maxTokens)), signal])
          : AbortSignal.timeout(this.timeoutFor(maxTokens)),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; reasoning_content?: string }; finish_reason?: string | null }[];
        usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      const choice = data.choices?.[0];
      const finish = choice?.finish_reason ?? '?';
      const completion = data.usage?.completion_tokens;
      const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
      outcome = ` finish_reason=${finish} completion_tokens=${completion ?? '?'} reasoning_tokens=${reasoning ?? '?'}`;
      const content = choice?.message?.content ?? '';
      const spent = Math.max(completion ?? 0, reasoning ?? 0);
      if (finish === 'length' || (!content.trim() && spent >= maxTokens * NEAR_BUDGET)) {
        throw new BudgetExhaustedError(
          `reply cut off by max_tokens=${maxTokens} (finish_reason=${finish}, reasoning_tokens=${reasoning ?? '?'})`,
        );
      }
      if (!content.trim()) throw new Error(`empty content (reasoning_tokens=${reasoning ?? '?'})`);
      return content;
    } catch (err) {
      outcome +=
        err instanceof BudgetExhaustedError
          ? ' cut off'
          : signal?.aborted
            ? ' cancelled'
            : ` failed: ${((err as Error)?.message ?? String(err)).slice(0, 120)}`;
      throw err;
    } finally {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.error(`[minizep] LLM ${label} ${secs}s max_tokens=${maxTokens}${outcome}`);
    }
  }

  async extract(
    content: string,
    knownEntityNames: string[],
    knownFacts: KnownFact[] = [],
    options: ExtractOptions = {},
  ): Promise<ExtractionResult> {
    // the pipeline always passes the episode's time; a direct caller gets now
    const opts = { ...options, referenceTime: options.referenceTime ?? new Date() };
    const parsed = (await this.chatJson(
      EXTRACTION_SYSTEM,
      buildExtractionPrompt(content, knownEntityNames, knownFacts, opts, this.timeZone),
      'extract',
      options.context,
    )) as {
      entities?: { name: string; mention?: string | null; labels?: string[]; summary?: string }[];
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

    const entities: ExtractedEntity[] = (parsed.entities ?? [])
      .filter((e) => e && typeof e.name === 'string' && e.name.trim())
      .map((e) => {
        const name = e.name.trim();
        const mention = typeof e.mention === 'string' ? e.mention.trim() : '';
        return {
          name,
          labels: Array.isArray(e.labels) ? e.labels.filter((l) => typeof l === 'string') : [],
          summary: typeof e.summary === 'string' ? e.summary.trim() : '',
          ...(mention && mention !== name ? { mention } : {}),
        };
      });

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
    context?: LLMCallContext,
  ): Promise<ContradictionVerdict> {
    if (existing.length === 0) return { ended: [], same: [] };
    const list = existing.map((e, i) => `${i + 1}. ${e.fact}${since(e.validAt, this.timeZone)}`).join('\n');
    const parsed = await this.chatJson(
      CONTRADICTION_SYSTEM,
      `New fact${candidate.replacesPrevious ? ' (it replaces an earlier value)' : ''}: ` +
        `${candidate.fact}${since(candidate.validAt, this.timeZone)}\n\nExisting facts:\n${list}`,
      'judge',
      context,
    );
    const same = parseSame(parsed, existing.length);
    return { ended: parseContradiction(parsed, existing.length), ...(same ? { same } : {}) };
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
  const which = zeroBased(p.which, count);
  if (which.length === 0 && p.contradicts === true) {
    console.error(
      `[minizep] contradiction answer names no fact of 1..${count} (which=${JSON.stringify(p.which).slice(0, 80)}); closing none`,
    );
  }
  return which;
}

/**
 * "same": the facts the new one only restates, 1-based like "which". Undefined
 * when the reply has no such list: the pipeline then takes every fact of the
 * same pair and relation that is not ended as restated, as before.
 */
function parseSame(parsed: unknown, count: number): number[] | undefined {
  const same = ((parsed ?? {}) as { same?: unknown }).same;
  return same === undefined || same === null ? undefined : zeroBased(same, count);
}

/** 1-based numbers (or numeric strings, or one bare number) within 1..count -> distinct 0-based indexes. */
function zeroBased(listed: unknown, count: number): number[] {
  const all = Array.isArray(listed) ? listed : [listed];
  return [...new Set(all.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))].map((n) => n - 1);
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
      'Known entities (reuse a name exactly, and only for the same referent; the summary is what is already known):\n' +
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

/** "extract episode=0760aeb1 group=hanja-asr": what a call was for, in the log. */
function callLabel(kind: string, context?: LLMCallContext): string {
  const parts = [kind];
  if (context?.episodeId) parts.push(`episode=${context.episodeId.slice(0, 8)}`);
  if (context?.groupId) parts.push(`group=${context.groupId}`);
  return parts.join(' ');
}

/**
 * A reply cut off by max_tokens, or with no content after using up nearly all
 * of it: a larger budget may finish it, the same request would not.
 */
class BudgetExhaustedError extends Error {}

/** Wait `ms`, or less when `signal` aborts (the caller then stops). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A reply that holds no parseable JSON object; `problem` says why, without the reply. */
class JsonReplyError extends Error {
  constructor(
    readonly problem: string,
    raw: string,
  ) {
    super(`${problem} in LLM output: ${raw.slice(0, 160)}`);
  }
}

/** Tolerates fenced code blocks and surrounding prose. */
function parseJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new JsonReplyError('no JSON object', raw);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new JsonReplyError(`invalid JSON (${(err as Error).message.slice(0, 120)})`, raw);
  }
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
  // outside the try: a bad setting fails the start, it is no reason to fall back
  const settings = llmSettingsFromEnv();
  let cfg: LLMConfig;
  try {
    cfg = { ...credentialsSync(), ...settings };
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

/**
 * The request settings from the environment: MINIZEP_LLM_MAX_TOKENS,
 * MINIZEP_LLM_MAX_TOKENS_CAP, MINIZEP_LLM_TIMEOUT_MS, MINIZEP_LLM_RETRIES and
 * MINIZEP_LLM_EXTRA_BODY (a JSON object). A value that is set but unusable
 * throws, so a typo fails the start instead of running with the default.
 */
export function llmSettingsFromEnv(): Pick<LLMConfig, 'maxTokens' | 'maxTokensCap' | 'timeoutMs' | 'retries' | 'extraBody'> {
  // each name spelled out at its read, where deploy/test/install.test.sh looks for them
  const positive = (name: string, value: string | undefined, max: number): number | undefined => {
    const raw = value?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}, got "${raw}"`);
    return n;
  };
  const maxTokens = positive('MINIZEP_LLM_MAX_TOKENS', process.env.MINIZEP_LLM_MAX_TOKENS, MAX_TOKENS_LIMIT);
  const maxTokensCap = positive('MINIZEP_LLM_MAX_TOKENS_CAP', process.env.MINIZEP_LLM_MAX_TOKENS_CAP, MAX_TOKENS_LIMIT);
  if (maxTokensCap !== undefined && maxTokensCap < (maxTokens ?? DEFAULT_MAX_TOKENS)) {
    throw new Error(
      `MINIZEP_LLM_MAX_TOKENS_CAP (${maxTokensCap}) is below MINIZEP_LLM_MAX_TOKENS (${maxTokens ?? DEFAULT_MAX_TOKENS})`,
    );
  }
  let extraBody: Record<string, unknown> | undefined;
  const raw = process.env.MINIZEP_LLM_EXTRA_BODY?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`MINIZEP_LLM_EXTRA_BODY is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MINIZEP_LLM_EXTRA_BODY must be a JSON object');
    }
    extraBody = parsed as Record<string, unknown>;
  }
  return {
    maxTokens,
    maxTokensCap,
    timeoutMs: positive('MINIZEP_LLM_TIMEOUT_MS', process.env.MINIZEP_LLM_TIMEOUT_MS, MAX_TIMEOUT_MS),
    // (the backoff doubles per attempt: past ten it would outgrow a timer too)
    retries: positive('MINIZEP_LLM_RETRIES', process.env.MINIZEP_LLM_RETRIES, 10),
    extraBody,
  };
}

/** Env-only config, so it works where the developer's dotfiles do not exist. */
export function loadLLMConfigSync(
  model = process.env.MINIZEP_LLM_MODEL ?? 'deepseek-flash',
): LLMConfig {
  return { ...credentialsSync(model), ...llmSettingsFromEnv() };
}

/** The endpoint, key and model: explicit env vars, else the machine's provider credentials. */
function credentialsSync(model = process.env.MINIZEP_LLM_MODEL ?? 'deepseek-flash'): LLMConfig {
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
  const settings = llmSettingsFromEnv();
  const envKey = process.env.MINIZEP_LLM_API_KEY;
  const envBase = process.env.MINIZEP_LLM_BASE_URL;
  if (envKey && envBase) return { baseUrl: envBase, apiKey: envKey, model, ...settings };

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
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model, ...settings };
}

// re-exported for symmetry with the embedders
export type { Embedder };
