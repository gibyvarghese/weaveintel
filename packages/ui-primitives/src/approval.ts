/**
 * @weaveintel/ui-primitives — Approval UI payload builder
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalUiPayload } from '@weaveintel/core';

export interface ApprovalAction {
  label: string;
  value: string;
  style?: 'primary' | 'danger' | 'secondary';
}

export interface CreateApprovalOptions {
  title: string;
  description: string;
  riskLevel?: string;
  actions?: ApprovalAction[];
  context?: Record<string, unknown>;
  deadline?: Date | string;
}

/**
 * Build an ApprovalUiPayload with sensible defaults.
 * If no actions are provided, defaults to Approve (primary) + Reject (danger).
 */
export function createApprovalPayload(opts: CreateApprovalOptions): ApprovalUiPayload {
  const defaultActions: ApprovalAction[] = [
    { label: 'Approve', value: 'approve', style: 'primary' },
    { label: 'Reject', value: 'reject', style: 'danger' },
  ];

  return {
    taskId: randomUUID(),
    title: opts.title,
    description: opts.description,
    riskLevel: opts.riskLevel,
    actions: opts.actions ?? defaultActions,
    context: opts.context,
    deadline: opts.deadline
      ? (opts.deadline instanceof Date ? opts.deadline.toISOString() : opts.deadline)
      : undefined,
  };
}

/**
 * Convenience: create an approval for a tool call that needs human review.
 */
export function toolApproval(
  toolName: string,
  args: Record<string, unknown>,
  riskLevel: string = 'medium',
): ApprovalUiPayload {
  return createApprovalPayload({
    title: `Approve tool: ${toolName}`,
    description: `The agent wants to call "${toolName}" with the provided arguments. Please review.`,
    riskLevel,
    context: { toolName, args },
  });
}

/**
 * Convenience: create a workflow step approval.
 */
export function workflowApproval(
  workflowName: string,
  stepName: string,
  details: string,
  riskLevel: string = 'high',
): ApprovalUiPayload {
  return createApprovalPayload({
    title: `Workflow approval: ${workflowName}`,
    description: details,
    riskLevel,
    context: { workflowName, stepName },
  });
}
