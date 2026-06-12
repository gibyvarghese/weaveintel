/**
 * @weaveintel/core — Human-in-the-loop contracts
 */

// ─── Task Types ──────────────────────────────────────────────

export type HumanTaskStatus = 'pending' | 'assigned' | 'in-review' | 'completed' | 'rejected' | 'expired' | 'escalated';
/**
 * `action-item` is a non-blocking task: it never suspends execution.
 * Completing or cancelling one emits `task.completed` / `task.cancelled` bus
 * events carrying provenance so downstream agents and triggers can react.
 */
export type HumanTaskType = 'approval' | 'review' | 'escalation' | 'input' | 'classification' | 'action-item';
export type HumanTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// ─── Provenance ──────────────────────────────────────────────

/**
 * Tracks who or what originated a task so clients can deep-link back to the
 * source run or surface the task in the right context.
 */
export interface TaskProvenance {
  /** Run that triggered this task, if any. */
  sourceRunId?: string;
  /** Sub-reference within that run (step id, tool call id, etc.). */
  sourceRef?: string;
  /** Who created the task. */
  createdBy: 'agent' | 'principal' | 'system';
}

export interface HumanTask {
  id: string;
  type: HumanTaskType;
  title: string;
  description?: string;
  status: HumanTaskStatus;
  priority: HumanTaskPriority;
  assignee?: string;
  data?: unknown;
  result?: unknown;
  workflowRunId?: string;
  workflowStepId?: string;
  slaDeadline?: string;
  createdAt: string;
  completedAt?: string;
  /**
   * Whether this task suspends the caller until resolved.
   * Defaults to `true` for all existing types (`approval`, `review`,
   * `escalation`, `input`, `classification`).  MUST be `false` for
   * `action-item` tasks — they are informational and never block execution.
   */
  blocking?: boolean;
  /**
   * Origin of this task.  Always set when `type === 'action-item'`;
   * optional but recommended for audit on other types.
   */
  provenance?: TaskProvenance;
  /**
   * Due date for the task (ISO-8601).  Distinct from `slaDeadline` which
   * drives escalation SLA timers for blocking tasks.  For `action-item`
   * tasks this is the soft completion target shown to the assignee.
   */
  dueAt?: string;
}

// ─── Specific Task Types ─────────────────────────────────────

export interface ApprovalTask extends HumanTask {
  type: 'approval';
  data: {
    action: string;
    context: Record<string, unknown>;
    riskLevel?: string;
    estimatedImpact?: string;
  };
  result?: {
    approved: boolean;
    reason?: string;
    conditions?: string[];
  };
}

export interface ReviewTask extends HumanTask {
  type: 'review';
  data: {
    content: string;
    contentType: string;
    criteria: string[];
    originalInput?: string;
  };
  result?: {
    approved: boolean;
    feedback: string;
    score?: number;
    corrections?: string;
  };
}

export interface EscalationTask extends HumanTask {
  type: 'escalation';
  data: {
    reason: string;
    originalTaskId?: string;
    agentId?: string;
    failureDetails?: string;
  };
  result?: {
    resolution: string;
    action: 'retry' | 'override' | 'cancel' | 'reassign';
    overrideData?: unknown;
  };
}

// ─── Decision ────────────────────────────────────────────────

export interface HumanDecision {
  taskId: string;
  decidedBy: string;
  decision: string;
  reason?: string;
  data?: unknown;
  decidedAt: string;
}

// ─── Queue ───────────────────────────────────────────────────

export interface HumanTaskQueue {
  enqueue(task: Omit<HumanTask, 'id' | 'createdAt'>): Promise<HumanTask>;
  dequeue(assignee: string): Promise<HumanTask | null>;
  get(taskId: string): Promise<HumanTask | null>;
  list(filter?: HumanTaskFilter): Promise<HumanTask[]>;
  complete(taskId: string, decision: HumanDecision): Promise<void>;
  /**
   * Reject a task (sets status to 'rejected'). Safe to call on any non-terminal task.
   */
  reject(taskId: string, decision: HumanDecision): Promise<void>;
  expire(taskId: string): Promise<void>;
}

export interface HumanTaskFilter {
  status?: HumanTaskStatus[];
  type?: HumanTaskType[];
  assignee?: string;
  priority?: HumanTaskPriority[];
  workflowRunId?: string;
}

// ─── Policy ──────────────────────────────────────────────────

export interface HumanTaskPolicy {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  taskType: HumanTaskType;
  defaultPriority: HumanTaskPriority;
  slaHours?: number;
  autoEscalateAfterHours?: number;
  assignmentStrategy: 'round-robin' | 'least-busy' | 'specific-user' | 'role-based';
  assignTo?: string;
  enabled: boolean;
}
