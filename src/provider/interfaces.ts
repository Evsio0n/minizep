/**
 * Pluggable provider interfaces. The framework ships with deterministic
 * defaults so the whole pipeline runs offline; wire any OpenAI-compatible
 * endpoint in later without touching pipeline code.
 */

export interface ExtractedEntity {
  name: string;
  labels: string[];
  summary: string;
}

export interface ExtractedFact {
  sourceName: string;
  targetName: string;
  relation: string;
  fact: string;
  /** when the fact became true, if the text says so */
  validAt?: Date;
  /** when the fact stopped being true, if the text says so */
  invalidAt?: Date;
}

/**
 * A relationship the text says has ENDED ("Alice left Acme", "Bob quit").
 * Modeled separately from `facts` on purpose: a termination is not a new
 * relationship, it closes an existing one. The pipeline turns it into
 * `invalidAt`/`expiredAt` on the matching active edge instead of creating
 * a redundant `LEFT`/`QUIT` edge.
 */
export interface ExtractedInvalidation {
  sourceName: string;
  targetName: string;
  /** optional; narrows which existing relation ended */
  relation?: string;
  /** when it ended, if the text says so */
  invalidAt?: Date;
  /** short justification, kept for auditing */
  reason?: string;
}

/** An existing active edge, handed to the LLM so it can reference it exactly. */
export interface KnownFact {
  sourceName: string;
  targetName: string;
  relation: string;
  fact: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  invalidations: ExtractedInvalidation[];
}

export interface LLMProvider {
  extract(
    content: string,
    knownEntityNames: string[],
    knownFacts?: KnownFact[],
  ): Promise<ExtractionResult>;
  /** Does candidate fact contradict an existing fact between the same pair? */
  detectContradiction(
    candidate: { sourceName: string; targetName: string; fact: string },
    existing: { fact: string; validAt?: Date; invalidAt?: Date }[],
  ): Promise<boolean>;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class HashEmbedder implements Embedder {
  // lazy import-free wiring done in retrieval.ts; re-exported here
  constructor(private dims = 256) {}
  async embed(text: string): Promise<number[]> {
    const { hashEmbed } = await import('../search/retrieval.js');
    return hashEmbed(text, this.dims);
  }
}
