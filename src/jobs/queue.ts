import { uuid } from '../model/types.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job<T = unknown> {
  id: string;
  label: string;
  status: JobStatus;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: T;
  error?: string;
}

export interface JobQueueOptions {
  /** how many jobs may run at once */
  concurrency?: number;
  /** completed jobs kept in memory for later polling */
  historyLimit?: number;
}

/**
 * Bounded in-process work queue.
 *
 * Ingestion calls an LLM and takes seconds; a client should not have to hold a
 * request open for it. Submitting returns a job id immediately and a later
 * status poll picks up the result.
 *
 * In-process means a restart loses queued work — acceptable now because the
 * episode text is persisted before queuing is attempted, and `retryFailed()`
 * can recover anything that was interrupted.
 */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private waiting: Array<() => void> = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly historyLimit: number;

  constructor(opts: JobQueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.historyLimit = opts.historyLimit ?? 200;
  }

  submit<T>(label: string, work: () => Promise<T>): Job<T> {
    const job: Job<T> = {
      id: uuid(),
      label,
      status: 'queued',
      createdAt: new Date(),
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.evictOld();
    this.pump(job, work);
    return job;
  }

  private pump<T>(job: Job<T>, work: () => Promise<T>): void {
    const start = async () => {
      this.running++;
      job.status = 'running';
      job.startedAt = new Date();
      try {
        job.result = await work();
        job.status = 'succeeded';
      } catch (err) {
        job.status = 'failed';
        job.error = (err as Error).message;
      } finally {
        job.finishedAt = new Date();
        this.running--;
        this.evictOld();
        const next = this.waiting.shift();
        if (next) next();
      }
    };

    if (this.running < this.concurrency) {
      void start();
    } else {
      this.waiting.push(() => void start());
    }
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
        return !!job && (job.status === 'succeeded' || job.status === 'failed');
      });
      if (idx === -1) break; // everything remaining is queued or running
      const [id] = this.order.splice(idx, 1);
      this.jobs.delete(id);
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(limit = 20): Job[] {
    return [...this.order]
      .reverse()
      .slice(0, limit)
      .map((id) => this.jobs.get(id))
      .filter((j): j is Job => !!j);
  }

  get stats(): { queued: number; running: number } {
    const all = [...this.jobs.values()];
    return {
      queued: all.filter((j) => j.status === 'queued').length,
      running: all.filter((j) => j.status === 'running').length,
    };
  }

  /** Resolves when nothing is queued or running (used by tests and shutdown). */
  async drain(): Promise<void> {
    while (this.stats.queued > 0 || this.stats.running > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
