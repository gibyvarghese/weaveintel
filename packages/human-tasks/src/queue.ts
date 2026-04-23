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
import {
  type HumanTaskRepository,
  InMemoryHumanTaskRepository,
} from './repository.js';

export interface HumanTaskQueueOptions {
  repository?: HumanTaskRepository;
}

export class RepositoryBackedTaskQueue implements HumanTaskQueue {
  constructor(private readonly repository: HumanTaskRepository) {}

  async enqueue(task: Omit<HumanTask, 'id' | 'createdAt'>): Promise<HumanTask> {
    const id = (await import('node:crypto')).randomUUID();
    const full: HumanTask = {
      ...task,
      id,
      createdAt: new Date().toISOString(),
    };
    await this.repository.save(full);
    return full;
  }

  async dequeue(assignee: string): Promise<HumanTask | null> {
    return this.repository.claimNextPending(assignee);
  }

  async get(taskId: string): Promise<HumanTask | null> {
    return this.repository.get(taskId);
  }

  async list(filter?: HumanTaskFilter): Promise<HumanTask[]> {
    const result = await this.repository.list(filter);

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
    const task = await this.repository.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.status}`);
    }

    await this.repository.save({
      ...task,
      status: 'completed',
      result: decision.data ?? { decision: decision.decision, reason: decision.reason },
      completedAt: decision.decidedAt,
    });
  }

  async reject(taskId: string, decision: HumanDecision): Promise<void> {
    const task = await this.repository.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.status}`);
    }

    await this.repository.save({
      ...task,
      status: 'rejected',
      result: decision.data ?? { decision: 'rejected', reason: decision.reason },
      completedAt: decision.decidedAt,
    });
  }

  async expire(taskId: string): Promise<void> {
    const task = await this.repository.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await this.repository.save({
      ...task,
      status: 'expired',
      completedAt: new Date().toISOString(),
    });
  }

  /** Expire all tasks whose SLA deadline has passed. Returns count of expired tasks. */
  async expireOverdue(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    const tasks = await this.repository.list();
    for (const task of tasks) {
      if (task.slaDeadline && task.slaDeadline < now && task.status !== 'completed' && task.status !== 'expired' && task.status !== 'rejected') {
        await this.repository.save({
          ...task,
          status: 'expired',
          completedAt: now,
        });
        count++;
      }
    }
    return count;
  }

  /** Get count of tasks by status. */
  async stats(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const tasks = await this.repository.list();
    for (const task of tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return counts;
  }
}

export class InMemoryTaskQueue implements HumanTaskQueue {
  private readonly delegate: RepositoryBackedTaskQueue;

  constructor(opts?: HumanTaskQueueOptions) {
    this.delegate = new RepositoryBackedTaskQueue(opts?.repository ?? new InMemoryHumanTaskRepository());
  }

  async enqueue(task: Omit<HumanTask, 'id' | 'createdAt'>): Promise<HumanTask> {
    return this.delegate.enqueue(task);
  }

  async dequeue(assignee: string): Promise<HumanTask | null> {
    return this.delegate.dequeue(assignee);
  }

  async get(taskId: string): Promise<HumanTask | null> {
    return this.delegate.get(taskId);
  }

  async list(filter?: HumanTaskFilter): Promise<HumanTask[]> {
    return this.delegate.list(filter);
  }

  async complete(taskId: string, decision: HumanDecision): Promise<void> {
    return this.delegate.complete(taskId, decision);
  }

  async reject(taskId: string, decision: HumanDecision): Promise<void> {
    return this.delegate.reject(taskId, decision);
  }

  async expire(taskId: string): Promise<void> {
    return this.delegate.expire(taskId);
  }

  /** Expire all tasks whose SLA deadline has passed. Returns count of expired tasks. */
  async expireOverdue(): Promise<number> {
    return this.delegate.expireOverdue();
  }

  /** Get count of tasks by status. */
  async stats(): Promise<Record<string, number>> {
    return this.delegate.stats();
  }
}
