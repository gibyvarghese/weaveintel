/**
 * Resilience wrapper for the Kaggle adapter.
 *
 * Why: the live Kaggle HTTP API enforces a strict per-account rate limit
 * (~1 push per ~2s, with bursts triggering 429 Too Many Requests). When the
 * strategist's ReAct loop runs into a 429 it tends to retry with a slightly
 * different slug instead of waiting — burning the entire model budget on
 * `kaggle_push_kernel` retries that all immediately re-429 because no time
 * has elapsed for the per-account window to drain.
 *
 * Two layered defences, both implemented purely with code-level primitives
 * (no prompt/playbook rules):
 *
 * 1. **Bounded exponential retry** via `@weaveintel/reliability`'s
 *    `createRetryBudget`. Catches ONLY messages matching `429` or
 *    `Too Many Requests`. Up to N retries with backoff before re-throwing
 *    the original error so the ReAct loop sees the same shape it always
 *    has and can decide how to surface it.
 *
 * 2. **Per-username circuit breaker.** After `FAILURE_THRESHOLD` consecutive
 *    429s for the same Kaggle account, we open the breaker for
 *    `OPEN_COOLDOWN_MS`. Subsequent calls during the cooldown fail fast with
 *    a clear "circuit breaker open" message — that lets the LLM stop
 *    cycling slug variants and return control to the supervisor instead of
 *    burning model time on calls that will all 429.
 *
 * The wrap is a Proxy so any new method added to `KaggleAdapter` is
 * automatically guarded without code changes here. Methods are assumed to
 * take `(creds: KaggleCredentials, ...rest)` as their signature — the
 * Kaggle adapter contract.
 */

import { createRetryBudget } from '@weaveintel/reliability';
import type { KaggleAdapter, KaggleCredentials } from './kaggle.js';

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_COOLDOWN_MS = 60_000;

const breakers = new Map<string, BreakerState>();

const budget = createRetryBudget({
  maxRetries: 3,
  baseDelayMs: 1500,
  maxDelayMs: 30_000,
  retryableErrors: ['429', 'Too Many Requests'],
});

/**
 * Structured error thrown when the per-username circuit breaker is open OR
 * when the underlying call returned 429. Carries the wait hint so callers
 * (in particular the kaggle tool wrapper) can translate it into a JSON
 * envelope the LLM can read deterministically instead of a raw text error.
 */
export class KaggleRateLimitError extends Error {
  readonly code = 'kaggle_rate_limited' as const;
  readonly retryAfterSeconds: number;
  readonly username: string;
  readonly breakerOpen: boolean;
  constructor(username: string, retryAfterSeconds: number, breakerOpen: boolean, message?: string) {
    super(
      message ??
        `Kaggle circuit breaker open for "${username}" — too many recent 429s. ` +
          `Wait ${retryAfterSeconds}s for the per-account quota window to drain before retrying.`,
    );
    this.name = 'KaggleRateLimitError';
    this.username = username;
    this.retryAfterSeconds = retryAfterSeconds;
    this.breakerOpen = breakerOpen;
  }
}

/** Test/operator helper — read current breaker state without mutating it. */
export function getKaggleBreakerState(
  username: string,
): { open: boolean; remainingSeconds: number; consecutiveFailures: number } {
  const s = breakers.get(username);
  if (!s) return { open: false, remainingSeconds: 0, consecutiveFailures: 0 };
  const remainingMs = Math.max(0, s.openUntil - Date.now());
  return {
    open: remainingMs > 0,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    consecutiveFailures: s.consecutiveFailures,
  };
}

function checkBreaker(username: string): void {
  const s = breakers.get(username);
  if (s && s.openUntil > Date.now()) {
    const remaining = Math.round((s.openUntil - Date.now()) / 1000);
    throw new KaggleRateLimitError(username, remaining, true);
  }
}

function recordResult(username: string, ok: boolean): void {
  const s = breakers.get(username) ?? { consecutiveFailures: 0, openUntil: 0 };
  if (ok) {
    s.consecutiveFailures = 0;
    s.openUntil = 0;
  } else {
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
      s.openUntil = Date.now() + OPEN_COOLDOWN_MS;
    }
  }
  breakers.set(username, s);
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests/i.test(msg);
}

async function guard<T>(username: string, fn: () => Promise<T>): Promise<T> {
  checkBreaker(username);
  try {
    const r = await budget.execute(fn);
    recordResult(username, true);
    return r;
  } catch (err) {
    if (isRateLimitError(err)) {
      recordResult(username, false);
      // Re-throw as a structured error so the tool wrapper can return a
      // deterministic JSON envelope to the LLM (instead of a raw text
      // tool error the model treats as transient and retries immediately).
      const after = checkBreakerState(username);
      throw new KaggleRateLimitError(
        username,
        after.remainingSeconds || 30,
        after.open,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}

function checkBreakerState(username: string): { open: boolean; remainingSeconds: number } {
  const s = breakers.get(username);
  if (!s) return { open: false, remainingSeconds: 0 };
  const remainingMs = Math.max(0, s.openUntil - Date.now());
  return { open: remainingMs > 0, remainingSeconds: Math.ceil(remainingMs / 1000) };
}

/**
 * Wrap a `KaggleAdapter` so every method goes through bounded retry + a
 * per-username circuit breaker. The underlying adapter is never mutated.
 */
export function wrapAdapterWithResilience(inner: KaggleAdapter): KaggleAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const creds = args[0] as KaggleCredentials | undefined;
        const username = creds?.username ?? '<unknown>';
        return guard(username, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      };
    },
  });
}

/** Test-only: reset the per-username breaker map. */
export function __resetBreakerStateForTests(): void {
  breakers.clear();
}
