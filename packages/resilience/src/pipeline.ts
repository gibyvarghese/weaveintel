/**
 * @weaveintel/resilience — Pipeline composer
 *
 * `createResilientCallable(fn, opts)` wraps `fn` with the full resilience
 * pipeline:
 *
 *   1. Circuit breaker check     (open → throw CIRCUIT_OPEN, emit `shed`)
 *   2. Concurrency limiter slot   (queue full → throw OVERLOADED, emit `shed`)
 *   3. Rate limiter (token bucket, endpoint-scoped, process-wide)
 *      ('wait' mode blocks; 'fail-fast' throws immediately)
 *   4. Timeout                    (deadline composed with caller's signal)
 *   5. Execute fn
 *   6. On error → classifyError → retry decision (honours retryAfterMs)
 *      On RATE_LIMITED → pause the bucket so other callers also back off
 *   7. Update circuit state
 *   8. Emit signals on the bus throughout
 *
 * Endpoint identity is the unit of sharing. Two callables registered with the
 * same `endpoint` share their token bucket, circuit, and concurrency state.
 */

import { WeaveIntelError, classifyError, type ClassifiedError } from '@weaveintel/core';
import { getOrCreateEndpointState, type EndpointStateOptions } from './endpoint-registry.js';
import { createRetryPolicy, type RetryPolicy, type RetryPolicyOptions } from './retry-policy.js';
import { getDefaultSignalBus, type ResilienceSignalBus } from './signal-bus.js';
import type { CallOverrides } from './types.js';

export interface ResilienceOptions extends EndpointStateOptions {
  /** Endpoint id — the key everything is shared on. e.g. `'openai:chat:gpt-4o'`. */
  readonly endpoint: string;
  readonly retry?: RetryPolicy | RetryPolicyOptions;
  /** Per-call timeout in ms. If unset, no timeout is enforced by the pipeline. */
  readonly timeoutMs?: number;
  /** Default rate-limit mode. `'wait'` (default) blocks; `'fail-fast'` throws. */
  readonly defaultRateLimitMode?: 'wait' | 'fail-fast';
  /** Bus to emit signals on. Defaults to the process-wide default bus. */
  readonly signalBus?: ResilienceSignalBus;
}

export type ResilientCallable<Args extends unknown[], R> = ((...args: Args) => Promise<R>) & {
  /** Run with per-call overrides (e.g. fail-fast for live-agent ticks). */
  withOverrides(overrides: CallOverrides): (...args: Args) => Promise<R>;
};

function isRetryPolicy(x: RetryPolicy | RetryPolicyOptions | undefined): x is RetryPolicy {
  return !!x && typeof (x as RetryPolicy).shouldRetry === 'function';
}

export function createResilientCallable<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  opts: ResilienceOptions,
): ResilientCallable<Args, R> {
  const state = getOrCreateEndpointState(opts.endpoint, {
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(opts.circuit ? { circuit: opts.circuit } : {}),
  });
  const retry: RetryPolicy = isRetryPolicy(opts.retry) ? opts.retry : createRetryPolicy(opts.retry ?? {});
  const bus = opts.signalBus ?? getDefaultSignalBus();
  const defaultMode: 'wait' | 'fail-fast' = opts.defaultRateLimitMode ?? 'wait';

  async function runOnce(args: Args, overrides: CallOverrides | undefined, attempt: number): Promise<R> {
    // 1. Circuit
    if (!overrides?.bypassCircuit && state.circuit) {
      const decision = state.circuit.canPass();
      if (!decision.allowed) {
        bus.emit({ kind: 'shed', endpoint: opts.endpoint, reason: 'circuit_open', at: Date.now() });
        throw new WeaveIntelError({
          code: 'CIRCUIT_OPEN',
          message: `Circuit open for endpoint ${opts.endpoint}`,
          retryable: false,
        });
      }
    }

    // 2. Concurrency
    let releaseConcurrency: (() => void) | undefined;
    if (state.concurrency) {
      try {
        releaseConcurrency = await state.concurrency.acquire();
      } catch {
        bus.emit({ kind: 'shed', endpoint: opts.endpoint, reason: 'queue_full', at: Date.now() });
        throw new WeaveIntelError({
          code: 'INTERNAL_ERROR',
          message: `Concurrency queue full for endpoint ${opts.endpoint}`,
          retryable: true,
        });
      }
    }

    try {
      // 3. Rate limit
      if (state.rateLimit) {
        const mode = overrides?.rateLimitMode ?? defaultMode;
        if (mode === 'fail-fast') {
          if (!state.rateLimit.tryAcquire()) {
            const waitMs = state.rateLimit.msUntilAvailable();
            bus.emit({ kind: 'shed', endpoint: opts.endpoint, reason: 'rate_limit', at: Date.now() });
            throw new WeaveIntelError({
              code: 'RATE_LIMITED',
              message: `Rate limit reached for endpoint ${opts.endpoint}`,
              retryable: true,
              retryAfterMs: waitMs,
            });
          }
        } else {
          await state.rateLimit.acquire(overrides?.timeoutMs ?? opts.timeoutMs);
        }
      }

      // 4. Timeout + 5. Execute
      const start = Date.now();
      try {
        const result = await maybeWithTimeout(
          () => fn(...args),
          overrides?.timeoutMs ?? opts.timeoutMs,
          opts.endpoint,
        );
        const durationMs = Date.now() - start;
        // 7. circuit success
        state.circuit?.recordSuccess();
        bus.emit({ kind: 'success', endpoint: opts.endpoint, attempt, durationMs, at: Date.now() });
        return result;
      } catch (err) {
        const durationMs = Date.now() - start;
        const classified = classifyError(err);

        // If upstream gave us a cooldown hint, pause the bucket so every
        // other caller in the process also backs off automatically.
        if (classified.cooldownHintMs !== undefined && state.rateLimit) {
          state.rateLimit.pauseFor(classified.cooldownHintMs);
        }

        if (classified.class === 'rate_limited') {
          bus.emit({
            kind: 'rate_limited',
            endpoint: opts.endpoint,
            retryAfterMs: classified.retryAfterMs ?? 0,
            attempt,
            at: Date.now(),
          });
        }

        // 7. circuit failure
        const cf = state.circuit?.recordFailure();
        if (cf?.transitionedToOpen) {
          bus.emit({
            kind: 'circuit_opened',
            endpoint: opts.endpoint,
            consecutiveFailures: cf.consecutiveFailures,
            cooldownMs: state.circuit!.snapshot().cooldownMs,
            at: Date.now(),
          });
        }

        bus.emit({
          kind: 'failed',
          endpoint: opts.endpoint,
          attempt,
          durationMs,
          cause: classified,
          at: Date.now(),
        });

        // re-throw the classified error's cause so callers get a WeaveIntelError
        throw classified.cause;
      }
    } finally {
      releaseConcurrency?.();
    }
  }

  async function executeWithRetry(args: Args, overrides: CallOverrides | undefined): Promise<R> {
    const maxAttempts =
      overrides?.maxRetries !== undefined ? overrides.maxRetries + 1 : retry.maxAttempts;
    let attempt = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await runOnce(args, overrides, attempt);
      } catch (err) {
        const classified = classifyError(err);
        const moreAttemptsLeft = attempt < maxAttempts;
        const shouldRetry = moreAttemptsLeft && retry.shouldRetry(classified, attempt);
        if (!shouldRetry) throw classified.cause;
        const nextDelayMs = retry.nextDelayMs(classified, attempt);
        bus.emit({
          kind: 'retrying',
          endpoint: opts.endpoint,
          attempt,
          nextDelayMs,
          cause: classified,
          at: Date.now(),
        });
        await sleep(nextDelayMs);
        attempt += 1;
      }
    }
  }

  const callable = ((...args: Args) => executeWithRetry(args, undefined)) as ResilientCallable<Args, R>;
  callable.withOverrides = (overrides: CallOverrides) => (...args: Args) =>
    executeWithRetry(args, overrides);
  return callable;
}

/** One-shot helper for ad-hoc resilient calls. */
export async function runResilient<R>(
  fn: () => Promise<R>,
  opts: ResilienceOptions,
  overrides?: CallOverrides,
): Promise<R> {
  const callable = createResilientCallable(fn, opts);
  return overrides ? callable.withOverrides(overrides)() : callable();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

async function maybeWithTimeout<R>(fn: () => Promise<R>, timeoutMs: number | undefined, endpoint: string): Promise<R> {
  if (timeoutMs === undefined) return fn();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<R>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new WeaveIntelError({
              code: 'TIMEOUT',
              message: `Endpoint ${endpoint} timed out after ${timeoutMs}ms`,
              retryable: true,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { ClassifiedError };
