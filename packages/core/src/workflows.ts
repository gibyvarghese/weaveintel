/**
 * @weaveintel/core — Workflow orchestration contracts
 */

// ─── Workflow Definition ─────────────────────────────────────

export type WorkflowStepType = 'deterministic' | 'agentic' | 'branch' | 'loop' | 'condition' | 'wait' | 'parallel' | 'sub-workflow';

export interface WorkflowStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  description?: string;
  handler?: string;
  config?: Record<string, unknown>;
  next?: string | string[];
  condition?: string;
  timeout?: number;
  retries?: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  steps: WorkflowStep[];
  entryStepId: string;
  metadata?: Record<string, unknown>;
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
}

export interface WorkflowCheckpoint {
  id: string;
  runId: string;
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
}
