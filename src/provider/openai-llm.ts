import type {
  Embedder,
  ExtractedFact,
  ExtractedInvalidation,
  ExtractionResult,
  KnownFact,
  LLMProvider,
} from './interfaces.js';
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
}

const EXTRACTION_SYSTEM = `You extract a temporal knowledge graph from text.
Return ONLY a JSON object, no prose, no markdown fences:
{"entities":[{"name":"string","labels":["Person"|"Organization"|"Concept"|"Event"|"Location"|"Preference"],"summary":"one sentence"}],
 "facts":[{"sourceName":"string","targetName":"string","relation":"SCREAMING_SNAKE_CASE","fact":"<subject> --<RELATION>--> <object>","validAt":"ISO-8601 or null","invalidAt":"ISO-8601 or null"}],
 "invalidations":[{"sourceName":"string","targetName":"string","relation":"SCREAMING_SNAKE_CASE or null","invalidAt":"ISO-8601 or null","reason":"short justification"}]}

facts vs invalidations — this distinction is critical:
- "facts" are relationships that hold (or start holding) from the text.
- "invalidations" are relationships that the text says have ENDED or no longer hold.
  An ending is NOT a new relationship. If the text says someone left, quit, resigned,
  stopped, broke up, cancelled, or no longer does something, put it in "invalidations"
  and reference the ORIGINAL relation it terminates — do NOT invent a LEFT/QUIT/ENDED fact.
  Example: given active fact "Alice --WORKS_AT--> Acme", the text "Alice left Acme"
  yields invalidations: [{"sourceName":"Alice","targetName":"Acme","relation":"WORKS_AT",
  "invalidAt":"<date>","reason":"text states Alice left Acme"}] and NO new fact.

Other rules:
- entity names must be the canonical surface form, reused consistently
- every fact must reference two entities that appear in "entities"
- validAt = when the fact became true; invalidAt (inside facts) = when it stopped being true
- if a relationship is terminated in the same sentence that introduces it, use invalidAt in facts
- never invent facts that are not supported by the text
- emit empty arrays when a category has no entries`;

export class OpenAICompatLLM implements LLMProvider {
  constructor(private cfg: LLMConfig) {}

  /**
   * One chat completion, with retries.
   *
   * Two failure modes are treated as retryable because they are transient and
   * observed in practice against DeepSeek:
   *   - HTTP 429 / 5xx (rate limit, upstream hiccup)
   *   - empty `content` because the reasoning budget consumed all max_tokens
   */
  private async chat(userPrompt: string, maxTokens: number): Promise<string> {
    const attempts = this.cfg.retries ?? 3;
    let lastErr: Error | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        return await this.chatOnce(userPrompt, maxTokens);
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

  private async chatOnce(userPrompt: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM },
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
  ): Promise<ExtractionResult> {
    const known = knownEntityNames.length
      ? `\nKnown entities already in the graph (reuse these exact names when they match): ${knownEntityNames.join(', ')}`
      : '';
    const active = knownFacts.length
      ? `\nActive relationships currently in the graph (terminations must reference these):\n` +
        knownFacts.map((f) => `- ${f.fact}`).join('\n')
      : '';
    const raw = await this.chat(`Text:\n${content}${known}${active}`, this.cfg.maxTokens ?? 8000);
    const parsed = parseJsonObject(raw) as {
      entities?: { name: string; labels?: string[]; summary?: string }[];
      facts?: {
        sourceName: string;
        targetName: string;
        relation: string;
        fact: string;
        validAt?: string | null;
        invalidAt?: string | null;
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
      .filter((e) => e && typeof e.name === 'string')
      .map((e) => ({
        name: e.name.trim(),
        labels: e.labels ?? [],
        summary: e.summary ?? '',
      }));

    // keep only facts whose endpoints were actually extracted as entities
    const names = new Set(entities.map((e) => e.name.toLowerCase()));
    const facts: ExtractedFact[] = (parsed.facts ?? [])
      .filter(
        (f) =>
          f &&
          typeof f.sourceName === 'string' &&
          typeof f.targetName === 'string' &&
          typeof f.fact === 'string' &&
          names.has(f.sourceName.trim().toLowerCase()) &&
          names.has(f.targetName.trim().toLowerCase()),
      )
      .map((f) => ({
        sourceName: f.sourceName.trim(),
        targetName: f.targetName.trim(),
        relation: (f.relation ?? 'RELATES_TO').trim(),
        fact: f.fact.trim(),
        validAt: toDate(f.validAt),
        invalidAt: toDate(f.invalidAt),
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
    // would be silently dropped downstream, so make sure they exist
    for (const iv of invalidations) {
      for (const n of [iv.sourceName, iv.targetName]) {
        if (!names.has(n.toLowerCase())) {
          entities.push({ name: n, labels: [], summary: `Referenced by ${iv.reason ?? 'text'}` });
          names.add(n.toLowerCase());
        }
      }
    }

    return { entities, facts, invalidations };
  }

  async detectContradiction(
    candidate: { sourceName: string; targetName: string; fact: string },
    existing: { fact: string; validAt?: Date; invalidAt?: Date }[],
  ): Promise<boolean> {
    if (existing.length === 0) return false;
    const list = existing.map((e, i) => `${i + 1}. ${e.fact}`).join('\n');
    const raw = await this.chat(
      `New fact: ${candidate.fact}\nExisting facts about the same two entities:\n${list}\n\n` +
        `Does the new fact make any existing fact no longer true (e.g. a job change, a reversal, an update)? ` +
        `Answer ONLY JSON: {"contradicts": true|false, "which":[indexes]}`,
      this.cfg.maxTokens ?? 8000,
    );
    const parsed = parseJsonObject(raw) as { contradicts?: boolean; which?: number[] };
    return parsed.contradicts === true;
  }
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
  try {
    const cfg = loadLLMConfigSync();
    return { llm: new OpenAICompatLLM(cfg), label: `${cfg.model} @ ${cfg.baseUrl}` };
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
