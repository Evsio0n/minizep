/**
 * MCP sessions of the HTTP server.
 *
 * A session is bound to the credential that created it: its tools act for
 * that token's groups, so a request presenting another token with the same
 * session id must be refused (it would otherwise act as the other tenant).
 * Sessions expire after `ttlMs` without traffic and are capped at
 * `maxSessions`; making room evicts the session idle for longest. A session
 * with a request in flight is never idle; a client's standalone SSE stream
 * (GET) does not count, since a half-open connection could otherwise pin a
 * session forever. Closing an expired session ends that stream, and the
 * client's next request gets 404, which tells it to start a new session.
 */

export interface SessionHandle {
  /** releases the transport and its server */
  close(): Promise<void>;
}

interface Entry<T extends SessionHandle> {
  id: string;
  principalId: string;
  handle: T;
  lastSeen: number;
  inflight: number;
}

export interface SessionRegistryOptions {
  ttlMs?: number;
  maxSessions?: number;
  /** clock, for tests */
  now?: () => number;
}

export type Lookup<T> =
  | { ok: true; handle: T; release: () => void }
  | { ok: false; status: 403 | 404; error: string };

export class SessionRegistry<T extends SessionHandle> {
  readonly ttlMs: number;
  readonly maxSessions: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Entry<T>>();
  /** sessions being created: counted against the cap before they have an id */
  private reserved = 0;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(opts: SessionRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxSessions = Math.max(1, opts.maxSessions ?? 256);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  countFor(principalId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.principalId === principalId) n++;
    return n;
  }

  /**
   * The session `id` for a request made by `principalId`. A `busy` request
   * keeps the session from expiring until `release()` is called (when the
   * response closes).
   */
  acquire(id: string, principalId: string, busy = true): Lookup<T> {
    const entry = this.sessions.get(id);
    if (!entry || this.expired(entry)) {
      if (entry) this.evict(entry);
      return { ok: false, status: 404, error: 'Session not found' };
    }
    if (entry.principalId !== principalId) {
      return { ok: false, status: 403, error: 'session belongs to another token' };
    }
    entry.lastSeen = this.now();
    if (busy) entry.inflight++;
    let released = !busy;
    const release = () => {
      if (released) return;
      released = true;
      entry.inflight--;
      entry.lastSeen = this.now();
    };
    return { ok: true, handle: entry.handle, release };
  }

  /**
   * Hold a slot for a session about to be created, evicting expired sessions
   * and then the longest idle one when full. False when every session is
   * busy. Pair with add() or unreserve().
   */
  reserve(): boolean {
    this.sweep();
    while (this.sessions.size + this.reserved >= this.maxSessions) {
      const idle = [...this.sessions.values()]
        .filter((s) => s.inflight === 0)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!idle) return false;
      this.evict(idle);
    }
    this.reserved++;
    return true;
  }

  unreserve(): void {
    if (this.reserved > 0) this.reserved--;
  }

  /** Register a created session (consumes a reservation when one is held). */
  add(id: string, principalId: string, handle: T): void {
    this.unreserve();
    this.sessions.set(id, { id, principalId, handle, lastSeen: this.now(), inflight: 0 });
  }

  /** Forget a session its transport closed (no close() call: it is already closing). */
  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Close every session idle for longer than the TTL. */
  sweep(): void {
    for (const s of [...this.sessions.values()]) if (this.expired(s)) this.evict(s);
  }

  /** Sweep periodically until closeAll(); the timer never keeps the process alive. */
  startSweeping(intervalMs = Math.min(this.ttlMs, 60_000)): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, intervalMs));
    this.sweeper.unref();
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.handle.close()));
  }

  private expired(s: Entry<T>): boolean {
    return s.inflight === 0 && this.now() - s.lastSeen > this.ttlMs;
  }

  private evict(s: Entry<T>): void {
    this.sessions.delete(s.id);
    void s.handle.close().catch(() => undefined);
  }
}
