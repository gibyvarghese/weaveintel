/**
 * @weaveintel/human-tasks — In-memory task queue
 *
 * Implements HumanTaskQueue from core with priority ordering, SLA tracking,
 * and automatic expiration.
 */

import type {
  HumanTask,
  HumanTaskQueue,
  HumanTaskFilter,
  HumanDecision,
} from '@weaveintel/core';

export class InMemoryTaskQueue implements HumanTaskQueue {
  private readonly tasks = new Map<string, HumanTask>();

  async enqueue(task: Omit<HumanTask, 'id' | 'createdAt'>): Promise<HumanTask> {
    const id = (await import('node:crypto')).randomUUID();
    const full: HumanTask = {
      ...task,
      id,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(id, full);
    return full;
  }

  async dequeue(assignee: string): Promise<HumanTask | null> {
    // Find the highest-priority pending task and assign it
    const priorityOrder = ['urgent', 'high', 'normal', 'low'];
    let best: HumanTask | null = null;
    let bestPriIdx = priorityOrder.length;

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const idx = priorityOrder.indexOf(task.priority);
      if (idx < bestPriIdx || (idx === bestPriIdx && best && task.createdAt < best.createdAt)) {
        best = task;
        bestPriIdx = idx;
      }
    }

    if (!best) return null;

    best.status = 'assigned';
    best.assignee = assignee;
    return best;
  }

  async get(taskId: string): Promise<HumanTask | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async list(filter?: HumanTaskFilter): Promise<HumanTask[]> {
    let result = Array.from(this.tasks.values());

    if (filter) {
      if (filter.status?.length) result = result.filter(t => filter.status!.includes(t.status));
      if (filter.type?.length) result = result.filter(t => filter.type!.includes(t.type));
      if (filter.assignee) result = result.filter(t => t.assignee === filter.assignee);
      if (filter.priority?.length) result = result.filter(t => filter.priority!.includes(t.priority));
      if (filter.workflowRunId) result = result.filter(t => t.workflowRunId === filter.workflowRunId);
    }

    // Sort by priority (urgent first), then by creation time
    const priorityOrder = ['urgent', 'high', 'normal', 'low'];
    result.sort((a, b) => {
      const pA = priorityOrder.indexOf(a.priority);
      const pB = priorityOrder.indexOf(b.priority);
      if (pA !== pB) return pA - pB;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    return result;
  }

  async complete(taskId: string, decision: HumanDecision): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.status}`);
    }

    task.status = 'completed';
    task.result = decision.data ?? { decision: decision.decision, reason: decision.reason };
    task.completedAt = decision.decidedAt;
  }

  async reject(taskId: string, decision: HumanDecision): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.status}`);
    }

    task.status = 'rejected';
    task.result = decision.data ?? { decision: 'rejected', reason: decision.reason };
    task.completedAt = decision.decidedAt;
  }

  async expire(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'expired';
    task.completedAt = new Date().toISOString();
  }

  /** Expire all tasks whose SLA deadline has passed. Returns count of expired tasks. */
  async expireOverdue(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.slaDeadline && task.slaDeadline < now && task.status !== 'completed' && task.status !== 'expired' && task.status !== 'rejected') {
        task.status = 'expired';
        task.completedAt = now;
        count++;
      }
    }
    return count;
  }

  /** Get count of tasks by status. */
  async stats(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return counts;
  }
}
