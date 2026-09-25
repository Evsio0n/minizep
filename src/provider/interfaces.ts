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
   * This target replaces the earlier one: the relationship holds one target
   * at a time for its source (employer, title or role, home, manager, owner),
   * or the text says the value was replaced ("moved to", "changed from X to
   * Y"). Only for such a fact, and for the relations the pipeline knows hold
   * one target at a time (WORKS_AT, HAS_ROLE, ...), are the facts with the same
   * source and relation but another target checked for contradiction; most
   * relations can hold several values at once. Absent means false.
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
  /** the extraction says it replaces an earlier target (see ExtractedFact) */
  replacesPrevious?: boolean;
}

/** An existing fact that the candidate might end. */
export interface ContradictionExisting {
  fact: string;
  validAt?: Date;
  invalidAt?: Date;
}

/** What the candidate does to the existing facts, as 0-based indexes into `existing`. */
export interface ContradictionVerdict {
  /** the facts it ends */
  ended: number[];
  /**
   * The facts it only restates, confirms or adds detail to (the same
   * relationship). Absent: not told apart, and every fact between the same
   * pair and relation that is not ended counts as restated.
   */
  same?: number[];
}

export interface LLMProvider {
  extract(
    content: string,
    knownEntityNames: string[],
    knownFacts?: KnownFact[],
    options?: ExtractOptions,
  ): Promise<ExtractionResult>;
  /**
   * Which existing facts does the candidate end? Returns a verdict, or just
   * the 0-based indexes of the ended facts into `existing` (empty: none).
   * `existing` holds the active facts between the same pair; facts with the
   * same source and relation but another target only when that relation holds
   * one target at a time, or when such a fact began after the candidate (a
   * document added late). An existing fact of the candidate's own relation
   * and pair that it does not end is taken as restated (it gains the evidence)
   * unless a verdict's `same` leaves it out: then the candidate holds
   * alongside it as a fact of its own. Providers written against the old
   * boolean contract are still accepted by the pipeline: `true` means "all of
   * them".
   */
  detectContradiction(
    candidate: ContradictionCandidate,
    existing: ContradictionExisting[],
  ): Promise<number[] | ContradictionVerdict>;
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
