import type { GraphStore } from '../store/memory-store.js';
import type {
  Embedder,
  ExtractedEntity,
  ExtractedFact,
  ExtractedInvalidation,
  ExtractionResult,
  KnownEntity,
  KnownFact,
  LLMProvider,
} from '../provider/interfaces.js';
import type { EntityEdge, EntityNode, EpisodicNode } from '../model/types.js';
import { isFactActive, uuid } from '../model/types.js';
import { KeyedMutex } from '../util/mutex.js';
import { contentHash, idempotencyKey } from '../util/hash.js';
import { cosineSimilarity } from '../search/retrieval.js';

/** What one ingestion actually changed — surfaced to callers (CLI, MCP tools). */
export interface IngestResult {
  episode: EpisodicNode;
  /** 'duplicate': an identical episode had already been processed; nothing ran */
  status: 'processed' | 'failed' | 'duplicate';
  /** entities created or updated by this episode */
  entities: EntityNode[];
  /** edges created (deduped repeats are not listed) */
  facts: EntityEdge[];
  /** facts refreshed because the same statement was repeated */
  reinforced: EntityEdge[];
  /** existing facts closed by this episode (terminations / contradictions) */
  invalidated: EntityEdge[];
  /** extracted candidates discarded because an endpoint could not be resolved */
  dropped: { facts: number; invalidations: number };
  /** true when processing failed and the episode was stored for retry */
  failed?: boolean;
  /** why processing failed (present when failed === true) */
  error?: string;
  /** true when this exact episode had already been ingested into this group */
  duplicate?: boolean;
}

/** One episode to ingest. */
export interface EpisodeInput {
  groupId: string;
  content: string;
  source?: EpisodicNode['source'];
  sourceDescription?: string;
  /** when it happened in the real world (default: now) */
  validAt?: Date;
  name?: string;
  /**
   * Caller-supplied idempotency key. Replaces the default key (normalised
   * content + UTC day of validAt): a resend with the same key is a duplicate
   * whatever its content or date.
   */
  idempotencyKey?: string;
}

export interface IngestOptions {
  /**
   * Skip an episode already processed in the same group (default true).
   * The key is the normalised content plus the UTC day of validAt (or the
   * explicit idempotencyKey), so re-sending the same note is a no-op while the
   * same sentence on another day is a new episode.
   */
  idempotent?: boolean;
}

/** same endpoints + relation and fact texts at least this similar: one fact */
const PARAPHRASE_COSINE = 0.92;
/** known entities sent to the LLM beyond the ones named in the text */
const MAX_RANKED_ENTITIES = 50;
/** entities named in the text that are sent to the LLM */
const MAX_MENTIONED_ENTITIES = 200;
/** active relationships sent to the LLM, and the entities they are read from */
const MAX_KNOWN_FACTS = 50;
const MAX_FACT_ENTITIES = 30;
/** how much of a long episode is embedded to rank known entities */
const RANKING_TEXT_CHARS = 2000;

/**
 * Ingestion pipeline, mirroring Graphiti's add_episode():
 *   1. persist the episode as 'pending' (L0 provenance)
 *   2. LLM extraction of candidate entities, facts and invalidations, with the
 *      episode's validAt as the reference time for relative dates
 *   3. node resolution: dedupe against existing entities by name
 *   4. every embedding (entity names + facts) is computed
 *   5. edge resolution, still in memory:
 *        a. paraphrase dedupe, including out-of-order (older) episodes
 *        b. contradiction detection -> temporal supersede
 *           (old fact gets invalidAt/expiredAt, NEVER deleted)
 *        c. explicit invalidations -> close the named relation, no new edge
 *   6. only then is anything written, and the episode marked 'processed'
 *
 * Production guarantees:
 *   - serialised per group: calls for the same group run one at a time, so
 *     graph mutations never interleave across await points; different groups
 *     ingest concurrently
 *   - idempotent: the same episode in the same group is processed once
 *   - failure-isolated: ANY error after the episode is saved (LLM, embeddings,
 *     store) marks it 'failed' with the reason; nothing is written before the
 *     last fallible step, and a failed or pending episode is retried in place
 */
export class IngestPipeline {
  private readonly locks = new KeyedMutex();

  constructor(
    private store: GraphStore,
    private llm: LLMProvider,
    private embedder: Embedder,
  ) {}

  /** Save + process, as one serialised step for the group. */
  async addEpisode(input: EpisodeInput, options: IngestOptions = {}): Promise<IngestResult> {
    return this.locks.run(input.groupId, async () => {
      const { episode, duplicate } = await this.saveLocked(input, options);
      return duplicate ? duplicateResult(episode) : this.processLocked(episode);
    });
  }

  /**
   * Persist the episode as 'pending' without processing it, so the raw text
   * is durable before any slow or fallible work starts (async ingestion).
   * When idempotent, an already-processed episode with the same key is
   * returned as a duplicate, and a failed or pending one is reused in place.
   */
  async saveEpisode(
    input: EpisodeInput,
    options: IngestOptions = {},
  ): Promise<{ episode: EpisodicNode; duplicate: boolean }> {
    return this.locks.run(input.groupId, () => this.saveLocked(input, options));
  }

  /** Process a saved episode (a no-op 'duplicate' when it is already processed). */
  async processEpisode(episodeUuid: string): Promise<IngestResult> {
    const saved = await this.store.getEpisode(episodeUuid);
    if (!saved) throw new Error(`episode ${episodeUuid} not found`);
    return this.locks.run(saved.groupId, async () => {
      // re-read under the lock: another caller may have processed it meanwhile
      const episode = (await this.store.getEpisode(episodeUuid)) ?? saved;
      return isProcessed(episode) ? duplicateResult(episode) : this.processLocked(episode);
    });
  }

  /**
   * Re-process episodes whose processing previously failed, in place.
   *
   * Failed episodes hold raw text that was never turned into graph facts; this
   * is the recovery path for an LLM or embedding outage. A failed retry keeps
   * the same record with a fresh error.
   */
  async retryFailed(groupId?: string): Promise<{ retried: number; succeeded: number; stillFailing: number }> {
    const failed = (await this.store.getEpisodes(groupId)).filter((e) => e.status === 'failed');
    let succeeded = 0;
    let stillFailing = 0;
    for (const ep of failed) {
      const res = await this.processEpisode(ep.uuid);
      if (res.status === 'failed') stillFailing++;
      else succeeded++;
    }
    return { retried: failed.length, succeeded, stillFailing };
  }

  /**
   * Episodes saved but never processed (e.g. the process died with work
   * queued). Servers re-enqueue these at startup; oldest first.
   */
  async recoverPending(groupId?: string): Promise<EpisodicNode[]> {
    return (await this.store.getEpisodes(groupId))
      .filter((e) => e.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Only ever executed while holding the group's lock. */
  private async saveLocked(
    input: EpisodeInput,
    options: IngestOptions,
  ): Promise<{ episode: EpisodicNode; duplicate: boolean }> {
    const now = new Date();
    const validAt = input.validAt ?? now;
    const key = idempotencyKey(input.content, validAt, input.idempotencyKey);

    if (options.idempotent !== false) {
      const matches = (await this.store.getEpisodes(input.groupId)).filter((e) =>
        sameEpisode(e, key, input, validAt),
      );
      const done = matches.find(isProcessed);
      if (done) return { episode: done, duplicate: true };
      const unfinished = matches[0];
      if (unfinished) {
        // an earlier attempt failed or never ran: process that record again
        // instead of piling up a second copy of the same episode
        unfinished.status = 'pending';
        unfinished.error = undefined;
        await this.store.addEpisode(unfinished);
        return { episode: unfinished, duplicate: false };
      }
    }

    const episode: EpisodicNode = {
      type: 'episode',
      uuid: uuid(),
      groupId: input.groupId,
      name: input.name ?? input.content.slice(0, 60),
      source: input.source ?? 'text',
      sourceDescription: input.sourceDescription ?? 'user input',
      content: input.content,
      validAt,
      createdAt: now,
      status: 'pending',
      contentHash: key,
    };
    await this.store.addEpisode(episode);
    return { episode, duplicate: false };
  }

  /** Only ever executed while holding the group's lock. */
  private async processLocked(episode: EpisodicNode): Promise<IngestResult> {
    try {
      const outcome = await new EpisodeRun(this.store, this.llm, this.embedder, episode).execute();
      episode.status = 'processed';
      episode.error = undefined;
      await this.store.addEpisode(episode);
      return { episode, status: 'processed', ...outcome };
    } catch (err) {
      // failure isolation: keep the raw episode (it is the most valuable thing
      // we hold), mark it failed, and report — retryFailed() picks it up later
      episode.status = 'failed';
      episode.error = ((err as Error)?.message ?? String(err)).slice(0, 500);
      await this.store.addEpisode(episode);
      return { ...emptyResult(episode), status: 'failed', failed: true, error: episode.error };
    }
  }
}

/** Legacy records (status never persisted) were processed by the old pipeline. */
function isProcessed(ep: EpisodicNode): boolean {
  return ep.status === 'processed' || ep.status === undefined;
}

function sameEpisode(e: EpisodicNode, key: string, input: EpisodeInput, validAt: Date): boolean {
  if (e.contentHash === key) return true;
  // records written before the key carried the day: bare content hash
  return (
    !input.idempotencyKey &&
    e.contentHash === contentHash(input.content) &&
    utcDay(e.validAt) === utcDay(validAt)
  );
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function emptyResult(episode: EpisodicNode): Omit<IngestResult, 'status'> {
  return {
    episode,
    entities: [],
    facts: [],
    reinforced: [],
    invalidated: [],
    dropped: { facts: 0, invalidations: 0 },
  };
}

function duplicateResult(episode: EpisodicNode): IngestResult {
  return { ...emptyResult(episode), status: 'duplicate', duplicate: true };
}

/** SCREAMING_SNAKE_CASE, so "works at" and "WORKS_AT" name the same relation. */
function normaliseRelation(relation: string | undefined): string {
  const r = (relation ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return r || 'RELATES_TO';
}

const sameRelation = (f: EntityEdge, relation: string) => normaliseRelation(f.name) === relation;

function validDate(d: unknown): Date | undefined {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : undefined;
}

/**
 * Does the text name the entity? Latin-script names must match whole words
 * ("AI" is not in "said"); scripts written without spaces (CJK) match anywhere.
 * Only Latin letters and digits continue a Latin word, so "Alice在Acme工作"
 * names both Alice and Acme.
 */
export function mentions(text: string, name: string): boolean {
  if (name.length < 2) return false;
  if (!/^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(name)) return text.includes(name);
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + name.length])) return true;
  }
  return false;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{Script=Latin}\p{M}\p{N}_]/u.test(c);

/** Does the fact's (half-open) window contain instant t? */
function covers(f: EntityEdge, t: Date): boolean {
  return (!f.validAt || f.validAt <= t) && (!f.invalidAt || t < f.invalidAt);
}

const DAY_MS = 86_400_000;

/** An empty window, or expired without any valid-time end: never true. */
function isRetracted(f: EntityEdge): boolean {
  if (f.invalidAt) return !!f.validAt && f.invalidAt <= f.validAt;
  return !!f.expiredAt;
}

/** A fact that is true now, or scheduled to become true later. */
function isLive(f: EntityEdge, now: Date): boolean {
  return isFactActive(f, now) || (!!f.validAt && f.validAt > now && isFactActive(f, f.validAt));
}

function connects(f: EntityEdge, a: EntityNode, b: EntityNode): boolean {
  return (
    (f.sourceNodeUuid === a.uuid && f.targetNodeUuid === b.uuid) ||
    (f.sourceNodeUuid === b.uuid && f.targetNodeUuid === a.uuid)
  );
}

function earliest(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Which existing facts does the provider say are ended? Accepts the index
 * list of the current contract and the boolean of the old one (true = all).
 */
function pickContradicted<T>(answer: unknown, existing: T[]): T[] {
  if (answer === true) return existing;
  if (!Array.isArray(answer)) return [];
  const picked = new Set<T>();
  for (const i of answer) {
    if (Number.isInteger(i) && i >= 0 && i < existing.length) picked.add(existing[i as number]);
  }
  return [...picked];
}

interface FactPlan {
  cand: ExtractedFact;
  src: EntityNode;
  tgt: EntityNode;
  relation: string;
  text: string;
}

/**
 * One episode's processing. Everything is resolved against working copies of
 * the affected entities and facts; the store is only written in write(), after
 * every LLM and embedding call has succeeded.
 */
class EpisodeRun {
  private readonly now = new Date();
  private readonly groupId: string;
  /** working copies by lower-case name (store-loaded ones are cloned) */
  private byName = new Map<string, EntityNode>();
  private newEntities = new Set<string>();
  private dirtyEntities = new Set<EntityNode>();
  private touched: EntityNode[] = [];
  /** working copies of every fact loaded or created, by uuid */
  private work = new Map<string, EntityEdge>();
  private loadedFor = new Set<string>();
  private created = new Set<EntityEdge>();
  private dirtyFacts = new Set<EntityEdge>();
  private reinforced: EntityEdge[] = [];
  private invalidated: EntityEdge[] = [];
  private dropped = { facts: 0, invalidations: 0 };
  private vectors = new Map<string, number[]>();

  constructor(
    private store: GraphStore,
    private llm: LLMProvider,
    private embedder: Embedder,
    private episode: EpisodicNode,
  ) {
    this.groupId = episode.groupId;
  }

  async execute(): Promise<Omit<IngestResult, 'episode' | 'status'>> {
    const extraction = await this.extract();

    const endpoints = new Set(
      (extraction.facts ?? []).flatMap((f) => [f.sourceName, f.targetName]).map((n) => (n ?? '').trim().toLowerCase()),
    );
    for (const cand of extraction.entities ?? []) await this.resolveEntity(cand, endpoints);
    const plans: FactPlan[] = [];
    for (const cand of extraction.facts ?? []) {
      const plan = await this.planFact(cand);
      if (plan) plans.push(plan);
      else this.dropped.facts++;
    }

    // every vector before any write: an embedding outage must not leave half
    // an episode in the graph
    for (const node of this.dirtyEntities) {
      if (!node.nameEmbedding?.length) node.nameEmbedding = await this.vector(node.name);
    }
    for (const plan of plans) await this.vector(plan.text);

    for (const plan of plans) await this.resolveFact(plan);
    for (const inv of extraction.invalidations ?? []) await this.applyInvalidation(inv);

    await this.repairStaleVectors();
    await this.write();
    return {
      entities: this.touched,
      facts: [...this.created],
      reinforced: this.reinforced,
      invalidated: this.invalidated,
      dropped: this.dropped,
    };
  }

  /* ---------------- extraction ---------------- */

  private async extract(): Promise<ExtractionResult> {
    const content = this.episode.content;
    const lower = content.toLowerCase();
    const all = await this.store.getEntities(this.groupId);

    // entities the text names (longest first: "Alice Chen" before "Alice")
    const mentioned = all
      .filter((e) => mentions(lower, e.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)
      .slice(0, MAX_MENTIONED_ENTITIES);
    // plus the others most similar to the text, so "she"/"the company" and
    // other spellings can still be resolved to an existing entity
    const mentionedSet = new Set(mentioned);
    const others = all.filter((e) => !mentionedSet.has(e));
    const ranked = others.length <= MAX_RANKED_ENTITIES ? others : await this.rankBySimilarity(others);
    const relevant = [...mentioned, ...ranked];

    const known: KnownEntity[] = relevant.map((e) => ({ name: e.name, summary: e.summary }));
    const knownFacts = await this.knownFacts(relevant.slice(0, MAX_FACT_ENTITIES), all);
    return this.llm.extract(
      content,
      known.map((e) => e.name),
      knownFacts,
      { referenceTime: this.episode.validAt, knownEntities: known },
    );
  }

  private async rankBySimilarity(entities: EntityNode[]): Promise<EntityNode[]> {
    const withVectors = entities.filter((e) => e.nameEmbedding?.length);
    if (withVectors.length === 0) return [];
    const q = await this.vector(this.episode.content.slice(0, RANKING_TEXT_CHARS));
    return withVectors
      .map((e) => ({ e, score: cosineSimilarity(e.nameEmbedding!, q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RANKED_ENTITIES)
      .map((r) => r.e);
  }

  /**
   * The live facts around the relevant entities, so a termination can name
   * the exact relation it closes (and the ones that depended on it) instead
   * of inventing one.
   */
  private async knownFacts(entities: EntityNode[], all: EntityNode[]): Promise<KnownFact[]> {
    const nameOf = new Map(all.map((e) => [e.uuid, e.name]));
    const seen = new Set<string>();
    const out: KnownFact[] = [];
    for (const e of entities) {
      for (const f of await this.store.getFactsForEntity(e.uuid)) {
        if (out.length >= MAX_KNOWN_FACTS) return out;
        if (seen.has(f.uuid) || !isLive(f, this.now)) continue;
        seen.add(f.uuid);
        out.push({
          sourceName: nameOf.get(f.sourceNodeUuid) ?? '',
          targetName: nameOf.get(f.targetNodeUuid) ?? '',
          relation: f.name,
          fact: f.fact,
          validAt: f.validAt,
        });
      }
    }
    return out;
  }

  /* ---------------- entities ---------------- */

  /** Working copy of an entity by name: resolved earlier, or cloned from the store. */
  private async lookup(name: string): Promise<EntityNode | undefined> {
    const key = name.trim().toLowerCase();
    if (!key) return undefined;
    const cached = this.byName.get(key);
    if (cached) return cached;
    const stored = await this.store.findEntityByName(this.groupId, name.trim());
    if (!stored) return undefined;
    const node = structuredClone(stored);
    this.byName.set(key, node);
    return node;
  }

  private async resolveEntity(cand: ExtractedEntity, factEndpoints: Set<string>): Promise<void> {
    const name = (cand.name ?? '').trim();
    if (!name) return;
    const summary = (cand.summary ?? '').trim();
    const labels = cand.labels ?? [];
    let node = await this.lookup(name);
    if (node) {
      // merge: keep node, extend labels, and only replace the summary with a
      // real one (an empty candidate summary must never erase what we know)
      const merged = [...new Set([...node.labels, ...labels])];
      const changed = merged.length !== node.labels.length || (!!summary && summary !== node.summary) || !node.nameEmbedding?.length;
      node.labels = merged;
      if (summary) node.summary = summary;
      if (changed) this.dirtyEntities.add(node);
    } else {
      // a bare name with nothing said about it and no fact attached (e.g. the
      // endpoint of an invalidation that is not in the graph) is not an entity
      if (!summary && labels.length === 0 && !factEndpoints.has(name.toLowerCase())) return;
      node = {
        type: 'entity',
        uuid: uuid(),
        groupId: this.groupId,
        name,
        labels: [...labels],
        summary,
        attributes: {},
        createdAt: this.now,
      };
      this.byName.set(name.toLowerCase(), node);
      this.newEntities.add(node.uuid);
      this.dirtyEntities.add(node);
    }
    if (!this.touched.includes(node)) this.touched.push(node);
  }

  /* ---------------- facts ---------------- */

  private async planFact(cand: ExtractedFact): Promise<FactPlan | undefined> {
    const src = await this.lookup(cand.sourceName ?? '');
    const tgt = await this.lookup(cand.targetName ?? '');
    if (!src || !tgt) return undefined;
    const relation = normaliseRelation(cand.relation);
    const text = (cand.fact ?? '').trim() || `${src.name} ${relation} ${tgt.name}`;
    return { cand, src, tgt, relation, text };
  }

  /** Working copies of every fact touching the entity (cloned from the store once). */
  private async factsOf(entity: EntityNode): Promise<EntityEdge[]> {
    if (!this.loadedFor.has(entity.uuid)) {
      this.loadedFor.add(entity.uuid);
      if (!this.newEntities.has(entity.uuid)) {
        for (const f of await this.store.getFactsForEntity(entity.uuid)) {
          if (!this.work.has(f.uuid)) this.work.set(f.uuid, structuredClone(f));
        }
      }
    }
    return [...this.work.values()].filter(
      (f) => f.sourceNodeUuid === entity.uuid || f.targetNodeUuid === entity.uuid,
    );
  }

  /**
   * The candidate's validity window, and whether its start is only the
   * episode's date (the text gave none). A window never ends before it starts:
   *   - an end at or before the episode with no start given leaves the start
   *     unknown ("worked there until 2023")
   *   - a start and end on the same instant (dates at day, month or year
   *     precision collapse) held on at least that day
   *   - an end before an explicit start is contradictory: the end is kept, so
   *     a relationship the text says is over is never taken for a current one
   */
  private window(cand: ExtractedFact): { validAt?: Date; invalidAt?: Date; datedByEpisode: boolean } {
    const start = validDate(cand.validAt);
    const end = validDate(cand.invalidAt);
    if (!start) {
      if (end && end <= this.episode.validAt) return { invalidAt: end, datedByEpisode: false };
      return { validAt: this.episode.validAt, invalidAt: end, datedByEpisode: true };
    }
    if (end && end.getTime() === start.getTime()) {
      return { validAt: start, invalidAt: new Date(start.getTime() + DAY_MS), datedByEpisode: false };
    }
    if (end && end < start) return { invalidAt: end, datedByEpisode: false };
    return { validAt: start, invalidAt: end, datedByEpisode: false };
  }

  private async resolveFact(plan: FactPlan): Promise<void> {
    const { src, tgt, relation, text } = plan;
    const { validAt, invalidAt, datedByEpisode } = this.window(plan.cand);
    const vec = this.vectors.get(text)!;
    // the instant this statement speaks about
    const t = validAt ?? new Date(invalidAt!.getTime() - 1);

    const pool = await this.factsOf(src);
    const sameSlot = (f: EntityEdge) => f.sourceNodeUuid === src.uuid && sameRelation(f, relation);
    // every record of this (source, relation, target), active or historical
    const records = pool.filter((f) => sameSlot(f) && f.targetNodeUuid === tgt.uuid && !isRetracted(f));
    // the same statement: identical text, or a close paraphrase
    const isSame = (f: EntityEdge) =>
      f.fact === text || (!!f.factEmbedding?.length && cosineSimilarity(f.factEmbedding, vec) >= PARAPHRASE_COSINE);
    // does the record hold at t? A statement dated only by its episode, made
    // on the day the relationship ended, still describes that relationship
    const holds = (f: EntityEdge) =>
      covers(f, t) || (datedByEpisode && !!f.invalidAt && f.invalidAt.getTime() === t.getTime());

    // a. the same statement over t just gains this episode as evidence — this
    //    is what keeps an older, backfilled document from resurrecting a
    //    relation that has since ended
    const covering = records.find((f) => isSame(f) && holds(f));
    if (covering) return this.reinforce(covering, invalidAt, text);

    // the nearest later record of this relationship
    const later = validAt
      ? records
          .filter((f) => f.validAt && f.validAt > validAt)
          .sort((a, b) => a.validAt!.getTime() - b.validAt!.getTime())[0]
      : undefined;
    if (later && validAt && isSame(later) && !(invalidAt && invalidAt < later.validAt!)) {
      // evidence that `later` really began at its validAt: something in the
      // same slot ended in between (a transition)
      const transition = pool.some(
        (f) => f !== later && sameSlot(f) && !!f.invalidAt && f.invalidAt > validAt && f.invalidAt <= later.validAt!,
      );
      if (!transition) {
        // the candidate is earlier evidence for the same relationship
        later.validAt = validAt;
        return this.reinforce(later, invalidAt, text);
      }
    }

    // a new edge; an earlier stint must not overlap the later record
    let end = earliest(invalidAt, later?.validAt);

    // records of this relationship over t that say something else ("Bob is a
    // senior developer at Initech" vs "Bob works at Initech"). They are
    // contradiction candidates below, except one that ended exactly at t: it
    // is over already, so this statement can only be more evidence for it.
    const restated = records.filter((f) => !this.created.has(f) && !isSame(f) && holds(f));

    // b. contradictions: the facts between the same pair, plus the facts in
    //    the same slot with another target (functional attributes such as
    //    WORKS_AT, HAS_ROLE, LIVES_IN change target, not endpoints), that are
    //    live now or held at validAt (a backfilled statement can replace a
    //    value that has since ended). A statement with an unknown start
    //    cannot end anything.
    let ended: EntityEdge[] = [];
    if (validAt) {
      const candidates = pool.filter(
        (f) =>
          !this.created.has(f) &&
          !isRetracted(f) &&
          !(records.includes(f) && isSame(f)) &&
          (isLive(f, this.now) || covers(f, validAt)) &&
          (connects(f, src, tgt) || (sameSlot(f) && f.targetNodeUuid !== tgt.uuid)),
      );
      if (candidates.length > 0) {
        const answer: unknown = await this.llm.detectContradiction(
          { sourceName: src.name, targetName: tgt.name, fact: text, relation, validAt },
          candidates.map((f) => ({ fact: f.fact, validAt: f.validAt, invalidAt: f.invalidAt })),
        );
        ended = pickContradicted(answer, candidates);
      }
    }

    // a record of this relationship that the statement does not end is the
    // same relationship described differently: it gains the evidence (and an
    // end the text states) instead of a second edge. For a record that has
    // ended, a new open edge would bring the relation back.
    const same = restated.find((f) => !ended.includes(f) && (f.invalidAt || invalidAt));
    if (same) return this.reinforce(same, invalidAt, text);

    // (`ended` is only filled when validAt is known)
    for (const old of ended) {
      if (old.validAt && old.validAt > validAt!) {
        // an older statement cannot end a newer fact: it ends where that one begins
        end = earliest(end, old.validAt);
        continue;
      }
      const at = this.endFor(old, validAt!);
      if (!at) continue;
      // the new fact takes over from the old one, so it cannot outlive the
      // old one's known end either
      end = earliest(end, old.invalidAt);
      this.close(old, at, `superseded by: ${text}`);
    }

    const edge: EntityEdge = {
      type: 'fact',
      uuid: uuid(),
      groupId: this.groupId,
      sourceNodeUuid: src.uuid,
      targetNodeUuid: tgt.uuid,
      name: relation,
      fact: text,
      factEmbedding: vec,
      episodes: [this.episode.uuid],
      validAt,
      invalidAt: end,
      createdAt: this.now,
      attributes: {},
    };
    this.work.set(edge.uuid, edge);
    this.created.add(edge);
  }

  /** Record this episode as evidence; an end stated by the text closes an open edge. */
  private reinforce(edge: EntityEdge, end: Date | undefined, text: string): void {
    if (!this.created.has(edge)) {
      if (!edge.episodes.includes(this.episode.uuid)) edge.episodes = [...edge.episodes, this.episode.uuid];
      this.dirtyFacts.add(edge);
      if (!this.reinforced.includes(edge)) this.reinforced.push(edge);
    }
    if (end && !edge.invalidAt && (!edge.validAt || end > edge.validAt)) {
      this.close(edge, end, `ended per: ${text}`);
    }
  }

  /**
   * Where a change dated `at` ends fact f, or undefined when it cannot: f
   * started after `at` (an older statement cannot end a newer fact) or had
   * already ended by then. When f starts exactly at `at` — coarse dates
   * collide: "March 2024" is 2024-03-01 for both the old and the new value — it
   * ends when this episode was written (the change had happened by then), or
   * failing that right after its start, so it keeps a non-empty window and
   * stays in history instead of vanishing.
   */
  private endFor(f: EntityEdge, at: Date): Date | undefined {
    if (f.invalidAt && f.invalidAt <= at) return undefined;
    if (!f.validAt || f.validAt < at) return at;
    if (f.validAt > at) return undefined;
    const written = this.episode.validAt;
    const end = written > f.validAt ? written : new Date(f.validAt.getTime() + 1);
    return f.invalidAt && f.invalidAt <= end ? undefined : end;
  }

  /**
   * End a fact at `at` (real-world time; never the wall clock). Callers make
   * sure the window stays non-empty (see endFor). A fact created by this same
   * episode simply carries its end; an existing one is also expired now.
   */
  private close(f: EntityEdge, at: Date, reason: string): void {
    f.invalidAt = at;
    if (this.created.has(f)) return;
    f.expiredAt = this.now;
    f.attributes = { ...f.attributes, invalidatedBy: reason.slice(0, 120) };
    this.dirtyFacts.add(f);
    if (!this.invalidated.includes(f)) this.invalidated.push(f);
  }

  /**
   * c. explicit invalidation: close existing relations WITHOUT creating a
   * redundant "LEFT/QUIT/ENDED" edge (the fix for termination modeling).
   */
  private async applyInvalidation(inv: ExtractedInvalidation): Promise<void> {
    const src = await this.lookup(inv.sourceName ?? '');
    const tgt = await this.lookup(inv.targetName ?? '');
    if (!src || !tgt) {
      this.dropped.invalidations++;
      return;
    }
    const end = validDate(inv.invalidAt) ?? this.episode.validAt;
    // when the LLM named a relation, prefer it; otherwise close all relations
    // between this pair (a plain "they parted ways" statement)
    const relation = inv.relation ? normaliseRelation(inv.relation) : undefined;
    for (const f of await this.factsOf(src)) {
      if (!connects(f, src, tgt) || (relation && !sameRelation(f, relation)) || isRetracted(f)) continue;
      // an edge this text just introduced ends only if it began strictly before
      if (this.created.has(f) && !(f.validAt && f.validAt < end)) continue;
      // only a fact that was still true at `end` can end there: an older
      // episode cannot end a newer fact, and an earlier end is kept
      const at = this.endFor(f, end);
      if (at) this.close(f, at, inv.reason ?? this.episode.content.slice(0, 120));
    }
  }

  /* ---------------- embeddings & writes ---------------- */

  private async vector(text: string): Promise<number[]> {
    let v = this.vectors.get(text);
    if (!v) {
      v = await this.embedder.embed(text);
      if (!v?.length) throw new Error('embedder returned an empty vector');
      this.vectors.set(text, v);
    }
    return v;
  }

  /**
   * Records written under another embedding model (or by the old hash
   * fallback) carry vectors of another length, which the store would reject
   * halfway through the writes, on this and every retry. Whatever this episode
   * rewrites is re-embedded with the current model instead, which also
   * repairs the index one record at a time.
   */
  private async repairStaleVectors(): Promise<void> {
    const dims = this.store.embeddingDims ?? this.vectors.values().next().value?.length;
    if (!dims) return;
    for (const node of this.dirtyEntities) {
      if (node.nameEmbedding?.length && node.nameEmbedding.length !== dims) {
        node.nameEmbedding = await this.vector(node.name);
      }
    }
    for (const f of this.dirtyFacts) {
      if (f.factEmbedding?.length && f.factEmbedding.length !== dims) f.factEmbedding = await this.vector(f.fact);
    }
  }

  private async write(): Promise<void> {
    // a wrong-length vector would be rejected halfway through the writes;
    // refuse the whole episode up front instead
    const outgoing = [
      ...[...this.dirtyEntities].map((n) => n.nameEmbedding),
      ...[...this.created, ...this.dirtyFacts].map((f) => f.factEmbedding),
    ];
    let dims = this.store.embeddingDims;
    for (const v of outgoing) {
      if (!v?.length) continue;
      dims ??= v.length;
      if (v.length !== dims) {
        throw new Error(
          `embedding dimension mismatch: store expects ${dims}, got ${v.length}. ` +
            `Changing the embedding model requires re-indexing (see README).`,
        );
      }
    }

    for (const node of this.dirtyEntities) await this.store.upsertEntity(node);
    for (const edge of this.created) await this.store.addFact(edge);
    for (const edge of this.dirtyFacts) await this.store.updateFact(edge);
  }
}
