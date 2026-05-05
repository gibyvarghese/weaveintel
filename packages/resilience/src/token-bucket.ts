/**
 * @weaveintel/resilience — Token bucket rate limiter
 *
 * Endpoint-scoped, process-wide. Refills at `refillPerSec` up to `capacity`.
 * Supports a temporary cooldown window driven by upstream `Retry-After`
 * (so a single 429 stops the bucket from issuing tokens until the upstream
 * window passes — no more dog-piling immediately after a 429).
 */

export interface TokenBucketOptions {
  /** Maximum burst (how many tokens the bucket holds when full). */
  readonly capacity: number;
  /** Steady-state refill rate in tokens per second. */
  readonly refillPerSec: number;
}

export interface TokenBucket {
  /** Try to take one token without waiting. Returns true on success. */
  tryAcquire(): boolean;
  /** Wait until a token is available (or until `timeoutMs` elapses). */
  acquire(timeoutMs?: number): Promise<void>;
  /** Mark the bucket paused for the next `ms`. New `tryAcquire` will return false. */
  pauseFor(ms: number): void;
  /** Returns the milliseconds until at least one token is available. */
  msUntilAvailable(): number;
  /** Snapshot current state. Useful for observers. */
  snapshot(): { tokens: number; pausedUntil: number; capacity: number; refillPerSec: number };
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  if (opts.capacity <= 0) throw new Error('TokenBucket: capacity must be > 0');
  if (opts.refillPerSec <= 0) throw new Error('TokenBucket: refillPerSec must be > 0');

  let tokens = opts.capacity;
  let lastRefill = Date.now();
  let pausedUntil = 0;
  const capacity = opts.capacity;
  const refillPerSec = opts.refillPerSec;

  function refill(): void {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
    lastRefill = now;
  }

  function msUntilAvailable(): number {
    const now = Date.now();
    if (now < pausedUntil) return pausedUntil - now;
    refill();
    if (tokens >= 1) return 0;
    const needed = 1 - tokens;
    return Math.ceil((needed / refillPerSec) * 1000);
  }

  return {
    tryAcquire(): boolean {
      const now = Date.now();
      if (now < pausedUntil) return false;
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
    async acquire(timeoutMs?: number): Promise<void> {
      const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
      // small bounded sleep loop; capped so we don't busy-wait
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.tryAcquire()) return;
        const wait = Math.min(msUntilAvailable() || 10, deadline - Date.now());
        if (wait <= 0) throw new Error('TokenBucket: acquire timed out');
        await new Promise<void>((r) => setTimeout(r, Math.max(1, wait)));
      }
    },
    pauseFor(ms: number): void {
      const until = Date.now() + Math.max(0, ms);
      if (until > pausedUntil) pausedUntil = until;
    },
    msUntilAvailable,
    snapshot(): { tokens: number; pausedUntil: number; capacity: number; refillPerSec: number } {
      refill();
      return { tokens, pausedUntil, capacity, refillPerSec };
    },
  };
}
