/**
 * @weaveintel/core — Workflow orchestration contracts
 */

// ─── Workflow Definition ─────────────────────────────────────

export type WorkflowStepType =
  | 'deterministic' | 'agentic' | 'branch' | 'loop' | 'condition' | 'wait' | 'parallel' | 'sub-workflow' | 'human-task'
  // Phase W1 — Control flow completeness
  | 'switch' | 'forEach' | 'fork' | 'join';

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
  | 'approval:received';

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  stepId?: string;
  timestamp: string;
  data?: unknown;
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
  startRun(workflowId: string, input?: Record<string, unknown>, opts?: { traceId?: string; tenantId?: string }): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  resumeRun(runId: string, data?: unknown): Promise<WorkflowRun>;
  cancelRun(runId: string): Promise<void>;
  listRuns(workflowId?: string): WorkflowRun[];
  /**
   * Recover a run after process restart by replaying from the latest checkpoint.
   * Returns null if no checkpoint exists for the given runId.
   */
  recoverRun(runId: string): Promise<WorkflowRun | null>;
}
