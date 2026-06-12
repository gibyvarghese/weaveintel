/**
 * @weaveintel/human-tasks — action-items.ts
 *
 * `action-item` tasks are non-blocking informational tasks that never suspend
 * execution. They always have `blocking: false` and require provenance.
 *
 * Invariant: `createActionItem` enforces `blocking: false`.
 * `completeActionItem` / `cancelActionItem` update the repository and emit
 * `task.completed` / `task.cancelled` bus events with the task's provenance.
 */

import type { HumanTask, TaskProvenance, HumanTaskPriority } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { HumanTaskRepository } from './repository.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateActionItemInput {
  title: string;
  description?: string;
  priority?: HumanTaskPriority;
  assignee?: string;
  /** Required — who/what created this action item and from which source. */
  provenance: TaskProvenance;
  /** Optional ISO 8601 due date. For display/reminder only — does not block. */
  dueAt?: string;
  data?: unknown;
}

/**
 * Creates an action-item task. Always has `blocking: false`.
 * Provenance is required — action items MUST trace their origin.
 */
export function createActionItem(input: CreateActionItemInput): HumanTask {
  return {
    id: newUUIDv7(),
    type: 'action-item',
    title: input.title,
    description: input.description,
    status: 'pending',
    priority: input.priority ?? 'normal',
    assignee: input.assignee,
    data: input.data,
    result: undefined,
    workflowRunId: input.provenance.sourceRunId,
    workflowStepId: undefined,
    slaDeadline: undefined,
    blocking: false,
    provenance: input.provenance,
    dueAt: input.dueAt,
    createdAt: new Date().toISOString(),
    completedAt: undefined,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle helpers with bus emission
// ---------------------------------------------------------------------------

interface MinimalBus {
  emit(event: {
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
    tenantId?: string;
  }): void;
}

export interface ActionItemLifecycleOptions {
  repository: HumanTaskRepository;
  bus?: MinimalBus;
  tenantId?: string;
}

/**
 * Marks an action-item task as completed.
 * Emits `task.completed` on the bus with the task's provenance.
 * Throws if the task is not found or is not an action-item.
 */
export async function completeActionItem(
  taskId: string,
  opts: ActionItemLifecycleOptions,
): Promise<HumanTask> {
  const task = await opts.repository.get(taskId);
  if (!task) throw new Error(`action-item task not found: ${taskId}`);
  if (task.type !== 'action-item') throw new Error(`task ${taskId} is type '${task.type}', not 'action-item'`);

  const updated: HumanTask = { ...task, status: 'completed', completedAt: new Date().toISOString() };
  await opts.repository.save(updated);

  opts.bus?.emit({
    type: 'task.completed',
    timestamp: Date.now(),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    data: {
      taskId: updated.id,
      taskType: 'action-item',
      provenance: updated.provenance ?? {},
    },
  });

  return updated;
}

/**
 * Marks an action-item task as cancelled.
 * Emits `task.cancelled` on the bus with the task's provenance.
 * Throws if the task is not found or is not an action-item.
 */
export async function cancelActionItem(
  taskId: string,
  opts: ActionItemLifecycleOptions,
): Promise<HumanTask> {
  const task = await opts.repository.get(taskId);
  if (!task) throw new Error(`action-item task not found: ${taskId}`);
  if (task.type !== 'action-item') throw new Error(`task ${taskId} is type '${task.type}', not 'action-item'`);

  const updated: HumanTask = { ...task, status: 'rejected', completedAt: new Date().toISOString() };
  await opts.repository.save(updated);

  opts.bus?.emit({
    type: 'task.cancelled',
    timestamp: Date.now(),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    data: {
      taskId: updated.id,
      taskType: 'action-item',
      provenance: updated.provenance ?? {},
    },
  });

  return updated;
}
