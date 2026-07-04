# @weaveintel/resilience

**Wraps a flaky call — an LLM, an API, a queue handler — so retries, rate limits, circuit breakers, and durability rules apply consistently.**

## Why it exists

Every network call eventually fails: a provider rate-limits you, a service goes down, the same request arrives twice. Handling each of these by hand, per endpoint, leads to subtle bugs — you retry something that shouldn't be retried, or hammer a service that's already on the floor. Think of this package as the guardrails and speed bumps on a mountain road: they don't drive the car, but they keep it from going over the edge when things go wrong. You describe the endpoint once, and every call through it gets the same protection.

## When to reach for it

Reach for it when a call can fail transiently and you want retry, backoff, rate limiting, or a circuit breaker — plus operational durability like idempotency keys, dead-letter capture, and health checks. It guards *how* a call runs; if you need to decide whether a call is *allowed* on safety or spend grounds, that's `@weaveintel/guardrails` or `@weaveintel/cost-governor`.

## How to use it

```ts
import { createResilientCallable, PROVIDER_RESILIENCE_DEFAULTS } from '@weaveintel/resilience';

const callModel = createResilientCallable({
  key: 'openai:chat',
  retry: PROVIDER_RESILIENCE_DEFAULTS.retry,
  circuit: PROVIDER_RESILIENCE_DEFAULTS.circuit,
});

// retried, rate-limited, and circuit-protected automatically
const answer = await callModel(() => fetch('https://api.example.com/v1/chat'));
```

## What's in the box

Per-call guards:

- `createResilientCallable` / `runResilient` — compose retry + rate limit + circuit breaker + concurrency into one callable.
- `createCircuitBreaker`, `createRetryPolicy`, `createTokenBucket`, `createKeyedRateLimiter`, `createConcurrencyLimiter` — the individual guards.
- `createLatencyTracker`, `createThroughputTracker` — p95/p99 latency and adaptive-budget signals.
- `createResilienceSignalBus` — subscribe to normalized signals (retry, open circuit, throttle) so apps can react.

Operational durability (absorbed from the former reliability + durability packages):

- Idempotency, retry-budget, dead-letter, backpressure, health, and a queue-based durable concurrency limiter.
- `getOrCreateEndpointState` / `createDurableEndpointRegistry` — per-endpoint state, in memory or durable.
- `PROVIDER_RESILIENCE_DEFAULTS` — the shared retry/circuit settings all built-in LLM providers use.

## License

MIT.
