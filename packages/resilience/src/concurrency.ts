/**
 * @weaveintel/resilience — In-flight concurrency limiter
 *
 * Caps the number of concurrent in-flight calls per endpoint. Independent of
 * rate limiting — a 1000 RPM bucket can still issue 1000 simultaneous calls
 * if no concurrency cap is set.
 */

export interface ConcurrencyLimiterOptions {
  readonly maxConcurrent: number;
  readonly maxQueue?: number;
}

export interface ConcurrencyLimiter {
  /** Acquire a slot. Resolves when in-flight < maxConcurrent. Throws if queue is full. */
  acquire(): Promise<() => void>;
  inFlight(): number;
  queued(): number;
}

export function createConcurrencyLimiter(opts: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  if (opts.maxConcurrent <= 0) throw new Error('ConcurrencyLimiter: maxConcurrent must be > 0');
  let active = 0;
  const waiters: Array<() => void> = [];

  function release(): void {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  return {
    async acquire(): Promise<() => void> {
      if (active < opts.maxConcurrent) {
        active += 1;
        return release;
      }
      if (opts.maxQueue !== undefined && waiters.length >= opts.maxQueue) {
        throw new Error('ConcurrencyLimiter: queue full');
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      return release;
    },
    inFlight: () => active,
    queued: () => waiters.length,
  };
}
