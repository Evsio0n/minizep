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
