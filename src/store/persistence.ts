import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Minizep } from '../index.js';
import { isSnapshotable } from './memory-store.js';

/**
 * JSON snapshot persistence for a Minizep instance.
 *
 * The in-memory store is authoritative at runtime; this keeps a durable copy
 * on disk so an MCP server survives restarts. Writes are atomic
 * (tmp file + rename) so a crash mid-write cannot corrupt the graph.
 */
export class FilePersistence {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  /** the last write started or queued, and a queued one that has not started */
  private tail: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;

  constructor(
    private path: string,
    private debounceMs = 250,
  ) {}

  /** True when the backing store needs external snapshotting at all. */
  private applicable(zep: Minizep): boolean {
    return isSnapshotable(zep.store);
  }

  /** Load an existing snapshot into the instance; missing file is not an error. */
  async load(zep: Minizep): Promise<boolean> {
    // a database backend persists itself; snapshotting it would be redundant
    if (!this.applicable(zep)) return false;
    try {
      const json = await readFile(this.path, 'utf8');
      zep.load(json);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Schedule a debounced snapshot (coalesces bursts of ingestion). */
  schedule(zep: Minizep): void {
    if (!this.applicable(zep)) return;
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.pending) return;
      this.pending = false;
      this.save(zep).catch((err) => console.error('[minizep] snapshot write failed:', (err as Error).message));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /**
   * Write now; resolves once the file holds at least the state of the moment
   * of the call. Writes never overlap (they share the tmp file): a call during
   * a write queues one more, and every call arriving before that one starts
   * shares it, since it snapshots the graph when it runs.
   */
  save(zep: Minizep): Promise<void> {
    if (!this.applicable(zep)) return Promise.resolve();
    if (this.queued) return this.queued;
    const run: Promise<void> = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.queued === run) this.queued = null;
        return this.write(zep);
      });
    this.queued = run;
    this.tail = run;
    return run;
  }

  private async write(zep: Minizep): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, zep.snapshot(), 'utf8');
    await rename(tmp, this.path);
  }

  /** Flush any pending write and wait for one in progress (call before exit). */
  async flush(zep: Minizep): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      this.pending = false;
      await this.save(zep);
    } else {
      // a write still running must land before exit; a failed one is retried
      await this.tail.catch(() => this.save(zep));
    }
  }
}
