/**
 * The operations behind every MCP tool and REST endpoint.
 *
 * Both transports are thin: they validate input with the shapes below, call
 * one method here and format the plain-JSON result (snake_case, ISO dates).
 * Every method takes the caller's Principal and resolves the memory group
 * through auth.resolveGroup(), so no endpoint can forget the tenant check.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Minizep } from '../index.js';
import type { EntityEdge, EntityNode, EpisodicNode, FactState, FactWithContext } from '../model/types.js';
import { factView, isFactActive } from '../model/types.js';
import { displayTimeZone } from '../util/time.js';
import { InvalidationError, type EpisodeInput, type IngestResult } from '../pipeline/ingest.js';
import type { Job, JobQueue } from '../jobs/queue.js';
import { permits, resolveGroup, type Principal } from './auth.js';

/** A request that cannot be served, with the HTTP status that says why. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the service needs from FilePersistence (a database store makes it a no-op). */
export interface SnapshotWriter {
  schedule(zep: Minizep): void;
  save(zep: Minizep): Promise<void>;
  flush(zep: Minizep): Promise<void>;
}

export interface ServiceOptions {
  zep: Minizep;
  jobs: JobQueue;
  persistence?: SnapshotWriter;
  llmLabel?: string;
  storeLabel?: string;
  /**
   * The background retry gives a failed episode up after this many attempts
   * (default 3); retry_failed still takes it.
   */
  retryMax?: number;
}

/** Failed episodes one background retry pass takes at most. */
const RETRY_BATCH = 5;

/** The methodology the memory_guide tool and GET /v1/guide return; resolves from src/server and dist/server alike. */
const GUIDE = new URL('../../docs/MEMORY-GUIDE.md', import.meta.url);

/* ---------------- result rows ---------------- */

export interface FactRow {
  uuid: string;
  relation: string;
  source: string;
  target: string;
  source_uuid: string;
  target_uuid: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
  /** episodes this fact was extracted from, oldest first */
  episodes: string[];
  /** fused retrieval score, on search results only */
  score: number | null;
  /** why the fact was ended or retracted (attributes.invalidatedBy) */
  reason: string | null;
}

/** A fact as the graph shows it at one (at, as_of) instant. */
export interface GraphEdge extends Omit<FactRow, 'score'> {
  state: FactState;
  /** invalid_at as it was known at as_of (null: no end known then) */
  ends_at: string | null;
  /** a correction made after as_of exists (expired_at > as_of) */
  revised_later: boolean;
}

export interface GraphNode extends EntityRow {
  /** the first label that is not "Entity", else "Entity" */
  label: string;
  /** number of returned edges touching this node */
  degree: number;
}

export interface EntityRow {
  uuid: string;
  name: string;
  labels: string[];
  summary: string;
  created_at: string;
}

export interface EpisodeRow {
  uuid: string;
  group_id: string;
  name: string;
  source: string;
  source_description: string;
  content: string;
  valid_at: string;
  created_at: string;
  /** records written before statuses were persisted count as processed */
  status: 'pending' | 'processed' | 'failed' | 'forgotten';
  /** why it failed, or why it was forgotten */
  error: string | null;
  /** processing attempts so far (retries included) */
  attempts: number;
}

export interface JobRow {
  id: string;
  status: Job['status'];
  label: string;
  group_id: string | null;
  episode_uuid: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result: unknown;
}

export interface AddMemoryOutcome {
  /** 'queued': async mode, the episode is stored as pending and a job will process it */
  status: 'processed' | 'failed' | 'duplicate' | 'queued';
  group_id: string;
  episode_uuid: string;
  job_id: string | null;
  error: string | null;
  entities: string[];
  facts: FactRow[];
  reinforced: FactRow[];
  invalidated: FactRow[];
  /**
   * extracted candidates discarded: entities that are only a literal value with
   * no fact on them, facts and invalidations naming an unresolvable entity
   */
  dropped: { entities: number; facts: number; invalidations: number };
}

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

export function factRow(r: FactWithContext): FactRow {
  const f = r.fact;
  return {
    uuid: f.uuid,
    relation: f.name,
    source: r.sourceName,
    target: r.targetName,
    source_uuid: f.sourceNodeUuid,
    target_uuid: f.targetNodeUuid,
    fact: f.fact,
    valid_at: iso(f.validAt),
    invalid_at: iso(f.invalidAt),
    created_at: f.createdAt.toISOString(),
    expired_at: iso(f.expiredAt),
    episodes: [...f.episodes],
    score: r.score ?? null,
    reason: typeof f.attributes?.invalidatedBy === 'string' ? f.attributes.invalidatedBy : null,
  };
}

/** The fact row plus its state at (at, asOf); undefined when it was not known at asOf. */
function graphEdge(r: FactWithContext, at: Date, asOf: Date): GraphEdge | undefined {
  const view = factView(r.fact, at, asOf);
  if (!view) return undefined;
  const { score: _score, ...row } = factRow(r);
  return { ...row, state: view.state, ends_at: iso(view.endsAt), revised_later: view.revisedLater };
}

/** The first label that is not the generic "Entity" (the graph colours by it). */
function primaryLabel(labels: readonly string[]): string {
  return labels.find((l) => l !== 'Entity') ?? 'Entity';
}

const STATE_ORDER: Record<FactState, number> = { active: 0, future: 1, ended: 2, retracted: 3 };

/** Plain code-unit order (ISO timestamps sort chronologically this way). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** At most `n` items spread evenly over the sorted list, keeping its first and last. */
function spread<T>(sorted: T[], n: number): T[] {
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
}

/** Distinct instants as sorted ISO strings. */
function instants(dates: (Date | undefined)[]): string[] {
  return [...new Set(dates.filter((d): d is Date => !!d).map((d) => d.getTime()))]
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms).toISOString());
}

function entityRow(e: EntityNode): EntityRow {
  return { uuid: e.uuid, name: e.name, labels: e.labels, summary: e.summary, created_at: e.createdAt.toISOString() };
}

function episodeRow(e: EpisodicNode): EpisodeRow {
  return {
    uuid: e.uuid,
    group_id: e.groupId,
    name: e.name,
    source: e.source,
    source_description: e.sourceDescription,
    content: e.content,
    valid_at: e.validAt.toISOString(),
    created_at: e.createdAt.toISOString(),
    status: e.status ?? 'processed',
    error: e.error ?? null,
    attempts: e.attempts ?? 0,
  };
}

function jobRow(j: Job): JobRow {
  return {
    id: j.id,
    status: j.status,
    label: j.label,
    group_id: j.group ?? null,
    episode_uuid: j.ref ?? null,
    created_at: j.createdAt.toISOString(),
    started_at: iso(j.startedAt),
    finished_at: iso(j.finishedAt),
    error: j.error ?? null,
    result: j.result ?? null,
  };
}

/* ---------------- input shapes (shared by MCP tools and REST) ---------------- */

const groupId = z.string().optional().describe("Memory namespace (default: the token's default group)");
const instant = (what: string) => z.string().optional().describe(`ISO-8601 instant: ${what}`);
const asOf = instant('what the graph knew at that time (knowledge time, default now)');

export const shapes = {
  addMemory: {
    content: z.string().min(1).describe('The text to remember (a message, note, or document excerpt)'),
    group_id: groupId,
    valid_at: instant('when this happened in the real world (defaults to now)'),
    source: z.enum(['text', 'json', 'markdown']).optional(),
    name: z.string().optional().describe('Short label for this episode'),
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Caller-chosen key: a resend with the same key is a duplicate, whatever its content'),
    async: z
      .boolean()
      .optional()
      .describe(
        'Store the episode and return a job id immediately instead of waiting. ' +
          'Extraction takes seconds; use this for long documents or bulk ingestion, ' +
          'then poll memory_job_status.',
      ),
  },
  search: {
    query: z.string().min(1),
    group_id: groupId,
    limit: z.number().int().min(1).max(50).optional(),
    at: instant('return only facts true at that time'),
    as_of: asOf,
    include_historical: z.boolean().optional().describe('Include facts that are no longer true'),
  },
  factsAbout: {
    entity: z.string().min(1).describe('Entity name, e.g. "Alice" (partial names are resolved)'),
    group_id: groupId,
    at: instant('return only facts true at that time'),
    as_of: asOf,
    include_historical: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  factsAt: {
    at: instant('the valid time to look at (default now)'),
    as_of: asOf,
    group_id: groupId,
    limit: z.number().int().min(1).max(1000).optional().describe('Maximum facts returned (default 100)'),
  },
  entities: {
    query: z.string().optional().describe('Substring of the name or summary'),
    group_id: groupId,
    limit: z.number().int().min(1).max(200).optional(),
  },
  episodes: {
    group_id: groupId,
    limit: z.number().int().min(1).max(100).optional(),
  },
  episode: {
    id: z.string().min(1).describe('Episode uuid, or a prefix of at least 8 characters'),
    group_id: groupId,
  },
  invalidateFact: {
    uuid: z.string().min(1).describe('Fact uuid, or a prefix of at least 8 characters'),
    reason: z.string().min(1).describe('Why the fact no longer holds (kept for auditing)'),
    at: instant('when it stopped being true (default now)'),
    retract: z.boolean().optional().describe('The fact was never true: remove it from every point in time'),
    group_id: groupId,
  },
  reopenFact: {
    uuid: z.string().min(1).describe('Fact uuid, or a prefix of at least 8 characters'),
    reason: z.string().min(1).describe('Why the fact still holds (kept for auditing)'),
    invalid_at: instant('when it really stopped being true, if it did (default: still true)'),
    group_id: groupId,
  },
  forgetEpisode: {
    id: z.string().min(1).describe('Episode uuid, or a prefix of at least 8 characters'),
    reason: z.string().min(1).describe('Why the note is wrong or not wanted (kept for auditing)'),
    group_id: groupId,
  },
  group: {
    group_id: groupId,
  },
  graph: {
    group_id: groupId,
    at: instant('the valid time to look at (default now)'),
    as_of: asOf,
    history: z.boolean().optional().describe('Also facts that are not active at `at`, each with its state'),
    isolated: z
      .boolean()
      .optional()
      .describe('Also entities known at `as_of` that no returned fact touches, newest first, up to `limit` nodes in all'),
    limit: z.number().int().min(1).max(2000).optional().describe('Maximum facts returned (default 500)'),
  },
  entity: {
    id: z.string().min(1).describe('Entity uuid, or a prefix of at least 8 characters'),
    group_id: groupId,
    at: instant('the valid time the fact states refer to (default now)'),
    as_of: asOf,
  },
};

type Input<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
export type AddMemoryInput = Input<typeof shapes.addMemory>;
export type SearchInput = Input<typeof shapes.search>;
export type FactsAboutInput = Input<typeof shapes.factsAbout>;
export type FactsAtInput = Input<typeof shapes.factsAt>;
export type EntitiesInput = Input<typeof shapes.entities>;
export type EpisodesInput = Input<typeof shapes.episodes>;
export type EpisodeInputShape = Input<typeof shapes.episode>;
export type InvalidateFactInputShape = Input<typeof shapes.invalidateFact>;
export type ReopenFactInputShape = Input<typeof shapes.reopenFact>;
export type ForgetEpisodeInputShape = Input<typeof shapes.forgetEpisode>;
export type GroupInput = Input<typeof shapes.group>;
export type GraphInput = Input<typeof shapes.graph>;
export type EntityInput = Input<typeof shapes.entity>;

/** An ISO-8601 instant from a request, or undefined when absent. */
function parseInstant(value: string | undefined, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ServiceError(400, `invalid ${field}: expected an ISO-8601 timestamp`);
  return d;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_PREFIX = 8;

/** The one record whose uuid is `id` or starts with it (at least 8 characters). */
function pickByPrefix<T extends { uuid: string }>(rows: T[], id: string, what: string): T {
  const matches = rows.filter((r) => r.uuid.startsWith(id));
  if (matches.length === 0) throw new ServiceError(404, `${what} not found`);
  if (matches.length > 1) {
    throw new ServiceError(400, `ambiguous ${what} id: ${matches.length} match "${id}", give more characters`);
  }
  return matches[0];
}

function normaliseId(raw: string, what: string): string {
  const id = raw.trim().toLowerCase();
  if (id.length < MIN_PREFIX) {
    throw new ServiceError(400, `${what} id must be a uuid or a prefix of at least ${MIN_PREFIX} characters`);
  }
  return id;
}

/* ---------------- the service ---------------- */

export class MemoryService {
  readonly zep: Minizep;
  readonly jobs: JobQueue;
  readonly llmLabel: string;
  readonly storeLabel: string;
  readonly retryMax: number;
  private readonly persistence?: SnapshotWriter;
  /** synchronous ingestions in progress: shutdown waits for them like for jobs */
  private readonly inflight = new Set<Promise<unknown>>();
  /** a background retry pass is running (the next tick skips instead of piling up) */
  private sweeping = false;

  constructor(opts: ServiceOptions) {
    this.zep = opts.zep;
    this.jobs = opts.jobs;
    this.persistence = opts.persistence;
    this.llmLabel = opts.llmLabel ?? 'unknown';
    this.storeLabel = opts.storeLabel ?? 'unknown';
    this.retryMax = opts.retryMax ?? 3;
  }

  /* ---------- ingestion ---------- */

  async addMemory(p: Principal, input: AddMemoryInput): Promise<AddMemoryOutcome> {
    const group = resolveGroup(p, input.group_id);
    const episodeInput: EpisodeInput = {
      groupId: group,
      content: input.content,
      source: input.source,
      name: input.name,
      validAt: parseInstant(input.valid_at, 'valid_at'),
      idempotencyKey: input.idempotency_key,
    };

    if (!input.async) {
      const result = await this.track(this.zep.ingest.addEpisode(episodeInput));
      this.persistence?.schedule(this.zep);
      return this.outcome(group, result);
    }

    // durable before the job id is handed out: the episode is stored as
    // pending (and snapshotted), so a crash or shutdown cannot lose it
    const { episode, duplicate } = await this.track(this.zep.ingest.saveEpisode(episodeInput));
    if (duplicate) return this.outcome(group, { ...emptyResult(episode), status: 'duplicate', duplicate: true });
    const job = this.enqueue(episode, 'add_memory');
    await this.persistence?.save(this.zep);
    return { ...(await this.outcome(group, emptyResult(episode))), status: 'queued', job_id: job.id };
  }

  /**
   * Re-enqueue the episodes a previous process saved but never processed.
   * Legacy records without a status count as processed and are left alone.
   */
  async recoverPending(): Promise<number> {
    const pending = await this.zep.ingest.recoverPending();
    for (const ep of pending) this.enqueue(ep, 'recover');
    return pending.length;
  }

  async retryFailed(p: Principal, input: GroupInput) {
    const group = resolveGroup(p, input.group_id);
    const r = await this.track(this.zep.ingest.retryFailed(group));
    this.persistence?.schedule(this.zep);
    return { group_id: group, retried: r.retried, succeeded: r.succeeded, still_failing: r.stillFailing };
  }

  /**
   * One pass of the background retry, over every group: the oldest failed
   * episodes tried fewer than `retryMax` times, at most `batch` of them, each
   * through the group's lock like any processing. A pass while another is
   * still running does nothing.
   */
  async retrySweep(batch = RETRY_BATCH): Promise<{ retried: number; succeeded: number; still_failing: number }> {
    if (this.sweeping) return { retried: 0, succeeded: 0, still_failing: 0 };
    this.sweeping = true;
    try {
      const r = await this.track(this.zep.ingest.retryFailed(undefined, { maxAttempts: this.retryMax, limit: batch }));
      if (r.retried) this.persistence?.schedule(this.zep);
      return { retried: r.retried, succeeded: r.succeeded, still_failing: r.stillFailing };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Run retrySweep every `everyMs` (0: never) until the returned function is
   * called. The timer does not keep the process alive; a pass in progress is
   * waited for by drain() like any ingestion.
   */
  retryEvery(everyMs: number, log: (msg: string) => void = () => undefined): () => void {
    if (everyMs <= 0) return () => undefined;
    const timer = setInterval(() => {
      this.retrySweep().then(
        (r) => {
          if (r.retried) {
            log(`retried ${r.retried} failed episode(s): ${r.succeeded} succeeded, ${r.still_failing} still failing`);
          }
        },
        (err) => log(`background retry failed: ${(err as Error)?.message ?? err}`),
      );
    }, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** A job processing a saved episode; a failed extraction fails the job. */
  private enqueue(episode: EpisodicNode, label: string): Job {
    const group = episode.groupId;
    return this.jobs.submit(
      `${label}:${group}`,
      async () => {
        try {
          const r = await this.zep.ingest.processEpisode(episode.uuid);
          if (r.status === 'failed') {
            throw new Error(`extraction failed: ${r.error ?? 'unknown error'} (episode stored for retry)`);
          }
          if (r.episode.status === 'forgotten') throw new Error('the episode was forgotten before it was processed');
          return await this.outcome(group, r);
        } finally {
          this.persistence?.schedule(this.zep);
        }
      },
      { group, ref: episode.uuid },
    );
  }

  job(p: Principal, rawId: string): JobRow {
    const id = rawId.trim().toLowerCase();
    const exact = this.jobs.get(id);
    if (exact && this.canSee(p, exact)) return jobRow(exact);
    if (id.length >= MIN_PREFIX) {
      const matches = this.jobs.list(Infinity, (j) => j.id.startsWith(id) && this.canSee(p, j));
      if (matches.length === 1) return jobRow(matches[0]);
    }
    // someone else's job is indistinguishable from a missing one
    throw new ServiceError(404, 'job not found');
  }

  listJobs(p: Principal, limit = 20): JobRow[] {
    return this.jobs.list(limit, (j) => this.canSee(p, j)).map(jobRow);
  }

  private canSee(p: Principal, job: Job): boolean {
    return job.group === undefined ? p.groups === 'any' : permits(p, job.group);
  }

  /* ---------- queries ---------- */

  async search(p: Principal, input: SearchInput) {
    const group = resolveGroup(p, input.group_id);
    const { results, degraded } = await this.zep.searchFactsDetailed(input.query, {
      groupId: group,
      limit: input.limit ?? 10,
      at: parseInstant(input.at, 'at'),
      asOf: parseInstant(input.as_of, 'as_of'),
      includeHistorical: input.include_historical ?? false,
    });
    return { group_id: group, degraded, facts: results.map(factRow) };
  }

  async factsAbout(p: Principal, input: FactsAboutInput) {
    const group = resolveGroup(p, input.group_id);
    const r = await this.zep.factsAboutDetailed(input.entity, {
      groupId: group,
      at: parseInstant(input.at, 'at'),
      asOf: parseInstant(input.as_of, 'as_of'),
      includeHistorical: input.include_historical ?? false,
      limit: input.limit ?? 50,
    });
    return {
      group_id: group,
      entity: r.entity ? entityRow(r.entity) : null,
      facts: r.facts.map(factRow),
      candidates: r.candidates.map(entityRow),
    };
  }

  async factsAt(p: Principal, input: FactsAtInput) {
    const group = resolveGroup(p, input.group_id);
    const at = parseInstant(input.at, 'at') ?? new Date();
    const rows = await this.zep.factsAt(at, group, {
      asOf: parseInstant(input.as_of, 'as_of'),
      limit: input.limit ?? 100,
    });
    return { group_id: group, at: at.toISOString(), facts: rows.map(factRow) };
  }

  async entities(p: Principal, input: EntitiesInput) {
    const group = resolveGroup(p, input.group_id);
    const q = input.query?.toLowerCase();
    const rows = (await this.zep.store.getEntities(group))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
      .slice(0, input.limit ?? 50);
    return { group_id: group, entities: rows.map(entityRow) };
  }

  async episodes(p: Principal, input: EpisodesInput) {
    const group = resolveGroup(p, input.group_id);
    const rows = (await this.zep.store.getEpisodes(group))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 20);
    return { group_id: group, episodes: rows.map(episodeRow) };
  }

  /** One episode with the facts it produced (first evidence) and reinforced. */
  async episode(p: Principal, input: EpisodeInputShape) {
    const group = resolveGroup(p, input.group_id);
    const episode = await this.findEpisode(group, input.id);
    const mine = (await this.zep.store.getFacts(group)).filter((f) => f.episodes.includes(episode.uuid));
    const rows = await this.withNames(mine);
    return {
      episode: episodeRow(episode),
      facts: rows.filter((r) => r.episodes[0] === episode.uuid),
      reinforced: rows.filter((r) => r.episodes[0] !== episode.uuid),
    };
  }

  async invalidateFact(p: Principal, input: InvalidateFactInputShape) {
    const group = resolveGroup(p, input.group_id);
    const id = normaliseId(input.uuid, 'fact');
    const at = parseInstant(input.at, 'at');
    const uuid = UUID_RE.test(id) ? id : pickByPrefix(await this.zep.store.getFacts(group), id, 'fact').uuid;
    try {
      const fact = await this.zep.ingest.invalidateFact(uuid, {
        groupId: group,
        at,
        reason: input.reason,
        retract: input.retract ?? false,
      });
      this.persistence?.schedule(this.zep);
      return { group_id: group, fact: (await this.withNames([fact]))[0] };
    } catch (err) {
      throw asServiceError(err);
    }
  }

  /**
   * Undo a wrong end or retraction: the old record is retracted and kept in
   * history, and the returned `fact` is its corrected copy (a new uuid).
   */
  async reopenFact(p: Principal, input: ReopenFactInputShape) {
    const group = resolveGroup(p, input.group_id);
    const id = normaliseId(input.uuid, 'fact');
    const invalidAt = parseInstant(input.invalid_at, 'invalid_at');
    const uuid = UUID_RE.test(id) ? id : pickByPrefix(await this.zep.store.getFacts(group), id, 'fact').uuid;
    try {
      const r = await this.zep.ingest.reopenFact(uuid, { groupId: group, reason: input.reason, invalidAt });
      this.persistence?.schedule(this.zep);
      const [fact, previous] = await this.withNames([r.fact, r.previous]);
      return { group_id: group, fact, previous };
    } catch (err) {
      throw asServiceError(err);
    }
  }

  /**
   * Take back what one episode contributed (see IngestPipeline.forgetEpisode):
   * the facts only it supported are retracted, the others lose it as
   * evidence, the facts it closed are reopened unless a later value still
   * holds, the summaries it wrote last are put back, and it becomes
   * 'forgotten'.
   */
  async forgetEpisode(p: Principal, input: ForgetEpisodeInputShape) {
    const group = resolveGroup(p, input.group_id);
    const episode = await this.findEpisode(group, input.id);
    try {
      const r = await this.zep.ingest.forgetEpisode(episode.uuid, { groupId: group, reason: input.reason });
      this.persistence?.schedule(this.zep);
      const [retracted, unlinked, stillClosed, unmarked, copies, previous] = await Promise.all(
        [
          r.retracted,
          r.unlinked,
          r.stillClosed,
          r.unmarked,
          r.reopened.map((x) => x.fact),
          r.reopened.map((x) => x.previous),
        ].map((edges) => this.withNames(edges)),
      );
      return {
        group_id: group,
        episode: episodeRow(r.episode),
        retracted,
        unlinked,
        reopened: copies.map((fact, i) => ({ fact, previous: previous[i] })),
        still_closed: stillClosed,
        unmarked_closures: unmarked,
        restored_summaries: r.summaries.map(entityRow),
        orphaned_entities: r.orphaned.map(entityRow),
      };
    } catch (err) {
      throw asServiceError(err);
    }
  }

  /** docs/MEMORY-GUIDE.md, read on every call (edits need no restart). */
  async guide(): Promise<string> {
    try {
      return await readFile(GUIDE, 'utf8');
    } catch {
      throw new ServiceError(404, 'the memory guide is not installed (docs/MEMORY-GUIDE.md is missing)');
    }
  }

  async stats(p: Principal, input: GroupInput) {
    const group = resolveGroup(p, input.group_id);
    const [episodes, entities, facts] = await Promise.all([
      this.zep.store.getEpisodes(group),
      this.zep.store.getEntities(group),
      this.zep.store.getFacts(group),
    ]);
    const now = new Date();
    const active = facts.filter((f) => isFactActive(f, now)).length;
    const byStatus = (s: EpisodeRow['status']) => episodes.filter((e) => (e.status ?? 'processed') === s).length;
    return {
      group_id: group,
      episodes: {
        total: episodes.length,
        pending: byStatus('pending'),
        processed: byStatus('processed'),
        failed: byStatus('failed'),
        given_up: this.givenUp(episodes),
        forgotten: byStatus('forgotten'),
      },
      entities: entities.length,
      facts: { total: facts.length, active, historical: facts.length - active },
      // scoped to the group: a token must not learn how busy other tenants are
      jobs: this.jobs.statsFor((j) => j.group === group),
    };
  }

  /**
   * Nodes and edges of one group at one bi-temporal instant, for the graph
   * view. Without `history` only active facts are returned; with it, every
   * fact known at `as_of`, each with its state. `labels` and `timeline` cover
   * the whole group, so colours and time ticks stay put while time moves.
   */
  async graph(p: Principal, input: GraphInput) {
    const group = resolveGroup(p, input.group_id);
    const at = parseInstant(input.at, 'at') ?? new Date();
    const asOf = parseInstant(input.as_of, 'as_of') ?? new Date();
    const history = input.history ?? false;
    const limit = input.limit ?? 500;
    const [facts, entities] = await Promise.all([this.zep.store.getFacts(group), this.zep.store.getEntities(group)]);
    const byId = new Map(entities.map((e) => [e.uuid, e]));

    let edges: GraphEdge[] = [];
    for (const f of facts) {
      const source = byId.get(f.sourceNodeUuid);
      const target = byId.get(f.targetNodeUuid);
      if (!source || !target) continue; // not drawable
      const edge = graphEdge({ fact: f, sourceName: source.name, targetName: target.name }, at, asOf);
      if (edge && (history || edge.state === 'active')) edges.push(edge);
    }
    // active first, then the most recently learned
    edges.sort(
      (a, b) =>
        Number(b.state === 'active') - Number(a.state === 'active') || cmp(b.created_at, a.created_at),
    );
    const edgesTruncated = edges.length > limit;
    if (edgesTruncated) edges = edges.slice(0, limit);

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source_uuid, (degree.get(e.source_uuid) ?? 0) + 1);
      degree.set(e.target_uuid, (degree.get(e.target_uuid) ?? 0) + 1);
    }
    // isolated entities only fill the room `limit` leaves in the node count,
    // most recently learned first: a group of thousands of entities must not
    // become thousands of nodes
    const isolated =
      input.isolated === true ? entities.filter((e) => !degree.has(e.uuid) && e.createdAt <= asOf) : [];
    const room = Math.max(0, limit - degree.size);
    const keep = new Set(
      isolated
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, room)
        .map((e) => e.uuid),
    );
    const truncated = edgesTruncated || isolated.length > keep.size;
    const shown = entities.filter((e) => degree.has(e.uuid) || keep.has(e.uuid));
    const nodes: GraphNode[] = shown.map((e) => ({
      ...entityRow(e),
      label: primaryLabel(e.labels),
      degree: degree.get(e.uuid) ?? 0,
    }));

    const labelCounts = new Map<string, number>();
    for (const e of entities) {
      const label = primaryLabel(e.labels);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const labels = [...labelCounts]
      .sort(([a], [b]) => Number(b === 'Entity') - Number(a === 'Entity') || cmp(a, b))
      .map(([label, count]) => ({ label, count }));

    return {
      group_id: group,
      at: at.toISOString(),
      as_of: asOf.toISOString(),
      history,
      nodes,
      edges,
      labels,
      timeline: {
        valid: spread(instants(facts.flatMap((f) => [f.validAt, f.invalidAt])), 1000),
        known: spread(instants(facts.flatMap((f) => [f.createdAt, f.expiredAt])), 1000),
      },
      counts: {
        entities: entities.length,
        facts: facts.length,
        nodes: nodes.length,
        edges: edges.length,
        hidden_edges: facts.length - edges.length,
      },
      truncated,
    };
  }

  /**
   * One entity by uuid (or a prefix of at least 8 characters), with every
   * fact touching it that was known at `as_of`, each with its state at `at`,
   * and the episodes those facts came from.
   */
  async entity(p: Principal, input: EntityInput) {
    const group = resolveGroup(p, input.group_id);
    const id = normaliseId(input.id, 'entity');
    const at = parseInstant(input.at, 'at') ?? new Date();
    const asOf = parseInstant(input.as_of, 'as_of') ?? new Date();
    const entity = UUID_RE.test(id)
      ? await this.zep.store.getEntity(id).then((e) => (e && e.groupId === group ? e : undefined))
      : pickByPrefix(await this.zep.store.getEntities(group), id, 'entity');
    if (!entity) throw new ServiceError(404, 'entity not found');

    const touching = (await this.zep.store.getFactsForEntity(entity.uuid)).filter((f) => f.groupId === group);
    const names = await this.nameMap(touching, new Map([[entity.uuid, entity.name]]));
    const facts = touching
      .map((f) => {
        const named = { fact: f, sourceName: names.get(f.sourceNodeUuid)!, targetName: names.get(f.targetNodeUuid)! };
        return graphEdge(named, at, asOf);
      })
      .filter((e): e is GraphEdge => e !== undefined)
      .sort(
        (a, b) =>
          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
          cmp(b.valid_at ?? '', a.valid_at ?? '') || // newest start first, unknown starts last
          cmp(b.created_at, a.created_at),
      );

    const ids = [...new Set(facts.flatMap((f) => f.episodes))];
    const episodes = (await Promise.all(ids.map((uuid) => this.zep.store.getEpisode(uuid))))
      .filter((e): e is EpisodicNode => !!e && e.groupId === group && e.createdAt <= asOf)
      .sort((a, b) => b.validAt.getTime() - a.validAt.getTime());
    return {
      group_id: group,
      at: at.toISOString(),
      as_of: asOf.toISOString(),
      entity: { ...entityRow(entity), label: primaryLabel(entity.labels), attributes: entity.attributes ?? {} },
      facts,
      episodes: episodes.slice(0, 50).map((e) => ({
        uuid: e.uuid,
        name: e.name,
        source: e.source,
        valid_at: e.validAt.toISOString(),
        created_at: e.createdAt.toISOString(),
        status: e.status ?? 'processed',
      })),
      episodes_truncated: episodes.length > 50,
    };
  }

  /**
   * The groups the caller may open, most recently active first: its own list,
   * or for a principal allowed any group, every group that holds data.
   */
  async groups(p: Principal) {
    const store = this.zep.store;
    let ids: string[];
    if (p.groups !== 'any') ids = [...p.groups];
    else if (store.listGroups) ids = await store.listGroups();
    else {
      const [episodes, entities] = await Promise.all([store.getEpisodes(), store.getEntities()]);
      ids = [...new Set([...episodes.map((e) => e.groupId), ...entities.map((e) => e.groupId)])];
    }
    const now = new Date();
    const rows = await Promise.all(
      ids.map(async (group) => {
        const [episodes, entities, facts] = await Promise.all([
          store.getEpisodes(group),
          store.getEntities(group),
          store.getFacts(group),
        ]);
        const last = episodes.reduce<Date | undefined>((m, e) => (!m || e.createdAt > m ? e.createdAt : m), undefined);
        return {
          group_id: group,
          entities: entities.length,
          facts: facts.length,
          active_facts: facts.filter((f) => isFactActive(f, now)).length,
          episodes: episodes.length,
          failed_episodes: episodes.filter((e) => e.status === 'failed').length,
          last_episode_at: iso(last),
        };
      }),
    );
    rows.sort(
      (a, b) =>
        cmp(b.last_episode_at ?? '', a.last_episode_at ?? '') || cmp(a.group_id, b.group_id),
    );
    return { default_group: p.defaultGroup, groups: rows };
  }

  /** Server details for an authenticated caller (what /health used to expose). */
  async status(p: Principal) {
    return {
      ok: true,
      store: this.storeLabel,
      llm: this.llmLabel,
      default_group: p.defaultGroup,
      groups: p.groups === 'any' ? null : [...p.groups],
      jobs: this.jobs.statsFor((j) => this.canSee(p, j)),
      /** over the caller's groups: failed episodes, and those the background retry gave up on */
      episodes: await this.failures(p),
      /** the zone relative dates in ingested text are resolved in */
      timezone: displayTimeZone(),
    };
  }

  /**
   * Failed and given-up episodes over the caller's groups, counted by the
   * store (the web UI polls /v1/status: no episode is loaded for it). Null
   * when the store cannot answer: the status still does.
   */
  private async failures(p: Principal): Promise<{ failed: number; given_up: number } | null> {
    const store = this.zep.store;
    const groups = p.groups === 'any' ? undefined : [...p.groups];
    try {
      if (store.countFailedEpisodes) {
        const counts = await store.countFailedEpisodes(groups, this.retryMax);
        return { failed: counts.failed, given_up: counts.givenUp };
      }
      const episodes = groups
        ? (await Promise.all(groups.map((g) => store.getEpisodes(g)))).flat()
        : await store.getEpisodes();
      return { failed: episodes.filter((e) => e.status === 'failed').length, given_up: this.givenUp(episodes) };
    } catch {
      return null;
    }
  }

  /* ---------- lifecycle ---------- */

  /**
   * Wait until no job is queued or running and no synchronous ingestion is in
   * flight. False when `timeoutMs` passed first (the unfinished episodes stay
   * pending and are recovered at the next start).
   */
  async drain(timeoutMs = Infinity): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.jobs.drain(deadline - Date.now()))) return false;
      if (this.inflight.size === 0) return true;
      if (!(await settledBefore([...this.inflight], deadline))) return false;
    }
  }

  /** Drain (bounded) and write the snapshot; the last step before exit. */
  async shutdown(timeoutMs = Infinity): Promise<boolean> {
    const drained = await this.drain(timeoutMs);
    await this.persistence?.flush(this.zep);
    return drained;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = () => this.inflight.delete(work);
    work.then(done, done);
    return work;
  }

  /* ---------- helpers ---------- */

  /** The episode of `group` whose uuid is `rawId` or starts with it. */
  private async findEpisode(group: string, rawId: string): Promise<EpisodicNode> {
    const id = normaliseId(rawId, 'episode');
    const episode = UUID_RE.test(id)
      ? await this.zep.store.getEpisode(id).then((e) => (e && e.groupId === group ? e : undefined))
      : pickByPrefix(await this.zep.store.getEpisodes(group), id, 'episode');
    if (!episode) throw new ServiceError(404, 'episode not found');
    return episode;
  }

  /** Failed episodes the background retry no longer takes (retry_failed still does). */
  private givenUp(episodes: EpisodicNode[]): number {
    return episodes.filter((e) => e.status === 'failed' && (e.attempts ?? 0) >= this.retryMax).length;
  }

  private async outcome(group: string, r: IngestResult): Promise<AddMemoryOutcome> {
    const known = new Map(r.entities.map((e) => [e.uuid, e.name]));
    const [facts, reinforced, invalidated] = await Promise.all(
      [r.facts, r.reinforced, r.invalidated].map((edges) => this.withNames(edges, known)),
    );
    return {
      status: r.status,
      group_id: group,
      episode_uuid: r.episode.uuid,
      job_id: null,
      error: r.error ?? null,
      entities: r.entities.map((e) => e.name),
      facts,
      reinforced,
      invalidated,
      dropped: { ...r.dropped },
    };
  }

  /** Fact rows with endpoint names, looking up only the entities not already known. */
  private async withNames(edges: EntityEdge[], known = new Map<string, string>()): Promise<FactRow[]> {
    const names = await this.nameMap(edges, known);
    return edges.map((f) =>
      factRow({ fact: f, sourceName: names.get(f.sourceNodeUuid)!, targetName: names.get(f.targetNodeUuid)! }),
    );
  }

  /** uuid -> name for every endpoint of `edges` (a missing entity shows its uuid). */
  private async nameMap(edges: EntityEdge[], known = new Map<string, string>()): Promise<Map<string, string>> {
    const names = new Map(known);
    for (const f of edges) {
      for (const id of [f.sourceNodeUuid, f.targetNodeUuid]) {
        if (!names.has(id)) names.set(id, (await this.zep.store.getEntity(id))?.name ?? id);
      }
    }
    return names;
  }
}

/** A manual correction the record's state refuses is a 404 or a 409. */
function asServiceError(err: unknown): unknown {
  if (err instanceof InvalidationError) return new ServiceError(err.code === 'not_found' ? 404 : 409, err.message);
  return err;
}

function emptyResult(episode: EpisodicNode): IngestResult {
  return {
    episode,
    status: 'processed',
    entities: [],
    facts: [],
    reinforced: [],
    invalidated: [],
    dropped: { entities: 0, facts: 0, invalidations: 0 },
  };
}

/** Did every promise settle before `deadline` (epoch ms, may be Infinity)? */
async function settledBefore(work: Promise<unknown>[], deadline: number): Promise<boolean> {
  const all = Promise.allSettled(work).then(() => true);
  const remaining = deadline - Date.now();
  if (remaining === Infinity) return all;
  if (remaining <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining);
  });
  try {
    return await Promise.race([all, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
