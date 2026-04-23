/**
 * @weaveintel/human-tasks — repository.ts
 * Package-owned task persistence contracts and adapters.
 */
import type { HumanTask, HumanTaskFilter } from '@weaveintel/core';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface HumanTaskRepository {
  save(task: HumanTask): Promise<void>;
  get(taskId: string): Promise<HumanTask | null>;
  list(filter?: HumanTaskFilter): Promise<HumanTask[]>;
  delete(taskId: string): Promise<void>;
  claimNextPending(assignee: string): Promise<HumanTask | null>;
}

export class InMemoryHumanTaskRepository implements HumanTaskRepository {
  private readonly tasks = new Map<string, HumanTask>();

  async save(task: HumanTask): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async get(taskId: string): Promise<HumanTask | null> {
    const t = this.tasks.get(taskId);
    return t ? structuredClone(t) : null;
  }

  async list(filter?: HumanTaskFilter): Promise<HumanTask[]> {
    let rows = [...this.tasks.values()];
    if (filter) {
      if (filter.status?.length) rows = rows.filter(t => filter.status!.includes(t.status));
      if (filter.type?.length) rows = rows.filter(t => filter.type!.includes(t.type));
      if (filter.assignee) rows = rows.filter(t => t.assignee === filter.assignee);
      if (filter.priority?.length) rows = rows.filter(t => filter.priority!.includes(t.priority));
      if (filter.workflowRunId) rows = rows.filter(t => t.workflowRunId === filter.workflowRunId);
    }
    return rows.map(r => structuredClone(r));
  }

  async delete(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  async claimNextPending(assignee: string): Promise<HumanTask | null> {
    const priorityOrder = ['urgent', 'high', 'normal', 'low'];
    const pending = [...this.tasks.values()]
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const pa = priorityOrder.indexOf(a.priority);
        const pb = priorityOrder.indexOf(b.priority);
        if (pa !== pb) return pa - pb;
        return a.createdAt.localeCompare(b.createdAt);
      });

    const best = pending[0];
    if (!best) return null;

    const claimed: HumanTask = {
      ...best,
      status: 'assigned',
      assignee,
    };
    this.tasks.set(claimed.id, structuredClone(claimed));
    return claimed;
  }
}

/**
 * Durable JSON file-backed repository for local/stateful usage outside app-local maps.
 */
export class JsonFileHumanTaskRepository implements HumanTaskRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(task: HumanTask): Promise<void> {
    const tasks = await this.readAll();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = structuredClone(task);
    } else {
      tasks.push(structuredClone(task));
    }
    await this.writeAll(tasks);
  }

  async get(taskId: string): Promise<HumanTask | null> {
    const tasks = await this.readAll();
    const task = tasks.find(t => t.id === taskId) ?? null;
    return task ? structuredClone(task) : null;
  }

  async list(filter?: HumanTaskFilter): Promise<HumanTask[]> {
    let tasks = await this.readAll();
    if (filter) {
      if (filter.status?.length) tasks = tasks.filter(t => filter.status!.includes(t.status));
      if (filter.type?.length) tasks = tasks.filter(t => filter.type!.includes(t.type));
      if (filter.assignee) tasks = tasks.filter(t => t.assignee === filter.assignee);
      if (filter.priority?.length) tasks = tasks.filter(t => filter.priority!.includes(t.priority));
      if (filter.workflowRunId) tasks = tasks.filter(t => t.workflowRunId === filter.workflowRunId);
    }
    return tasks.map(t => structuredClone(t));
  }

  async delete(taskId: string): Promise<void> {
    const tasks = await this.readAll();
    await this.writeAll(tasks.filter(t => t.id !== taskId));
  }

  async claimNextPending(assignee: string): Promise<HumanTask | null> {
    const priorityOrder = ['urgent', 'high', 'normal', 'low'];
    const tasks = await this.readAll();

    const pending = tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const pa = priorityOrder.indexOf(a.priority);
        const pb = priorityOrder.indexOf(b.priority);
        if (pa !== pb) return pa - pb;
        return a.createdAt.localeCompare(b.createdAt);
      });

    const best = pending[0];
    if (!best) return null;

    const updated: HumanTask = {
      ...best,
      status: 'assigned',
      assignee,
    };

    const idx = tasks.findIndex(t => t.id === best.id);
    if (idx >= 0) tasks[idx] = updated;
    await this.writeAll(tasks);
    return structuredClone(updated);
  }

  private async readAll(): Promise<HumanTask[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as HumanTask[];
    } catch {
      return [];
    }
  }

  private async writeAll(tasks: HumanTask[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
