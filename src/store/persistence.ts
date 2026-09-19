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
      void this.save(zep);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write immediately. */
  async save(zep: Minizep): Promise<void> {
    if (!this.applicable(zep)) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, zep.snapshot(), 'utf8');
    await rename(tmp, this.path);
  }

  /** Flush any pending write (call before exit). */
  async flush(zep: Minizep): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      this.pending = false;
      await this.save(zep);
    }
  }
}
