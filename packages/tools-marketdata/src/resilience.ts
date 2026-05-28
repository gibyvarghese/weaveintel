/**
 * Resilience wrapper for MarketDataAdapter.
 * Bounded exponential retry for transient HTTP errors + per-symbol circuit breaker.
 * Mirrors the pattern in @weaveintel/tools-kaggle/resilience.ts.
 */

import { createRetryBudget } from '@weaveintel/reliability';
import type { MarketDataAdapter } from './adapter.js';

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_COOLDOWN_MS = 60_000;
const breakers = new Map<string, BreakerState>();

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
  const s = breakers.get(key);
  if (!s) return { open: false, remainingSeconds: 0, consecutiveFailures: 0 };
  const remainingMs = Math.max(0, s.openUntil - Date.now());
  return { open: remainingMs > 0, remainingSeconds: Math.ceil(remainingMs / 1000), consecutiveFailures: s.consecutiveFailures };
}

function checkBreaker(key: string): void {
  const s = breakers.get(key);
  if (s && s.openUntil > Date.now()) {
    const remaining = Math.ceil((s.openUntil - Date.now()) / 1000);
    throw new MarketDataRateLimitError(key, remaining, true);
  }
}

function recordResult(key: string, ok: boolean): void {
  const s = breakers.get(key) ?? { consecutiveFailures: 0, openUntil: 0 };
  if (ok) { s.consecutiveFailures = 0; s.openUntil = 0; }
  else {
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= FAILURE_THRESHOLD) s.openUntil = Date.now() + OPEN_COOLDOWN_MS;
  }
  breakers.set(key, s);
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests|503|502/i.test(msg);
}

async function guard<T>(key: string, fn: () => Promise<T>): Promise<T> {
  checkBreaker(key);
  try {
    const r = await budget.execute(fn);
    recordResult(key, true);
    return r;
  } catch (err) {
    if (isRateLimit(err)) {
      recordResult(key, false);
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
  breakers.clear();
}
