// SPDX-License-Identifier: MIT
/**
 * @weaveintel/resilience — Keyed (per-subject) rate limiter
 *
 * --- For someone new to this ---
 * `createTokenBucket` gives ONE bucket. Often you need one bucket PER subject — per user, per
 * tenant, per API key — e.g. "each user may make at most N AI requests per minute". This wraps the
 * existing token bucket in a map keyed by an arbitrary string, creating a bucket lazily on first
 * use and evicting the least-recently-used keys so memory can't grow without bound.
 *
 * It is process-local (in-memory): perfect for a single node. For a multi-node deployment, back the
 * same shape with Redis (see packages/workflows redis-rate-limiter) — callers depend only on the
 * `KeyedRateLimiter` interface, so swapping the implementation needs no call-site changes.
 */
import { createTokenBucket, type TokenBucket } from './token-bucket.js';

export interface KeyedRateLimiterOptions {
  /** Tokens per window (e.g. 20 requests / minute → ratePerWindow=20). */
  readonly ratePerWindow: number;
  /** Window length in milliseconds (default 60_000 = 1 minute). */
  readonly windowMs?: number;
  /** Max burst above the steady rate. Defaults to `ratePerWindow` (a full window of burst). */
  readonly burst?: number;
  /** Max distinct keys to keep before evicting the least-recently-used. Default 10_000. */
  readonly maxKeys?: number;
}

export interface RateDecision {
  /** True if the request is allowed (a token was taken). */
  readonly allowed: boolean;
  /** Milliseconds until a token would be available — surface as the HTTP `Retry-After` header. */
  readonly retryAfterMs: number;
  /** The effective limit (tokens per window) applied to this key. */
  readonly limit: number;
}

export interface KeyedRateLimiter {
  /** Try to consume one token for `key`. Never throws. */
  check(key: string): RateDecision;
  /** Number of live keys (buckets) currently held. */
  size(): number;
  /** Drop a key's bucket (e.g. on logout / quota reset). */
  reset(key: string): void;
  /** Drop all buckets. */
  clear(): void;
}

function windowToRefillPerSec(ratePerWindow: number, windowMs: number): number {
  return ratePerWindow / (windowMs / 1000);
}

/**
 * Create a per-key rate limiter. Each distinct `key` gets its own token bucket with the configured
 * rate. The rate is read fresh from `opts` at creation time; to change limits at runtime, create a
 * new limiter (cheap) or call `reset` — buckets self-tune on the next request.
 */
export function createKeyedRateLimiter(opts: KeyedRateLimiterOptions): KeyedRateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const ratePerWindow = Math.max(1, opts.ratePerWindow);
  const burst = Math.max(1, opts.burst ?? ratePerWindow);
  const maxKeys = Math.max(1, opts.maxKeys ?? 10_000);
  const refillPerSec = windowToRefillPerSec(ratePerWindow, windowMs);

  // Map preserves insertion order; we use it as a cheap LRU (delete+set on touch, evict from front).
  const buckets = new Map<string, TokenBucket>();

  function touch(key: string): TokenBucket {
    let b = buckets.get(key);
    if (b) {
      buckets.delete(key);
      buckets.set(key, b); // move to MRU position
      return b;
    }
    b = createTokenBucket({ capacity: burst, refillPerSec });
    buckets.set(key, b);
    // Evict least-recently-used while over the cap.
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return b;
  }

  return {
    check(key: string): RateDecision {
      const b = touch(key);
      if (b.tryAcquire()) return { allowed: true, retryAfterMs: 0, limit: ratePerWindow };
      return { allowed: false, retryAfterMs: b.msUntilAvailable(), limit: ratePerWindow };
    },
    size(): number { return buckets.size; },
    reset(key: string): void { buckets.delete(key); },
    clear(): void { buckets.clear(); },
  };
}
