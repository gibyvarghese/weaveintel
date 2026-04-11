/**
 * @weaveintel/core — Human-in-the-loop contracts
 */

// ─── Task Types ──────────────────────────────────────────────

export type HumanTaskStatus = 'pending' | 'assigned' | 'in-review' | 'completed' | 'rejected' | 'expired' | 'escalated';
export type HumanTaskType = 'approval' | 'review' | 'escalation' | 'input' | 'classification';
export type HumanTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

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
