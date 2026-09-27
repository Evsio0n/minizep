import { uuid } from '../model/types.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job<T = unknown> {
  id: string;
  label: string;
  status: JobStatus;
  /**
   * Where the job is, for a caller polling it (in memory only): 'queued',
   * then what the work reports (see IngestStage), then 'done', 'failed' or
   * 'cancelled'.
   */
  stage: string;
  /** more about the stage, e.g. "LLM attempt 2, max_tokens=16000" */
  stageDetail?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: T;
  error?: string;
  /** memory group the job works in (jobs are only shown to callers of that group) */
  group?: string;
  /** the record the job works on, e.g. an episode uuid */
  ref?: string;
}

/** Optional metadata attached to a job at submission. */
export interface JobMeta {
  group?: string;
  ref?: string;
}

export interface JobQueueOptions {
  /** how many jobs may run at once */
  concurrency?: number;
  /** completed jobs kept in memory for later polling */
  historyLimit?: number;
}

/** What the queue keeps for a job until it has settled. */
interface Live {
  ctl: AbortController;
  settled: Promise<void>;
  /** runs the job; set while it waits for a free slot */
  start?: () => void;
}

const finished = (j: Job) => j.status !== 'queued' && j.status !== 'running';

/**
 * Bounded in-process work queue.
 *
 * Ingestion calls an LLM and takes a minute or two; a client should not have
 * to hold a request open for it. Submitting returns a job id immediately and a
 * later status poll picks up the result, or cancels the job.
 *
 * In-process means a restart loses the queue itself, not the work: an episode
 * is persisted as 'pending' before its job is queued, and servers re-enqueue
 * pending episodes at startup (`recoverPending()`).
 */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private waiting: string[] = [];
  private live = new Map<string, Live>();
  private running = 0;
  private readonly concurrency: number;
  private readonly historyLimit: number;

  constructor(opts: JobQueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.historyLimit = opts.historyLimit ?? 200;
  }

  /**
   * Queue `work`. It gets the job, to report its stage on, and a signal that
   * cancel() aborts: work that gives up with the signal's reason ends the job
   * 'cancelled'.
   */
  submit<T>(label: string, work: (job: Job<T>, signal: AbortSignal) => Promise<T>, meta: JobMeta = {}): Job<T> {
    const job: Job<T> = {
      id: uuid(),
      label,
      status: 'queued',
      stage: 'queued',
      createdAt: new Date(),
      group: meta.group,
      ref: meta.ref,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.evictOld();

    const ctl = new AbortController();
    let settle: () => void = () => undefined;
    const live: Live = { ctl, settled: new Promise<void>((r) => (settle = r)) };
    this.live.set(job.id, live);
    const start = async () => {
      live.start = undefined;
      this.running++;
      job.status = 'running';
      job.startedAt = new Date();
      try {
        job.result = await work(job, ctl.signal);
        job.status = 'succeeded';
      } catch (err) {
        job.status = ctl.signal.aborted && err === ctl.signal.reason ? 'cancelled' : 'failed';
        job.error = (err as Error).message;
      } finally {
        this.running--;
        this.finish(job);
        settle();
        const next = this.waiting.shift();
        if (next) this.live.get(next)?.start?.();
      }
    };

    if (this.running < this.concurrency) {
      void start();
    } else {
      live.start = () => void start();
      this.waiting.push(job.id);
    }
    return job;
  }

  /**
   * Cancel a job that has not finished, with `reason` as its error. A queued
   * one leaves the queue and never runs; a running one has its signal
   * aborted, and ends 'cancelled' when its work gives up (work past its last
   * point of return finishes as it would have). Resolves with the job once it
   * has settled: its status says which happened. Undefined for an unknown id.
   */
  async cancel(id: string, reason: Error): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    const live = this.live.get(id);
    if (!job || !live) return job;
    if (live.start) {
      this.waiting.splice(this.waiting.indexOf(id), 1);
      job.status = 'cancelled';
      job.error = reason.message;
      this.finish(job);
      return job;
    }
    live.ctl.abort(reason);
    await live.settled;
    return job;
  }

  private finish(job: Job): void {
    job.finishedAt = new Date();
    job.stage = job.status === 'succeeded' ? 'done' : job.status;
    job.stageDetail = undefined;
    this.live.delete(job.id);
    this.evictOld();
  }

  /**
   * Keeps memory bounded by dropping the OLDEST SETTLED job once the limit is
   * exceeded. In-flight work is never evicted, and an unfinished job at the
   * front must not stop eviction of settled jobs behind it.
   */
  private evictOld(): void {
    while (this.jobs.size > this.historyLimit) {
      const idx = this.order.findIndex((id) => {
        const job = this.jobs.get(id);
        return !!job && finished(job);
      });
      if (idx === -1) break; // everything remaining is queued or running
      const [id] = this.order.splice(idx, 1);
      this.jobs.delete(id);
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Newest first, optionally only the jobs `filter` accepts. */
  list(limit = 20, filter?: (job: Job) => boolean): Job[] {
    return [...this.order]
      .reverse()
      .map((id) => this.jobs.get(id))
      .filter((j): j is Job => !!j && (!filter || filter(j)))
      .slice(0, limit);
  }

  get stats(): { queued: number; running: number } {
    return this.statsFor();
  }

  /** Queued and running counts, optionally only over the jobs `filter` accepts. */
  statsFor(filter?: (job: Job) => boolean): { queued: number; running: number } {
    const all = [...this.jobs.values()].filter((j) => !filter || filter(j));
    return {
      queued: all.filter((j) => j.status === 'queued').length,
      running: all.filter((j) => j.status === 'running').length,
    };
  }

  /**
   * Resolves when nothing is queued or running (used by tests and shutdown):
   * true once idle, false when `timeoutMs` passed first.
   */
  async drain(timeoutMs = Infinity): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.stats.queued > 0 || this.stats.running > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }
}
