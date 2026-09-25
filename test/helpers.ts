import type {
  ContradictionCandidate,
  ContradictionExisting,
  ExtractionResult,
  ExtractOptions,
  KnownFact,
  LLMProvider,
} from '../src/provider/interfaces.js';
import { HashEmbedder } from '../src/provider/interfaces.js';

/**
 * How a scripted LLM answers detectContradiction: `true` ends every existing
 * fact it is shown, `false` none, a function picks indexes itself.
 */
export type ContradictionScript =
  | boolean
  | ((candidate: ContradictionCandidate, existing: ContradictionExisting[]) => number[]);

/**
 * Deterministic, scriptable LLM stand-in. Tests must never touch the network,
 * otherwise the temporal semantics they assert are not reproducible.
 */
export class ScriptedLLM implements LLMProvider {
  readonly calls: { content: string; known: string[]; knownFacts: KnownFact[]; options: ExtractOptions }[] = [];
  readonly contradictionCalls: { candidate: ContradictionCandidate; existing: ContradictionExisting[] }[] = [];

  constructor(
    private handler: (content: string) => ExtractionResult | Promise<ExtractionResult>,
    private contradictions: ContradictionScript = false,
    private delayMs = 0,
  ) {}

  async extract(
    content: string,
    known: string[] = [],
    knownFacts: KnownFact[] = [],
    options: ExtractOptions = {},
  ): Promise<ExtractionResult> {
    this.calls.push({ content, known, knownFacts, options });
    // a real await point: this is what lets concurrent calls interleave if the
    // pipeline does not serialise them
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    else await Promise.resolve();
    return this.handler(content);
  }

  async detectContradiction(
    candidate: ContradictionCandidate,
    existing: ContradictionExisting[],
  ): Promise<number[]> {
    this.contradictionCalls.push({ candidate, existing });
    if (typeof this.contradictions === 'function') return this.contradictions(candidate, existing);
    return this.contradictions ? existing.map((_, i) => i) : [];
  }
}

/** Always fails — used to prove extraction failures are isolated, not fatal. */
export class BrokenLLM implements LLMProvider {
  attempts = 0;
  constructor(private message = 'upstream exploded') {}
  async extract(): Promise<ExtractionResult> {
    this.attempts++;
    throw new Error(this.message);
  }
  async detectContradiction(): Promise<number[]> {
    return [];
  }
}

export const deterministicEmbedder = () => new HashEmbedder(64);

/**
 * Embedder whose await yields at a MACROtask boundary, like a real network
 * call to llama.cpp does.
 *
 * This distinction is the whole point: `HashEmbedder` awaits only already-
 * resolved promises (microtasks), and the JS engine drains the microtask queue
 * between macrotasks, which accidentally serialises concurrent pipelines. Real
 * I/O does not, so a concurrency test built on HashEmbedder alone proves
 * nothing — use this one to actually exercise interleaving.
 */
export class SlowEmbedder extends HashEmbedder {
  constructor(
    private delayMs = 2,
    dims = 64,
  ) {
    super(dims);
  }
  override async embed(text: string): Promise<number[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.embed(text);
  }
}

/** Convenience builders for extraction payloads. */
export const entity = (name: string, labels: string[] = ['Person']) => ({
  name,
  labels,
  summary: `${name} summary`,
});

export const fact = (
  sourceName: string,
  targetName: string,
  relation: string,
  extra: Partial<{ validAt: Date; invalidAt: Date; replacesPrevious: boolean }> = {},
) => ({
  sourceName,
  targetName,
  relation,
  fact: `${sourceName} --${relation}--> ${targetName}`,
  ...extra,
});

export const invalidation = (
  sourceName: string,
  targetName: string,
  relation?: string,
  invalidAt?: Date,
) => ({
  sourceName,
  targetName,
  relation,
  invalidAt,
  reason: 'text states it ended',
});
