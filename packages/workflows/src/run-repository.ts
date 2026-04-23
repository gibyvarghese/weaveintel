/**
 * @weaveintel/workflows — run-repository.ts
 * Package-owned workflow run persistence contracts and adapters.
 */
import type { WorkflowRun } from '@weaveintel/core';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WorkflowRunRepository {
  save(run: WorkflowRun): Promise<void>;
  get(runId: string): Promise<WorkflowRun | null>;
  list(workflowId?: string): Promise<WorkflowRun[]>;
  delete(runId: string): Promise<void>;
}

export class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private readonly runs = new Map<string, WorkflowRun>();

  async save(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    const rows = [...this.runs.values()];
    const filtered = workflowId ? rows.filter(r => r.workflowId === workflowId) : rows;
    return filtered.map(r => structuredClone(r));
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

/**
 * Durable JSON file-backed workflow repository for local development,
 * multi-process restarts, and reference app extraction use-cases.
 */
export class JsonFileWorkflowRunRepository implements WorkflowRunRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(run: WorkflowRun): Promise<void> {
    const runs = await this.readAll();
    const idx = runs.findIndex(r => r.id === run.id);
    if (idx >= 0) {
      runs[idx] = structuredClone(run);
    } else {
      runs.push(structuredClone(run));
    }
    await this.writeAll(runs);
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const runs = await this.readAll();
    const run = runs.find(r => r.id === runId) ?? null;
    return run ? structuredClone(run) : null;
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    const runs = await this.readAll();
    const filtered = workflowId ? runs.filter(r => r.workflowId === workflowId) : runs;
    return filtered.map(r => structuredClone(r));
  }

  async delete(runId: string): Promise<void> {
    const runs = await this.readAll();
    await this.writeAll(runs.filter(r => r.id !== runId));
  }

  private async readAll(): Promise<WorkflowRun[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as WorkflowRun[];
    } catch {
      return [];
    }
  }

  private async writeAll(runs: WorkflowRun[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(runs, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
