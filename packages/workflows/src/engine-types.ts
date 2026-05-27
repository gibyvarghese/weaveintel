import type { EventBus, HumanTaskQueue, WorkflowPolicy, WorkflowAuditLog, DurableSleepStore } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';
import type { WorkflowRunRepository } from './run-repository.js';
import type { HandlerResolverRegistry } from './handler-resolver.js';
import type { WorkflowDefinitionStore } from './definition-store.js';
import type { ContractEmitter } from './contract-emitter.js';
import type { CostMeter } from './cost-meter.js';
import type { StepIdempotencyStore } from './idempotency-store.js';
import type { CircuitBreakerRegistry } from './circuit-breaker.js';
import type { BulkheadRegistry } from './bulkhead.js';
import type { PayloadStore } from './payload-store.js';
import type { StepLockStore } from './step-lock-store.js';

export interface WorkflowEngineOptions {
  checkpointStore?: CheckpointStore;
  bus?: EventBus;
  defaultPolicy?: WorkflowPolicy;
  /** Optional human task queue for human-task step integration. */
  humanTaskQueue?: HumanTaskQueue;
  /** Optional durable repository for workflow run state. */
  runRepository?: WorkflowRunRepository;
  /**
   * Phase 1 — Optional resolver registry. When set, any `step.handler`
   * containing a `:` (or matching a registered bare-kind resolver such as
   * `'noop'`) is resolved at run-start by the matching `HandlerResolver`.
   * Pre-registered handlers via `engine.registerHandler(...)` always win.
   */
  resolverRegistry?: HandlerResolverRegistry;
  /**
   * Phase 1 — Dependency bag forwarded to every resolver invocation.
   * Apps populate this with registries the resolvers need (tool registry,
   * prompt store, agent registry, MCP client, etc.).
   */
  resolverDeps?: Record<string, unknown>;
  /**
   * Phase 1 — Optional durable definition store. When set, `startRun` falls
   * back to the store if the requested workflowId is not in the in-memory
   * definition map, and `getDefinition` / `listDefinitions` consult both.
   */
  definitionStore?: WorkflowDefinitionStore;
  /**
   * Phase 4 — Optional contract emitter. When set and a workflow definition
   * declares an `outputContract`, the engine builds and emits the contract
   * after the run reaches `completed`. Emitter failures are swallowed (logged
   * via `bus`) so workflow runs never fail because of emission errors.
   */
  contractEmitter?: ContractEmitter;
  /**
   * Phase 5 — Optional cost meter. When set, the engine queries the meter
   * after each step. If the workflow's `WorkflowPolicy.costCeiling` is set
   * and the cumulative cost exceeds it, the run is failed with
   * `Cost ceiling exceeded` and a `workflow:cost_exceeded` event is emitted.
   * Callers (LLM adapters, tool wrappers) report deltas via `costMeter.record(runId, ...)`.
   */
  costMeter?: CostMeter;
  // ─── Phase W2 — Step Reliability ──────────────────────────────────────────
  /**
   * Phase W2 — Idempotency store. When set and a step declares
   * `step.idempotencyKey`, the engine checks the store before executing.
   * Cached output is replayed without calling the handler. Cache is written
   * after each successful handler completion. Key format: `${stepId}:${keyValue}`.
   */
  idempotencyStore?: StepIdempotencyStore;
  /**
   * Phase W2 — Circuit breaker registry. Maps handler kind → CircuitBreaker.
   * When a resolver-based step's handler kind has a registered circuit breaker,
   * the handler is wrapped: failures are counted, and when the threshold is
   * reached the circuit opens and subsequent calls fail fast.
   */
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  /**
   * Phase W2 — Bulkhead registry. Maps handler kind → Bulkhead.
   * When a resolver-based step's handler kind has a registered bulkhead,
   * the handler is wrapped to enforce per-kind concurrency limits.
   * Excess calls queue locally and run as capacity frees.
   */
  bulkheadRegistry?: BulkheadRegistry;
  // ─── Phase W3 — State and Data Layer ──────────────────────────────────────
  /**
   * Phase W3 — Large payload store. When set and a step output exceeds
   * `policy.maxInlineBytes` (JSON length), the engine offloads the output to
   * this store and writes `{ __payloadRef: key }` into `state.variables`
   * instead. Retrieve the full payload with `store.get(key)`.
   */
  payloadStore?: PayloadStore;
  /**
   * Phase W3 — Custom trace ID generator. Defaults to `newUUIDv7()`.
   * Override to integrate with an external tracing system (e.g. OpenTelemetry
   * span IDs).
   */
  traceIdGenerator?: () => string;
  // ─── Phase W4 — Durability and Recovery ───────────────────────────────────
  /**
   * Phase W4 — Exactly-once step execution store. When set, the engine
   * writes a `locked` record before each handler execution and upgrades to
   * `done` (with cached output) after success. On recovery, done steps are
   * replayed from cache instead of re-executing the handler.
   */
  stepLockStore?: StepLockStore;
  /**
   * Phase W4 — Durable sleep store. When set, `wait` steps that declare
   * `wakeAfterMs` schedule an automatic `resumeRun()` after that many
   * milliseconds. The wakeAt timestamp is persisted so it survives process
   * restarts. Pair with `DurableSleepScheduler` to poll for due records.
   */
  sleepStore?: DurableSleepStore;
  /**
   * Phase W4 — Immutable audit event log. When set, the engine appends a
   * `WorkflowAuditEvent` on every state transition: run started/completed/
   * failed, step started/locked/replayed/completed/failed, sleep scheduled/
   * resumed, child run cancelled. Query with `engine.listWorkflowEvents(runId)`.
   */
  auditLog?: WorkflowAuditLog;
}
