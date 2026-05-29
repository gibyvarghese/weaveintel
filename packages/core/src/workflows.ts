/**
 * @weaveintel/core — Workflow orchestration contracts
 */

// ─── Workflow Definition ─────────────────────────────────────

export type WorkflowStepType =
  | 'deterministic' | 'agentic' | 'branch' | 'loop' | 'condition' | 'wait' | 'parallel' | 'sub-workflow' | 'human-task'
  // Phase W1 — Control flow completeness
  | 'switch' | 'forEach' | 'fork' | 'join'
  // ─── Phase W7 — Dynamic Graph ───────────────────────────
  | 'dynamic';

export interface WorkflowStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  description?: string;
  /**
   * Handler reference. Three accepted forms:
   *   1. Bare key (e.g. `'echo'`) — looked up in the engine's registered handler map.
   *   2. Resolver-prefixed (e.g. `'tool:foo'`, `'prompt:bar'`, `'agent:baz'`,
   *      `'mcp:server:method'`, `'script:slug'`, `'subworkflow:wf-key'`,
   *      `'noop'`) — built into a runnable StepHandler at run-start time
   *      by the matching `HandlerResolver`.
   *   3. Omitted — falls back to the step `id` as the handler key.
   */
  handler?: string;
  config?: Record<string, unknown>;
  next?: string | string[];
  condition?: string;
  timeout?: number;
  retries?: number;
  /** Milliseconds to wait between retry attempts. */
  retryDelayMs?: number;
  /**
   * Phase 1 — Declarative input mapping.
   * Keys are paths into the *handler input object* (the `variables` arg
   * the handler receives). Values are dotted paths into the live
   * `WorkflowState.variables`. When set, the engine builds a fresh input
   * object from these mappings instead of passing the entire `variables`
   * object through. Example:
   *   { "competitionId": "kaggle.activeCompetition.id",
   *     "topic":         "input.topic" }
   */
  inputMap?: Record<string, string>;
  /**
   * Phase W1 — Error boundary. If this step fails (and all retries are
   * exhausted), execution jumps to this step ID instead of triggering global
   * saga compensation. The error is available as `__error` in variables.
   */
  onError?: string;
  /**
   * Phase W1 — Skip condition. JSONLogic-ish expression evaluated against
   * `state.variables`. If truthy the step is skipped; execution advances to
   * `next` without running the handler.
   */
  skipIf?: unknown;
  // ─── Phase W2 — Step Reliability ──────────────────────────────
  /**
   * Exponential backoff multiplier applied to `retryDelayMs` per attempt.
   * delay = min(retryDelayMs × multiplier^attempt, retryMaxDelayMs). Default 2.
   */
  retryBackoffMultiplier?: number;
  /** Cap on the computed exponential delay (ms). Default 30 000. */
  retryMaxDelayMs?: number;
  /** Add ±25 % random jitter to each retry delay to prevent thundering herd. Default false. */
  retryJitter?: boolean;
  /**
   * Total time budget (ms) across ALL retry attempts combined. When the
   * elapsed time since the first failure reaches this value, no further
   * retries are attempted.
   */
  globalTimeoutMs?: number;
  /**
   * Idempotency key expression (same JSONLogic syntax as skipIf). Evaluated
   * against `state.variables`. If a cached output exists for `stepId:keyValue`,
   * the handler is skipped and the cached output is replayed. Cache is
   * populated on successful handler completion.
   */
  idempotencyKey?: unknown;
  /**
   * Fallback handler key. When all retries are exhausted, this handler is
   * invoked instead of triggering onError/compensation. Its output is treated
   * as the step's successful output. If the fallback also throws, onError /
   * compensation logic takes over.
   */
  fallbackHandler?: string;
  /**
   * Phase W1 — Declarative output mapping.
   * Keys are dotted paths into `WorkflowState.variables` to write into.
   * Values are dotted paths into the handler's *return value*.
   * Example: { "kaggle.lastRunId": "id", "kaggle.lastStatus": "status" }
   */
  outputMap?: Record<string, string>;
  // ─── Phase W3 — State and Data Layer ──────────────────────────────────────
  /**
   * JSON-Schema-lite object to validate the step's output after completion.
   * Supports the same narrow subset as inputSchema: type, required,
   * properties, enum.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Action taken when `outputSchema` validation fails.
   * 'warn'   — emit `step:output_schema_warn` event, continue (default).
   * 'fail'   — mark step as failed with a schema error message.
   * 'coerce' — attempt type coercion on mismatched fields, then continue.
   */
  outputSchemaAction?: 'warn' | 'fail' | 'coerce';
  /**
   * Top-level field names in the step output to redact before the output is
   * written to run state, checkpoints, or event payloads.
   * Supports dot-notation for nested paths (e.g. `"auth.token"`).
   */
  maskFields?: string[];
  /**
   * Controls where the step output is stored after completion.
   * 'global' (default) — written to `state.variables.__step_{id}` and persisted.
   * 'step'             — written to `state.ephemeralVariables.__step_{id}` only;
   *                      available to the next step but NOT checkpointed or
   *                      written to the durable run record.
   */
  outputScope?: 'global' | 'step';
  /**
   * Phase W4 — Durable sleep duration for `wait` steps (milliseconds).
   * When set on a `wait` step the engine schedules an automatic `resumeRun()`
   * after this many milliseconds instead of requiring an external call.
   * The wakeAt timestamp is persisted so it survives process restarts.
   */
  wakeAfterMs?: number;
}

/**
 * Phase 4 — Mesh ↔ workflow binding.
 * Declarative output contract: when a run reaches `completed`, the engine
 * emits a typed contract via the configured `ContractEmitter`. The body is
 * built from `bodyMap` (keys = dotted paths into the contract body, values
 * = dotted paths into `WorkflowState.variables` — same semantics as
 * `outputMap` on a step). When `evidence.fromHistory` is true, the
 * full step history is attached as evidence.
 */
export interface WorkflowOutputContract {
  kind: string;
  bodyMap?: Record<string, string>;
  evidence?: { fromHistory?: boolean };
  meshId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  steps: WorkflowStep[];
  entryStepId: string;
  metadata?: Record<string, unknown>;
  /** Phase 4 — emit a typed mesh contract on successful completion. */
  outputContract?: WorkflowOutputContract;
  /**
   * Phase 5 — Optional JSON-Schema-lite shape describing the expected
   * `input` for `engine.startRun(workflowId, input)`. When set, the
   * engine validates the input before creating a run and rejects
   * malformed inputs with a structured error. Supports a deliberately
   * narrow subset: `type` (string/number/boolean/object/array/null),
   * `required`, `properties`, `enum`. See input-validator.ts.
   */
  inputSchema?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Workflow Runtime ────────────────────────────────────────

export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowState {
  currentStepId: string;
  variables: Record<string, unknown>;
  history: WorkflowStepResult[];
  checkpointId?: string;
  /**
   * Phase W3 — Ephemeral step-local variables.
   * Populated when a step runs with `outputScope: 'step'`. Available to the
   * immediately following step handler but NOT persisted to checkpoints or
   * the run repository. Cleared at the start of every step.
   */
  ephemeralVariables?: Record<string, unknown>;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  state: WorkflowState;
  startedAt: string;
  completedAt?: string;
  error?: string;
  /**
   * Phase 5 — Cumulative cost (USD) attributed to this run by the engine's
   * `CostMeter`. Updated at every step boundary. Persisted by repositories
   * that support a `cost_total` column.
   */
  costTotal?: number;
  /**
   * Phase W3 — Distributed trace ID propagated through all steps.
   * Generated at run start if not supplied by the caller.
   */
  traceId?: string;
  /**
   * Phase W3 — Tenant identifier for multi-tenant deployments.
   * Forwarded into `__ctx` on every step handler invocation.
   */
  tenantId?: string;
  /**
   * Phase W4 — ID of the parent run that spawned this run as a sub-workflow.
   * Set automatically when the engine starts a child run via the subworkflow
   * resolver; used for depth-first cancellation propagation.
   */
  parentRunId?: string;
  /**
   * Phase W4 — IDs of all direct child sub-workflow runs spawned by this run.
   * Used by `cancelRun()` to cascade cancellation depth-first.
   */
  childRunIds?: string[];
  // ─── Phase W5 — Governance ────────────────────────────────────────────────
  /**
   * Phase W5 — Run priority (0–9, higher = higher priority). Used when the
   * concurrency limit is reached and runs are buffered in the run queue.
   */
  priority?: number;
  /**
   * Phase W5 — Per-handler-key cost accumulation. Step outputs that include a
   * top-level `__cost: number` field have that value extracted and added here
   * under the step's handler key. Enables per-resolver-kind cost visibility
   * beyond the global `costTotal` ceiling check.
   */
  costBreakdown?: Record<string, number>;
  // ─── Phase W7 — Dynamic Graph ─────────────────────────────────────────────
  /**
   * Phase W7 — Immutable snapshot of the workflow definition captured at
   * `startRun` time. The engine uses this for all step lookups and routing
   * during the run, so edits to the live definition store after the run starts
   * have no effect on in-flight execution or replay. Persisted by the run
   * repository so it survives process restarts.
   */
  definitionSnapshot?: WorkflowDefinition;
  /**
   * Phase W7 — Steps appended to the run's effective graph at runtime by
   * `dynamic` steps. Stored on the run and checkpointed so sub-graph
   * execution is restart-safe.
   */
  dynamicSteps?: WorkflowStep[];
  /**
   * Phase W7 — Number of times a `dynamic` step has spliced a sub-graph into
   * this run. Used to enforce `policy.maxExpansionDepth`.
   */
  expansionDepth?: number;
}

/**
 * Phase W3 — Execution context injected as `__ctx` into every step's
 * variables map. Enables handlers to forward correlation IDs to downstream
 * services without manually threading them through workflow input.
 */
export interface StepContext {
  traceId: string;
  tenantId?: string;
  runId: string;
  stepId: string;
  /** 1-based attempt number; > 1 on retries. */
  attempt: number;
}

export interface WorkflowCheckpoint {
  id: string;
  runId: string;
  /** ID of the workflow definition this run belongs to. Required for post-restart recovery. */
  workflowId?: string;
  stepId: string;
  state: WorkflowState;
  createdAt: string;
}

// ─── Triggers & Scheduling ───────────────────────────────────

export type WorkflowTriggerType = 'manual' | 'cron' | 'event' | 'webhook';

export interface WorkflowTrigger {
  id: string;
  workflowId: string;
  type: WorkflowTriggerType;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface WorkflowScheduler {
  schedule(trigger: WorkflowTrigger): Promise<void>;
  cancel(triggerId: string): Promise<void>;
  list(workflowId: string): Promise<WorkflowTrigger[]>;
}

// ─── Policies & Compensation ─────────────────────────────────

export interface WorkflowPolicy {
  maxDuration?: number;
  maxSteps?: number;
  maxRetries?: number;
  requireApprovalForSteps?: string[];
  costCeiling?: number;
  /**
   * Phase W3 — Maximum number of bytes (JSON-serialised) a step output may
   * occupy inline in `state.variables`. Outputs exceeding this threshold are
   * offloaded to the configured `PayloadStore` and replaced by a reference
   * object `{ __payloadRef: key }`.  Default: unlimited (no offload).
   */
  maxInlineBytes?: number;
  // ─── Phase W5 — Governance ────────────────────────────────────────────────
  /**
   * Phase W5 — Maximum number of simultaneously active (running or paused)
   * runs for this workflow definition. When the limit is reached, `startRun()`
   * throws `WorkflowConcurrencyError` unless a `runQueue` is configured on the
   * engine, in which case the run is buffered and started as capacity frees.
   */
  maxConcurrentRuns?: number;
  /**
   * Phase W5 — Maximum number of new runs that may be started per minute for
   * this workflow definition. Enforced via a per-definition token bucket.
   * Exceeding this limit causes `startRun()` to throw `WorkflowRateLimitError`.
   */
  maxRunsPerMinute?: number;
  // ─── Phase W7 — Dynamic Graph ─────────────────────────────────────────────
  /**
   * Phase W7 — Allowlist of handler kinds that generated steps (from `dynamic`
   * expansions) may use. Defaults to `['noop', 'tool', 'prompt', 'agent', 'mcp']`
   * when not set. `'script'` and `'subworkflow'` are intentionally excluded by
   * default; add them explicitly if your threat model allows it.
   */
  dynamicHandlerKinds?: string[];
  /**
   * Phase W7 — Maximum total number of steps that may be generated across all
   * `dynamic` expansions within a single run. Enforced by `validateExpansion`.
   */
  maxGeneratedSteps?: number;
  /**
   * Phase W7 — Maximum number of `dynamic` step expansions permitted per run
   * (i.e., the maximum value of `run.expansionDepth`). Default: 5.
   */
  maxExpansionDepth?: number;
}

// ─── Phase W7 — Dynamic Graph ───────────────────────────────────────────────

/**
 * Phase W7 — The value returned by a `dynamic` step's handler.
 * The engine splices `steps` into the run's effective graph and immediately
 * routes execution into `entry`. When the sub-graph terminates, control
 * returns to `rejoin` (or the dynamic step's `next` if `rejoin` is omitted).
 */
export interface DynamicExpansion {
  /** Steps to append to the run's effective graph. IDs must not collide with existing steps. */
  steps: WorkflowStep[];
  /** ID of the first step to execute in the generated sub-graph. Must be in `steps`. */
  entry: string;
  /**
   * Step ID to jump to when the generated sub-graph terminates (its final step
   * has no `next`). Defaults to the `dynamic` step's own `next` when omitted.
   */
  rejoin?: string;
}

export interface WorkflowCompensation {
  stepId: string;
  handler: string;
  description?: string;
}

// ─── Events ──────────────────────────────────────────────────

export type WorkflowEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:paused'
  | 'workflow:contract_emitted'
  | 'workflow:cost_exceeded'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:output_schema_warn'
  | 'step:payload_offloaded'
  | 'approval:requested'
  | 'approval:received'
  // Phase W4 — Durability and Recovery
  | 'step:locked'
  | 'step:replayed'
  | 'run:sleep_scheduled'
  | 'run:sleep_resumed'
  | 'run:cancelled_child';

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  stepId?: string;
  timestamp: string;
  data?: unknown;
}

// ─── Phase W4 — Audit Log ────────────────────────────────────

/**
 * Immutable append-only record of a single workflow engine state transition.
 * Written by the engine on every step start/complete/fail, run start/complete/fail,
 * sleep, resume, and cancellation. Forms a causal history of the run.
 */
export interface WorkflowAuditEvent {
  id: string;
  runId: string;
  workflowId: string;
  type: string;            // WorkflowEventType or custom extension
  stepId?: string;
  timestamp: string;       // ISO-8601
  traceId?: string;
  tenantId?: string;
  /** ID of the event that directly triggered this one (e.g. step:locked → step:replayed). */
  causedBy?: string;
  data?: Record<string, unknown>;
}

export interface WorkflowAuditLog {
  append(event: Omit<WorkflowAuditEvent, 'id'>): Promise<void>;
  list(runId: string): Promise<WorkflowAuditEvent[]>;
  listAll(opts?: { workflowId?: string; limit?: number }): Promise<WorkflowAuditEvent[]>;
}

// ─── Phase W4 — Durable Sleep ────────────────────────────────

export interface SleepRecord {
  runId: string;
  wakeAt: number;         // epoch ms
  createdAt: string;      // ISO-8601
}

export interface DurableSleepStore {
  schedule(runId: string, wakeAt: number): Promise<void>;
  cancel(runId: string): Promise<void>;
  getDue(now?: number): Promise<SleepRecord[]>;
  list(): Promise<SleepRecord[]>;
}

// ─── Phase W5 — Governance Errors ────────────────────────────

/** Thrown by `startRun()` when `policy.maxConcurrentRuns` is exceeded and no run queue is configured. */
export class WorkflowConcurrencyError extends Error {
  constructor(public readonly workflowId: string, public readonly activeCount: number, public readonly limit: number) {
    super(`Workflow "${workflowId}" concurrency limit exceeded: ${activeCount}/${limit} active runs`);
    this.name = 'WorkflowConcurrencyError';
  }
}

/** Thrown by `startRun()` when `policy.maxRunsPerMinute` token bucket is exhausted. */
export class WorkflowRateLimitError extends Error {
  constructor(public readonly workflowId: string, public readonly limitPerMinute: number) {
    super(`Workflow "${workflowId}" rate limit exceeded: ${limitPerMinute} runs/min`);
    this.name = 'WorkflowRateLimitError';
  }
}

// ─── Approval Tasks ──────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface WorkflowApprovalTask {
  id: string;
  runId: string;
  stepId: string;
  description: string;
  status: ApprovalStatus;
  assignee?: string;
  data?: unknown;
  decision?: unknown;
  createdAt: string;
  decidedAt?: string;
}

// ─── Engine ──────────────────────────────────────────────────

export interface WorkflowEngine {
  createDefinition(def: WorkflowDefinition): Promise<WorkflowDefinition>;
  getDefinition(id: string): Promise<WorkflowDefinition | null>;
  listDefinitions(): Promise<WorkflowDefinition[]>;
  startRun(workflowId: string, input?: Record<string, unknown>, opts?: { traceId?: string; tenantId?: string; parentRunId?: string; priority?: number }): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  resumeRun(runId: string, data?: unknown): Promise<WorkflowRun>;
  cancelRun(runId: string): Promise<void>;
  listRuns(workflowId?: string): WorkflowRun[];
  /**
   * Recover a run after process restart by replaying from the latest checkpoint.
   * Returns null if no checkpoint exists for the given runId.
   */
  recoverRun(runId: string): Promise<WorkflowRun | null>;
  /**
   * Phase W4 — Return the full immutable audit event history for a run.
   * Returns an empty array when no audit log is configured.
   */
  listWorkflowEvents(runId: string): Promise<WorkflowAuditEvent[]>;
  /**
   * Phase W6 — Return a full execution trace for a run (spans + summary).
   * Returns null if the run does not exist.
   */
  getRunTrace(runId: string): Promise<RunTrace | null>;
  /**
   * Phase W6 — Re-execute a run from scratch (or from a specific step),
   * optionally overriding specific step outputs. Returns the new run.
   */
  replayRun(runId: string, opts?: ReplayRunOpts): Promise<WorkflowRun>;
}

// ─── Phase W6 — Observability and DX ─────────────────────────

/** Status a span can report. */
export type SpanStatus = 'completed' | 'failed' | 'skipped' | 'paused';

/**
 * A single step execution record emitted by the engine after each step.
 * Modelled after OpenTelemetry spans — `startedAt`/`completedAt` are Unix ms.
 */
export interface WorkflowSpan {
  runId: string;
  workflowId: string;
  stepId: string;
  /** Resolver kind: 'noop' | 'tool' | 'script' | 'agent' | 'prompt' | 'mcp' | 'subworkflow' | step.type */
  handlerKind: string;
  /** The raw handler string (e.g. 'tool:web.search' or the step ID for inline). */
  handlerKey: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  status: SpanStatus;
  /** Number of retry attempts made (0 = no retries). */
  retryCount: number;
  /** Cost in USD contributed by this step (from __cost extraction). */
  costUsd: number;
  /** Error message if status === 'failed'. */
  error?: string;
  /** Arbitrary key-value attributes (traceId, tenantId, etc.). */
  attributes: Record<string, string | number | boolean>;
}

/**
 * Full execution trace for a workflow run — spans ordered by execution,
 * plus summary metadata.
 */
export interface RunTrace {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  startedAt: string;
  completedAt?: string;
  totalDurationMs: number;
  costTotal: number;
  costBreakdown: Record<string, number>;
  spans: WorkflowSpan[];
}

/** Emitter interface — apps plug in memory, file, or DB backends. */
export interface WorkflowSpanEmitter {
  emit(span: WorkflowSpan): void | Promise<void>;
  getSpans(runId: string): Promise<WorkflowSpan[]>;
  getAllSpans(): Promise<WorkflowSpan[]>;
  clear(runId: string): Promise<void>;
}

/** Severity of a linter finding. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** A single finding from `lintWorkflow()`. */
export interface LintResult {
  severity: LintSeverity;
  /** The step ID the finding applies to, if any. */
  stepId?: string;
  message: string;
  /** Machine-readable rule identifier. */
  rule: string;
}

/** A workflow adjacency list suitable for rendering a visual graph. */
export interface WorkflowGraphNode {
  id: string;
  name: string;
  type: WorkflowStepType;
  handler?: string;
  isEntry: boolean;
  isTerminal: boolean;
}

export interface WorkflowGraphEdge {
  from: string;
  to: string;
  /** Edge label — 'true'/'false' for condition, case value for branch/switch. */
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  entryStepId: string;
  /** Step IDs unreachable from the entry step. */
  unreachableStepIds: string[];
}

/** Options for `replayRun()`. */
export interface ReplayRunOpts {
  /**
   * Re-execute from this step onward using live handlers.
   * Steps before this step replay their recorded outputs from the run history.
   */
  fromStepId?: string;
  /**
   * Per-step output overrides. Key = stepId, value = the output to inject.
   * Takes precedence over both recorded history and live handlers.
   */
  overrides?: Record<string, unknown>;
  /** Tenant ID for the new replay run (defaults to original run's tenantId). */
  tenantId?: string;
}
