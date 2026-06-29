// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKeyedRateLimiter } from './keyed-rate-limiter.js';

describe('createKeyedRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to the burst then denies, per key independently', () => {
    const rl = createKeyedRateLimiter({ ratePerWindow: 3, windowMs: 60_000 });
    // alice gets 3, then 429
    expect(rl.check('alice').allowed).toBe(true);
    expect(rl.check('alice').allowed).toBe(true);
    expect(rl.check('alice').allowed).toBe(true);
    const denied = rl.check('alice');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.limit).toBe(3);
    // bob is a different key — unaffected by alice exhausting hers
    expect(rl.check('bob').allowed).toBe(true);
  });

  it('refills over time (token returns after the window fraction elapses)', () => {
    const rl = createKeyedRateLimiter({ ratePerWindow: 6, windowMs: 60_000 }); // 1 token / 10s
    for (let i = 0; i < 6; i++) expect(rl.check('u').allowed).toBe(true);
    expect(rl.check('u').allowed).toBe(false);
    vi.advanceTimersByTime(10_000); // one token's worth
    expect(rl.check('u').allowed).toBe(true);
    expect(rl.check('u').allowed).toBe(false);
  });

  it('evicts least-recently-used keys past maxKeys', () => {
    const rl = createKeyedRateLimiter({ ratePerWindow: 1, windowMs: 60_000, maxKeys: 2 });
    rl.check('a'); rl.check('b'); // a,b live
    expect(rl.size()).toBe(2);
    rl.check('c'); // evicts 'a' (LRU)
    expect(rl.size()).toBe(2);
    // 'a' was evicted, so its bucket is fresh again (allowed), proving eviction happened
    expect(rl.check('a').allowed).toBe(true);
  });

  it('reset() drops a key so its quota refreshes', () => {
    const rl = createKeyedRateLimiter({ ratePerWindow: 1, windowMs: 60_000 });
    expect(rl.check('x').allowed).toBe(true);
    expect(rl.check('x').allowed).toBe(false);
    rl.reset('x');
    expect(rl.check('x').allowed).toBe(true);
  });
});
