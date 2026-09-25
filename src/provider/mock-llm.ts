import type {
  ContradictionCandidate,
  ContradictionExisting,
  ExtractionResult,
  ExtractOptions,
  KnownFact,
  LLMProvider,
} from './interfaces.js';

/**
 * Rule-based mock extractor — zero network, deterministic.
 * Recognizes simple English/Chinese patterns like
 * "A works at B", "A likes B", "A 在 B 工作".
 * It exists only to exercise the pipeline; real deployments
 * implement LLMProvider with an actual model.
 *
 * Terminations ("left", "离开") are reported as invalidations, matching how
 * the real provider is expected to behave. Their time is left to the pipeline
 * (the episode's validAt), never the wall clock.
 */
export class MockLLMProvider implements LLMProvider {
  async extract(
    content: string,
    _known: string[],
    _knownFacts: KnownFact[] = [],
    _options: ExtractOptions = {},
  ): Promise<ExtractionResult> {
    const entities = new Map<string, { name: string; labels: string[]; summary: string }>();
    const facts: ExtractionResult['facts'] = [];
    const invalidations: ExtractionResult['invalidations'] = [];

    const addEntity = (name: string, labels: string[]) => {
      if (!name || name.length < 2) return;
      if (!entities.has(name.toLowerCase()))
        entities.set(name.toLowerCase(), { name, labels, summary: `Mentioned: ${name}` });
    };

    // ongoing relationships
    const positive: Array<[RegExp, string]> = [
      [/\b([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+(?:works? at|joined)\s+([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)/g, 'WORKS_AT'],
      [/\b([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+(?:likes?|loves?|prefers?)\s+([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)/g, 'LIKES'],
      [/([\u4e00-\u9fa5]{2,8})\s*在\s*([\u4e00-\u9fa5]{2,10})\s*工作/g, 'WORKS_AT'],
      [/([\u4e00-\u9fa5]{2,8})\s*喜欢\s*([\u4e00-\u9fa5]{2,10})/g, 'LIKES'],
    ];
    // terminations — these close a relation instead of creating one
    const negative: Array<[RegExp, string, string]> = [
      [/\b([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)\s+left\s+([A-Z][\w'-]*(?:\s[A-Z][\w'-]*)?)/g, 'WORKS_AT', 'left'],
      [/([\u4e00-\u9fa5]{2,8})\s*离开\s*(?:了)?\s*([\u4e00-\u9fa5]{2,10})/g, 'WORKS_AT', '离开'],
    ];

    for (const [re, relation] of positive) {
      for (const m of content.matchAll(re)) {
        const [, a, b] = m;
        addEntity(a, ['Person']);
        addEntity(b, ['Organization']);
        facts.push({
          sourceName: a.trim(),
          targetName: b.trim(),
          relation,
          // the matched clause is the self-contained sentence
          fact: m[0].trim(),
        });
      }
    }

    for (const [re, relation, why] of negative) {
      for (const m of content.matchAll(re)) {
        const [, a, b] = m;
        addEntity(a, ['Person']);
        addEntity(b, ['Organization']);
        invalidations.push({
          sourceName: a.trim(),
          targetName: b.trim(),
          relation,
          reason: `text states "${why}"`,
        });
      }
    }

    return {
      entities: [...entities.values()],
      facts,
      invalidations,
    };
  }

  async detectContradiction(
    candidate: ContradictionCandidate,
    existing: ContradictionExisting[],
  ): Promise<number[]> {
    // mock heuristic: same relation word + negation/antonym markers
    const antonyms = [['joins', 'left'], ['likes', 'hates']];
    const ended: number[] = [];
    existing.forEach((e, i) => {
      const hit = antonyms.some(
        ([x, y]) =>
          (e.fact.includes(x) && candidate.fact.includes(y)) || (e.fact.includes(y) && candidate.fact.includes(x)),
      );
      if (hit) ended.push(i);
    });
    return ended;
  }
}
