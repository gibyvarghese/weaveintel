/**
 * @weaveintel/human-tasks — Task definitions
 *
 * Concrete helpers for creating typed human tasks (approval, review, escalation).
 */

import type {
  HumanTask,
  HumanTaskType,
  HumanTaskPriority,
  ApprovalTask,
  ReviewTask,
  EscalationTask,
} from '@weaveintel/core';
import { randomUUID } from 'node:crypto';

// ─── Task factory ────────────────────────────────────────────

export interface CreateTaskInput {
  type: HumanTaskType;
  title: string;
  description?: string;
  priority?: HumanTaskPriority;
  assignee?: string;
  data?: unknown;
  workflowRunId?: string;
  workflowStepId?: string;
  slaDeadline?: string;
}

export function createHumanTask(input: CreateTaskInput): HumanTask {
  return {
    id: randomUUID(),
    type: input.type,
    title: input.title,
    description: input.description,
    status: 'pending',
    priority: input.priority ?? 'normal',
    assignee: input.assignee,
    data: input.data,
    result: undefined,
    workflowRunId: input.workflowRunId,
    workflowStepId: input.workflowStepId,
    slaDeadline: input.slaDeadline,
    createdAt: new Date().toISOString(),
    completedAt: undefined,
  };
}

// ─── Typed factories ─────────────────────────────────────────

export interface CreateApprovalInput {
  title: string;
  description?: string;
  action: string;
  context: Record<string, unknown>;
  riskLevel?: string;
  estimatedImpact?: string;
  priority?: HumanTaskPriority;
  assignee?: string;
  workflowRunId?: string;
  workflowStepId?: string;
  slaDeadline?: string;
}

export function createApprovalTask(input: CreateApprovalInput): ApprovalTask {
  return {
    ...createHumanTask({
      type: 'approval',
      title: input.title,
      description: input.description,
      priority: input.priority,
      assignee: input.assignee,
      workflowRunId: input.workflowRunId,
      workflowStepId: input.workflowStepId,
      slaDeadline: input.slaDeadline,
      data: {
        action: input.action,
        context: input.context,
        riskLevel: input.riskLevel,
        estimatedImpact: input.estimatedImpact,
      },
    }),
    type: 'approval' as const,
    result: undefined,
    data: {
      action: input.action,
      context: input.context,
      riskLevel: input.riskLevel,
      estimatedImpact: input.estimatedImpact,
    },
  };
}

export interface CreateReviewInput {
  title: string;
  description?: string;
  content: string;
  contentType: string;
  criteria: string[];
  originalInput?: string;
  priority?: HumanTaskPriority;
  assignee?: string;
  workflowRunId?: string;
  workflowStepId?: string;
  slaDeadline?: string;
}

export function createReviewTask(input: CreateReviewInput): ReviewTask {
  return {
    ...createHumanTask({
      type: 'review',
      title: input.title,
      description: input.description,
      priority: input.priority,
      assignee: input.assignee,
      workflowRunId: input.workflowRunId,
      workflowStepId: input.workflowStepId,
      slaDeadline: input.slaDeadline,
      data: {
        content: input.content,
        contentType: input.contentType,
        criteria: input.criteria,
        originalInput: input.originalInput,
      },
    }),
    type: 'review' as const,
    result: undefined,
    data: {
      content: input.content,
      contentType: input.contentType,
      criteria: input.criteria,
      originalInput: input.originalInput,
    },
  };
}

export interface CreateEscalationInput {
  title: string;
  description?: string;
  reason: string;
  originalTaskId?: string;
  agentId?: string;
  failureDetails?: string;
  priority?: HumanTaskPriority;
  assignee?: string;
  workflowRunId?: string;
  workflowStepId?: string;
  slaDeadline?: string;
}

export function createEscalationTask(input: CreateEscalationInput): EscalationTask {
  return {
    ...createHumanTask({
      type: 'escalation',
      title: input.title,
      description: input.description,
      priority: input.priority ?? 'high',
      assignee: input.assignee,
      workflowRunId: input.workflowRunId,
      workflowStepId: input.workflowStepId,
      slaDeadline: input.slaDeadline,
      data: {
        reason: input.reason,
        originalTaskId: input.originalTaskId,
        agentId: input.agentId,
        failureDetails: input.failureDetails,
      },
    }),
    type: 'escalation' as const,
    result: undefined,
    data: {
      reason: input.reason,
      originalTaskId: input.originalTaskId,
      agentId: input.agentId,
      failureDetails: input.failureDetails,
    },
  };
}
