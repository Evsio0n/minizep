/**
 * Listening on several addresses, some of which may not exist yet.
 *
 * A typical deployment listens on loopback plus a private or VPN address
 * (MINIZEP_HOST="127.0.0.1,100.64.0.10"). At boot the VPN interface may come
 * up after the service: binding its address then fails with EADDRNOTAVAIL.
 * That address is retried with exponential backoff instead of failing the
 * whole service; any other bind error (port in use, permission) is fatal.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** "a, b ,c" -> ["a", "b", "c"]; an empty value means loopback only. */
export function parseHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length ? [...new Set(hosts)] : ['127.0.0.1'];
}

export interface RetryOptions {
  /** first wait after EADDRNOTAVAIL (default 1s), doubled up to maxDelayMs (default 30s) */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** called before each wait */
  onRetry?: (err: NodeJS.ErrnoException, delayMs: number, attempt: number) => void;
}

export interface RetryingListen {
  /** the first attempt: the bound address, or null when retrying in the background */
  first: Promise<AddressInfo | null>;
  /** resolves once bound; rejects on a fatal error or cancel() */
  bound: Promise<AddressInfo>;
  /** stop retrying (a bound server is left to the caller to close) */
  cancel(): void;
}

/** Only a missing address is worth waiting for. */
export function isRetryableBindError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EADDRNOTAVAIL';
}

/** Runs `attempt` until it binds, waiting out EADDRNOTAVAIL with backoff. */
export function listenWithRetry(attempt: () => Promise<AddressInfo>, opts: RetryOptions = {}): RetryingListen {
  const initial = opts.initialDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let settleFirst: (v: AddressInfo | null) => void = () => undefined;
  let failFirst: (err: unknown) => void = () => undefined;
  const first = new Promise<AddressInfo | null>((resolve, reject) => {
    settleFirst = resolve;
    failFirst = reject;
  });

  const bound = (async () => {
    let delay = initial;
    for (let n = 1; ; n++) {
      if (cancelled) throw new Error('listen cancelled');
      try {
        const addr = await attempt();
        settleFirst(addr);
        return addr;
      } catch (err) {
        if (!isRetryableBindError(err) || cancelled) {
          failFirst(err);
          throw err;
        }
        opts.onRetry?.(err as NodeJS.ErrnoException, delay, n);
        settleFirst(null);
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, delay);
        });
        delay = Math.min(delay * 2, max);
      }
    }
  })();
  // callers that only look at `first` must not see an unhandled rejection
  bound.catch(() => undefined);

  return {
    first,
    bound,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}

/** One bind attempt of `server`; a failed attempt leaves it reusable. */
export function bindOnce(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
