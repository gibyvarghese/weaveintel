/**
 * @weaveintel/core — Workflow orchestration contracts
 */

// ─── Workflow Definition ─────────────────────────────────────

export type WorkflowStepType = 'deterministic' | 'agentic' | 'branch' | 'loop' | 'condition' | 'wait' | 'parallel' | 'sub-workflow' | 'human-task';

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
   * Phase 1 — Declarative output mapping.
   * Keys are dotted paths into `WorkflowState.variables` to write into.
   * Values are dotted paths into the handler's *return value*.
   * Example: { "kaggle.lastRunId": "id", "kaggle.lastStatus": "status" }
   */
  outputMap?: Record<string, string>;
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
  startRun(workflowId: string, input?: Record<string, unknown>): Promise<WorkflowRun>;
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
