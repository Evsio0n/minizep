/**
 * The operations behind every MCP tool and REST endpoint.
 *
 * Both transports are thin: they validate input with the shapes below, call
 * one method here and format the plain-JSON result (snake_case, ISO dates).
 * Every method takes the caller's Principal and resolves the memory group
 * through auth.resolveGroup(), so no endpoint can forget the tenant check.
 */
import { z } from 'zod';
import type { Minizep } from '../index.js';
import type { EntityEdge, EntityNode, EpisodicNode, FactWithContext } from '../model/types.js';
import { isFactActive } from '../model/types.js';
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
}

/* ---------------- result rows ---------------- */

export interface FactRow {
  uuid: string;
  relation: string;
  source: string;
  target: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
  /** episodes this fact was extracted from, oldest first */
  episodes: string[];
  /** fused retrieval score, on search results only */
  score: number | null;
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
  status: 'pending' | 'processed' | 'failed';
  error: string | null;
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
  /** extracted candidates discarded because an endpoint could not be resolved */
  dropped: { facts: number; invalidations: number };
}

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

export function factRow(r: FactWithContext): FactRow {
  const f = r.fact;
  return {
    uuid: f.uuid,
    relation: f.name,
    source: r.sourceName,
    target: r.targetName,
    fact: f.fact,
    valid_at: iso(f.validAt),
    invalid_at: iso(f.invalidAt),
    created_at: f.createdAt.toISOString(),
    expired_at: iso(f.expiredAt),
    episodes: [...f.episodes],
    score: r.score ?? null,
  };
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
  group: {
    group_id: groupId,
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
export type GroupInput = Input<typeof shapes.group>;

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
  private readonly persistence?: SnapshotWriter;
  /** synchronous ingestions in progress: shutdown waits for them like for jobs */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(opts: ServiceOptions) {
    this.zep = opts.zep;
    this.jobs = opts.jobs;
    this.persistence = opts.persistence;
    this.llmLabel = opts.llmLabel ?? 'unknown';
    this.storeLabel = opts.storeLabel ?? 'unknown';
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
    const id = normaliseId(input.id, 'episode');
    const episode = UUID_RE.test(id)
      ? await this.zep.store.getEpisode(id).then((e) => (e && e.groupId === group ? e : undefined))
      : pickByPrefix(await this.zep.store.getEpisodes(group), id, 'episode');
    if (!episode) throw new ServiceError(404, 'episode not found');

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
      if (err instanceof InvalidationError) {
        throw new ServiceError(err.code === 'not_found' ? 404 : 409, err.message);
      }
      throw err;
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
      },
      entities: entities.length,
      facts: { total: facts.length, active, historical: facts.length - active },
      // scoped to the group: a token must not learn how busy other tenants are
      jobs: this.jobs.statsFor((j) => j.group === group),
    };
  }

  /** Server details for an authenticated caller (what /health used to expose). */
  status(p: Principal) {
    return {
      ok: true,
      store: this.storeLabel,
      llm: this.llmLabel,
      default_group: p.defaultGroup,
      groups: p.groups === 'any' ? null : [...p.groups],
      jobs: this.jobs.statsFor((j) => this.canSee(p, j)),
    };
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
    const names = new Map(known);
    for (const f of edges) {
      for (const id of [f.sourceNodeUuid, f.targetNodeUuid]) {
        if (!names.has(id)) names.set(id, (await this.zep.store.getEntity(id))?.name ?? id);
      }
    }
    return edges.map((f) =>
      factRow({ fact: f, sourceName: names.get(f.sourceNodeUuid)!, targetName: names.get(f.targetNodeUuid)! }),
    );
  }
}

function emptyResult(episode: EpisodicNode): IngestResult {
  return {
    episode,
    status: 'processed',
    entities: [],
    facts: [],
    reinforced: [],
    invalidated: [],
    dropped: { facts: 0, invalidations: 0 },
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
