// SPDX-License-Identifier: MIT
/**
 * @weaveintel/durability
 *
 * Canonical package for durability primitives: idempotency keys, dead-letter
 * queue, retry budgets, health checks, backpressure, and concurrency guards.
 *
 * Phase 5 rename: `@weaveintel/reliability` was the original package name.
 * `@weaveintel/durability` is now the **canonical import** — it re-exports
 * everything from `@weaveintel/reliability` so existing adopters are not
 * broken. New code MUST import from `@weaveintel/durability`.
 *
 * Architectural boundary:
 *   - `@weaveintel/resilience`  — live per-call guard pipeline (token bucket,
 *     circuit breaker, concurrency limiter, retry policy, resilient callable).
 *   - `@weaveintel/durability`  — operational durability (idempotency, DLQ,
 *     retry budget, health, backpressure) that *uses* resilience for its
 *     internals but represents different concerns.
 */
export * from '@weaveintel/reliability';
