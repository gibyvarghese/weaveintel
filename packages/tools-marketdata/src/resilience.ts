/**
 * Resilience wrapper for MarketDataAdapter.
 *
 * Bounded exponential retry for transient HTTP errors + per-symbol circuit breaker.
 *
 * Phase 5 — the bespoke BreakerState Map is replaced by `createCircuitBreaker`
 * from `@weaveintel/resilience`, removing the local duplicate implementation.
 */
// no-adhoc-resilience: allow (reason: thin wrapper composing
// `createRetryBudget` + `createCircuitBreaker` from the canonical packages —
// no local re-implementation; basename triggers the lint, hence the per-file allow.)

import { createRetryBudget } from '@weaveintel/reliability';
import { createCircuitBreaker } from '@weaveintel/resilience';
import type { MarketDataAdapter } from './adapter.js';

const FAILURE_THRESHOLD = 5;
const OPEN_COOLDOWN_MS = 60_000;

const circuitBreakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();

function getBreaker(key: string): ReturnType<typeof createCircuitBreaker> {
  let b = circuitBreakers.get(key);
  if (!b) {
    b = createCircuitBreaker({ failureThreshold: FAILURE_THRESHOLD, cooldownMs: OPEN_COOLDOWN_MS });
    circuitBreakers.set(key, b);
  }
  return b;
}

const budget = createRetryBudget({
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 20_000,
  retryableErrors: ['429', 'Too Many Requests', '503', '502', '500', 'ECONNRESET', 'ETIMEDOUT'],
});

export class MarketDataRateLimitError extends Error {
  readonly code = 'marketdata_rate_limited' as const;
  readonly retryAfterSeconds: number;
  readonly breakerOpen: boolean;
  constructor(key: string, retryAfterSeconds: number, breakerOpen: boolean, message?: string) {
    super(message ?? `MarketData circuit breaker open for "${key}". Wait ${retryAfterSeconds}s.`);
    this.name = 'MarketDataRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.breakerOpen = breakerOpen;
  }
}

export function getMarketDataBreakerState(key: string): { open: boolean; remainingSeconds: number; consecutiveFailures: number } {
  const b = circuitBreakers.get(key);
  if (!b) return { open: false, remainingSeconds: 0, consecutiveFailures: 0 };
  const snap = b.snapshot();
  const remainingMs = snap.state === 'open'
    ? Math.max(0, snap.openedAt + snap.cooldownMs - Date.now())
    : 0;
  return {
    open: snap.state === 'open',
    remainingSeconds: Math.ceil(remainingMs / 1000),
    consecutiveFailures: snap.consecutiveFailures,
  };
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests|503|502/i.test(msg);
}

async function guard<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const breaker = getBreaker(key);
  const pass = breaker.canPass();
  if (!pass.allowed) {
    const remainingMs = Math.max(0, pass.reopensAt - Date.now());
    throw new MarketDataRateLimitError(key, Math.ceil(remainingMs / 1000), true);
  }

  try {
    const r = await budget.execute(fn);
    breaker.recordSuccess();
    return r;
  } catch (err) {
    if (isRateLimit(err)) {
      breaker.recordFailure();
      const state = getMarketDataBreakerState(key);
      throw new MarketDataRateLimitError(key, state.remainingSeconds || 30, state.open, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export function wrapAdapterWithResilience(inner: MarketDataAdapter, adapterKey = 'default'): MarketDataAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => guard(adapterKey, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
    },
  });
}

export function __resetBreakerStateForTests(): void {
  circuitBreakers.clear();
}
