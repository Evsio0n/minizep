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
  /**
   * The text says this value replaces an earlier one ("moved to", "now works
   * at", "changed from X to Y"). Only then are the facts with the same source
   * and relation but another target checked for contradiction; most relations
   * can hold several values at once. Absent means false.
   */
  replacesPrevious?: boolean;
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
  /** when it became true, so the LLM can reason about what ended when */
  validAt?: Date;
}

/** An existing entity, handed to the LLM with what we already know about it. */
export interface KnownEntity {
  name: string;
  summary: string;
}

export interface ExtractOptions {
  /**
   * The instant the text speaks from (the episode's validAt). Relative
   * expressions ("yesterday", "next Monday", "上个月") must be resolved
   * against it, never against the wall clock.
   */
  referenceTime?: Date;
  /**
   * The known entities (the same set as `knownEntityNames`) with their current
   * summaries, so the LLM can return an updated summary that keeps them.
   */
  knownEntities?: KnownEntity[];
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  invalidations: ExtractedInvalidation[];
}

/** The new fact handed to detectContradiction. */
export interface ContradictionCandidate {
  sourceName: string;
  targetName: string;
  fact: string;
  relation?: string;
  validAt?: Date;
  /** the text says it replaces an earlier value (see ExtractedFact) */
  replacesPrevious?: boolean;
}

/** An existing fact that the candidate might end. */
export interface ContradictionExisting {
  fact: string;
  validAt?: Date;
  invalidAt?: Date;
}

export interface LLMProvider {
  extract(
    content: string,
    knownEntityNames: string[],
    knownFacts?: KnownFact[],
    options?: ExtractOptions,
  ): Promise<ExtractionResult>;
  /**
   * Which existing facts does the candidate end? Returns their 0-based indexes
   * into `existing` (empty: none). `existing` holds the active facts between
   * the same pair; facts with the same source and relation but another target
   * only when the candidate replaces an earlier value, or when such a fact
   * replaced an earlier value after the candidate began (a document added
   * late). Providers written against the old boolean contract are still
   * accepted by the pipeline: `true` means "all of them".
   */
  detectContradiction(
    candidate: ContradictionCandidate,
    existing: ContradictionExisting[],
  ): Promise<number[]>;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  /** vector length, when the embedder knows it up front */
  readonly dims?: number;
}

export class HashEmbedder implements Embedder {
  // lazy import-free wiring done in retrieval.ts; re-exported here
  constructor(readonly dims = 256) {}
  async embed(text: string): Promise<number[]> {
    const { hashEmbed } = await import('../search/retrieval.js');
    return hashEmbed(text, this.dims);
  }
}
