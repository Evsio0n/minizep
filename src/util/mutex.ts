/**
 * Serialises async work. The ingestion pipeline mutates shared graph state
 * across several `await` points (LLM calls, embedding calls); without this,
 * two concurrent addEpisode() calls interleave and can create duplicate
 * entities for the same name. Production needs a defined order, not luck.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `fn` exclusively; callers queue in FIFO order. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // keep the chain alive but never let a rejection break subsequent waiters
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Number of queued operations (approximate; for metrics/tests). */
  get pending(): number {
    return this.depth;
  }
  private depth = 0;

  /** Instrumented variant used by the pipeline. */
  runTracked<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    return this.run(fn).finally(() => {
      this.depth--;
    });
  }
}

/**
 * One Mutex per key. Ingestion only needs a defined order WITHIN a memory
 * group (entities and facts never cross groups), so different groups run
 * concurrently while the same group stays strictly serialised. Idle keys are
 * dropped so the map does not grow with every group ever seen.
 */
export class KeyedMutex {
  private locks = new Map<string, { mutex: Mutex; users: number }>();

  /** Run `fn` exclusively for `key`; callers with the same key queue in FIFO order. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key);
    if (!entry) this.locks.set(key, (entry = { mutex: new Mutex(), users: 0 }));
    const lock = entry;
    lock.users++;
    return lock.mutex.run(fn).finally(() => {
      if (--lock.users === 0 && this.locks.get(key) === lock) this.locks.delete(key);
    });
  }

  /** Queued or running operations across all keys (for metrics/tests). */
  get pending(): number {
    let n = 0;
    for (const { users } of this.locks.values()) n += users;
    return n;
  }
}
