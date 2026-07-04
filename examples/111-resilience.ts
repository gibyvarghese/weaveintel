/**
 * Example 111 — Resilience Patterns
 *
 * Shows every mechanism in @weaveintel/resilience end-to-end with no
 * external services, no LLMs, and no API keys. All calls are simulated
 * with a lightweight stub function so you can see the failure/recovery
 * cycle in isolation.
 *
 * The problem this package solves
 * ───────────────────────────────
 * Production AI pipelines call many external endpoints (LLM APIs, tool
 * servers, embedding services). Each has its own failure modes:
 *   • Bursts of requests that exceed rate limits  → token bucket
 *   • Cascading failures when an endpoint is down  → circuit breaker
 *   • Thundering-herd reconnects after an outage   → retry with jitter
 *   • Concurrent runaway requests                  → concurrency limiter
 *   • Composition of all of the above per endpoint → endpoint registry
 *
 * @weaveintel/resilience packages these into composable primitives that
 * attach per-endpoint via the shared endpoint registry so all callers in
 * the same process automatically share state.
 *
 * Packages used:
 *   @weaveintel/resilience — token bucket, circuit breaker, retry policy,
 *                             concurrency limiter, endpoint registry,
 *                             resilience signal bus, createResilientCallable
 *
 * No API keys needed — runs entirely in-memory.
 *
 * Run: npx tsx examples/111-resilience.ts
 */

import {
  createTokenBucket,
  createCircuitBreaker,
  createRetryPolicy,
  createConcurrencyLimiter,
  createResilienceSignalBus,
  getOrCreateEndpointState,
  listEndpointStates,
  _resetEndpointRegistry,
  createResilientCallable,
  runResilient,
  type ResilienceSignal,
} from '@weaveintel/resilience';
import { WeaveIntelError, type ClassifiedError } from '@weaveintel/core';

/* ─── Helpers ──────────────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(62));
}

function ok(label: string) { console.log(`  ✓ ${label}`); }
function info(label: string) { console.log(`  ℹ ${label}`); }

/**
 * Build a WeaveIntelError that createResilientCallable will classify as
 * retryable. The pipeline passes errors through classifyError() from
 * @weaveintel/core — a plain Error is treated as non-retryable 'unknown'.
 * Use WeaveIntelError with code='PROVIDER_ERROR' and retryable=true to
 * simulate a transient upstream failure.
 */
function transientError(msg: string, opts: { retryAfterMs?: number } = {}): WeaveIntelError {
  return new WeaveIntelError({
    code: 'PROVIDER_ERROR',
    message: msg,
    retryable: true,
    retryAfterMs: opts.retryAfterMs,
  });
}

/** Non-retryable auth error — for demonstrating retry policy decisions. */
function authError(msg: string): WeaveIntelError {
  return new WeaveIntelError({ code: 'AUTH_FAILED', message: msg });
}

/** Dummy ClassifiedError for retry policy examples (not thrown through pipeline). */
function classifiedError(msg: string, opts: { retryable?: boolean; retryAfterMs?: number; class?: string } = {}): ClassifiedError {
  return { class: opts.class ?? 'transient', retryable: opts.retryable ?? true, retryAfterMs: opts.retryAfterMs, cause: new Error(msg) } as ClassifiedError;
}

/* ─── Reset shared registry so this example is idempotent ─────── */
_resetEndpointRegistry();

async function main() {

  /* ── 1. Token Bucket — burst control ─────────────────────────── */

  header('1. Token Bucket — burst rate-limiting');

  // createTokenBucket() creates a leaky-bucket rate limiter.
  //   capacity    — max burst (tokens the bucket holds when full)
  //   refillPerSec — tokens added per second (steady-state throughput)
  //
  // Use this to honour provider rate limits (e.g. OpenAI's 3 500 RPM for
  // gpt-4o) without complex per-caller counters. One bucket per endpoint,
  // shared across all callers via the endpoint registry (see section 5).
  const bucket = createTokenBucket({ capacity: 5, refillPerSec: 2 });

  let acquired = 0;
  for (let i = 0; i < 8; i++) {
    if (bucket.tryAcquire()) {
      acquired++;
    } else {
      info(`Token ${i + 1}: rejected — bucket empty (capacity=5, rapid fire)`);
      break;
    }
  }
  ok(`Acquired ${acquired} tokens before bucket was exhausted`);

  const snap = bucket.snapshot();
  info(`Bucket snapshot: tokens=${snap.tokens.toFixed(2)}, capacity=${snap.capacity}, refillPerSec=${snap.refillPerSec}`);

  // pauseFor() is driven by upstream Retry-After headers. When the provider
  // returns a 429 with "Retry-After: 5s", call bucket.pauseFor(5_000) to
  // prevent any further attempts for 5 seconds — no thundering-herd.
  bucket.pauseFor(100);
  ok(`Bucket paused for 100ms — tryAcquire → ${bucket.tryAcquire()} (expected false)`);

  /* ── 2. Circuit Breaker — stop cascading failures ─────────────── */

  header('2. Circuit Breaker — three-state FSM');

  // createCircuitBreaker() implements the classic three-state machine:
  //   closed    — normal; failures counted
  //   open      — all calls rejected until cooldown elapses
  //   half-open — one probe allowed; success → closed, failure → open
  //
  // Set failureThreshold low here (3) for the demo to trip quickly.
  // In production, tune based on your error rate tolerance.
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 300 });

  ok(`Initial state: ${breaker.state()}`); // closed

  // Simulate three consecutive failures
  for (let i = 0; i < 3; i++) {
    const { state, transitionedToOpen } = breaker.recordFailure();
    info(`Failure ${i + 1}: state=${state}, transitionedToOpen=${transitionedToOpen}`);
  }

  const check = breaker.canPass();
  ok(`After 3 failures: canPass → allowed=${check.allowed} (breaker is now open)`);

  if (check.allowed === false) {
    // 'reopensAt' is the epoch ms when the breaker will transition to half-open
    info(`Breaker reopens at: ${new Date(check.reopensAt).toISOString()}`);
  }

  // Wait for cooldown to expire so the breaker transitions to half-open
  await new Promise(r => setTimeout(r, 350));
  const halfOpenCheck = breaker.canPass();
  ok(`After cooldown: canPass → allowed=${halfOpenCheck.allowed} (half-open probe allowed)`);
  ok(`State after probe attempt: ${breaker.state()}`);

  // A successful probe closes the breaker again
  breaker.recordSuccess();
  ok(`After recordSuccess(): state=${breaker.state()} (back to closed)`);

  // Manual admin reset (e.g. after deploying a hotfix)
  breaker.reset();
  ok(`After reset(): state=${breaker.state()}`);

  /* ── 3. Retry Policy — exponential backoff with jitter ─────────── */

  header('3. Retry Policy — backoff with jitter');

  // createRetryPolicy() returns an object with shouldRetry() and nextDelayMs().
  // Default behaviour: retry up to maxAttempts on retryable errors, skip auth
  // and invalid_input errors (retrying those wastes quota and won't help).
  // jitter=true adds randomness to prevent thundering-herd reconnects.
  const retry = createRetryPolicy({
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    factor: 2,
    jitter: true,
  });

  ok(`maxAttempts=${retry.maxAttempts}, base=${retry.baseDelayMs}ms, factor=${retry.factor}, jitter=${retry.jitter}`);

  // Retryable upstream error (e.g. 500 from OpenAI)
  const retryableErr = classifiedError('upstream error', { retryable: true });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const will = retry.shouldRetry(retryableErr, attempt);
    const delay = retry.nextDelayMs(retryableErr, attempt);
    info(`Attempt ${attempt}: shouldRetry=${will}, nextDelay=${delay}ms`);
  }

  // Non-retryable auth error (e.g. 401 Unauthorized)
  const authErr = classifiedError('unauthorized', { retryable: false, class: 'auth' });
  ok(`Auth error (retryable=false): shouldRetry → ${retry.shouldRetry(authErr, 1)}`);

  // Provider-driven Retry-After (e.g. 429 with header "Retry-After: 30s")
  const rateLimitErr = classifiedError('rate limited', { retryable: true, retryAfterMs: 3_000 });
  ok(`Retry-After 3000ms: nextDelay → ${retry.nextDelayMs(rateLimitErr, 1)}ms (honours header)`);

  /* ── 4. Concurrency Limiter — cap parallel in-flight requests ──── */

  header('4. Concurrency Limiter — bounded parallelism');

  // createConcurrencyLimiter() caps how many async calls can run simultaneously.
  // Use this to avoid connection pool exhaustion and to stay within per-model
  // concurrency limits from your provider contract.
  //
  // acquire() → release pattern: call acquire() before work, call the returned
  // release() when done. This guarantees the slot is freed even on error.
  const limiter = createConcurrencyLimiter({ maxConcurrent: 3, maxQueue: 10 });

  // Launch 5 tasks with the limiter — only 3 may run at once
  const results: string[] = [];
  const tasks = Array.from({ length: 5 }, (_, i) =>
    (async () => {
      // acquire() blocks until a concurrency slot is available
      const release = await limiter.acquire();
      try {
        // Each task takes a small random duration
        await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
        results.push(`task-${i}`);
        return `done-${i}`;
      } finally {
        // Always release the slot (even if the task throws)
        release();
      }
    })(),
  );

  const settled = await Promise.allSettled(tasks);
  const fulfilled = settled.filter(s => s.status === 'fulfilled').length;
  ok(`5 tasks submitted with maxConcurrent=3 → ${fulfilled} completed`);
  info(`Completed tasks: ${results.join(', ')}`);
  info(`inFlight after completion: ${limiter.inFlight()} (should be 0)`);

  /* ── 5. Endpoint Registry — shared per-endpoint state ─────────── */

  header('5. Endpoint Registry — per-endpoint shared resilience state');

  // The endpoint registry is a process-wide singleton.
  // getOrCreateEndpointState() attaches a token bucket, circuit breaker, and
  // concurrency limiter to a logical "endpoint" name. All callers that use the
  // same endpoint name share state — so if one caller trips the breaker, ALL
  // callers in the process see it as open.
  //
  // In @weaveintel/resilience, providers call this automatically when making
  // model requests. You can also create your own endpoints for external HTTP
  // services your tools call.
  const openaiState = getOrCreateEndpointState('openai:gpt-4o', {
    rateLimit: { capacity: 100, refillPerSec: 10 },
    circuit: { failureThreshold: 5, cooldownMs: 60_000 },
    concurrency: { maxConcurrent: 20 },
  });

  const embeddingState = getOrCreateEndpointState('openai:text-embedding-3-small', {
    rateLimit: { capacity: 500, refillPerSec: 50 },
    circuit: { failureThreshold: 10, cooldownMs: 30_000 },
    concurrency: { maxConcurrent: 50 },
  });

  ok(`Registered endpoint "openai:gpt-4o": circuit state=${openaiState.circuit?.state() ?? 'n/a'}, rateLimit capacity=${openaiState.rateLimit?.snapshot().capacity ?? 'n/a'}`);
  ok(`Registered endpoint "openai:text-embedding-3-small": circuit state=${embeddingState.circuit?.state() ?? 'n/a'}`);

  const all = listEndpointStates();
  ok(`listEndpointStates() → ${all.length} endpoints registered in this process`);
  for (const ep of all) {
    const circuitState = ep.circuit?.state() ?? 'n/a';
    const tokens = ep.rateLimit?.snapshot().tokens.toFixed(0) ?? 'n/a';
    info(`  endpoint="${ep.endpoint}", circuit=${circuitState}, bucket.tokens≈${tokens}`);
  }

  /* ── 6. Signal Bus — observable resilience events ─────────────── */

  header('6. Resilience Signal Bus — observable events');

  // createResilienceSignalBus() creates a lightweight pub/sub bus that emits
  // ResilienceSignal events whenever the circuit breaker trips, a retry fires,
  // or the token bucket rejects. Subscribe here to feed your observability
  // pipeline (logs, metrics, alerts) without coupling the resilience code to
  // your specific logging framework.
  const signalBus = createResilienceSignalBus();
  const signals: ResilienceSignal[] = [];

  // signalBus.on() subscribes to ALL signal kinds; returns an unsubscribe fn.
  // signalBus.onKind('circuit_opened', cb) listens to a specific kind.
  const unsub = signalBus.on((signal) => {
    signals.push(signal);
    const extra = 'attempt' in signal ? `, attempt=${signal.attempt}` : '';
    info(`Signal: kind=${signal.kind}, endpoint=${signal.endpoint}${extra}`);
  });

  // Emit signals (in production, createResilientCallable emits these automatically
  // as it runs through the circuit check, retry loop, and timeout handling)
  signalBus.emit({ kind: 'circuit_opened', endpoint: 'openai:gpt-4o', consecutiveFailures: 5, cooldownMs: 60_000, at: Date.now() });
  signalBus.emit({ kind: 'retrying', endpoint: 'openai:gpt-4o', attempt: 2, nextDelayMs: 500, cause: { class: 'transient', retryable: true, cause: new Error('upstream error') } as ClassifiedError, at: Date.now() });
  signalBus.emit({ kind: 'circuit_closed', endpoint: 'openai:gpt-4o', at: Date.now() });
  signalBus.emit({ kind: 'rate_limited', endpoint: 'openai:gpt-4o', retryAfterMs: 5_000, attempt: 1, at: Date.now() });

  ok(`Signal bus received ${signals.length} signals`);
  unsub(); // clean up listener

  /* ── 7. createResilientCallable — compose everything ──────────── */

  header('7. createResilientCallable — full composition');

  // createResilientCallable() is the high-level API that composes a token
  // bucket, circuit breaker, retry policy, and concurrency limiter into a
  // single callable. This is what @weaveintel providers use internally.
  // You can use it directly to wrap any async function with production-grade
  // resilience in a single call.

  let callCount = 0;
  const failUntil = 2; // first 2 calls will fail; 3rd succeeds

  const callable = createResilientCallable(
    // The async function being protected (e.g. an LLM API call)
    async (input: string): Promise<string> => {
      callCount++;
      if (callCount <= failUntil) {
        // Throw a WeaveIntelError so classifyError() marks it retryable.
        // A plain Error would be classified as 'unknown' and NOT retried.
        throw transientError('transient upstream failure');
      }
      return `response to: ${input}`;
    },
    {
      endpoint: 'demo:resilient-endpoint',
      rateLimit: { capacity: 20, refillPerSec: 5 },
      circuit: { failureThreshold: 10, cooldownMs: 5_000 },
      concurrency: { maxConcurrent: 5 },
      retry: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      signalBus,
    },
  );

  try {
    const result = await callable('Hello resilience!');
    ok(`Resilient call succeeded after ${callCount} attempts: "${result}"`);
  } catch (err) {
    info(`Call ultimately failed: ${(err as Error).message}`);
  }

  /* ── 8. runResilient — one-shot helper ────────────────────────── */

  header('8. runResilient — one-shot call with inline options');

  // runResilient() is a convenience wrapper for a single call without
  // needing to create a persistent callable. Use it for ad-hoc operations
  // like a one-time data migration that you still want retry logic for.
  let runCount = 0;
  try {
    const result = await runResilient(
      async () => {
        runCount++;
        if (runCount < 3) throw transientError('transient error');
        return 'success after retries';
      },
      {
        endpoint: 'demo:one-shot',
        retry: { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 50, jitter: false },
      },
    );
    ok(`runResilient succeeded on attempt ${runCount}: "${result}"`);
  } catch (err) {
    info(`runResilient ultimately failed: ${(err as Error).message}`);
  }

  /* ── Summary ──────────────────────────────────────────────────── */

  header('Summary — @weaveintel/resilience');
  console.log('  createTokenBucket      — burst rate-limiting with Retry-After pause support');
  console.log('  createCircuitBreaker   — closed → open → half-open FSM, endpoint-scoped');
  console.log('  createRetryPolicy      — exponential backoff with jitter, honours Retry-After');
  console.log('  createConcurrencyLimiter — bounded parallelism with timeout');
  console.log('  getOrCreateEndpointState — shared per-endpoint registry (all callers unified)');
  console.log('  createResilienceSignalBus — observable events for metrics & alerting');
  console.log('  createResilientCallable — compose all four primitives into one wrapper');
  console.log('  runResilient           — one-shot ad-hoc resilient call');
  console.log('\n  ✅ All resilience assertions passed — no API keys required.\n');
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
