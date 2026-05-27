/**
 * @weaveintel/workflows — run-repository.ts
 * Package-owned workflow run persistence contracts and adapters.
 */
import type { WorkflowRun } from '@weaveintel/core';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RunFilterOpts {
  workflowId?: string;
  status?: WorkflowRun['status'];
  tenantId?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export interface WorkflowRunRepository {
  save(run: WorkflowRun): Promise<void>;
  get(runId: string): Promise<WorkflowRun | null>;
  list(workflowId?: string): Promise<WorkflowRun[]>;
  /** Phase W4 — return all direct child runs spawned by the given parent run. */
  listByParent(parentRunId: string): Promise<WorkflowRun[]>;
  /**
   * Phase W5 — server-side filtered list with optional status, tenant, date
   * range, and result limit.  Implementations without native query support may
   * apply filters in memory after a full `list()` scan.
   */
  listFiltered(opts: RunFilterOpts): Promise<WorkflowRun[]>;
  /**
   * Phase W5 — count runs that are currently active (status 'running' or
   * 'paused') for the given workflow definition.  Used for concurrency checks.
   */
  countActive(workflowId: string): Promise<number>;
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

  async listByParent(parentRunId: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(r => r.parentRunId === parentRunId)
      .map(r => structuredClone(r));
  }

  async listFiltered(opts: RunFilterOpts): Promise<WorkflowRun[]> {
    let rows = [...this.runs.values()];
    if (opts.workflowId) rows = rows.filter(r => r.workflowId === opts.workflowId);
    if (opts.status)     rows = rows.filter(r => r.status === opts.status);
    if (opts.tenantId)   rows = rows.filter(r => r.tenantId === opts.tenantId);
    if (opts.before)     rows = rows.filter(r => r.startedAt < opts.before!);
    if (opts.after)      rows = rows.filter(r => r.startedAt > opts.after!);
    rows = rows.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (opts.limit)      rows = rows.slice(0, opts.limit);
    return rows.map(r => structuredClone(r));
  }

  async countActive(workflowId: string): Promise<number> {
    return [...this.runs.values()].filter(
      r => r.workflowId === workflowId && (r.status === 'running' || r.status === 'paused'),
    ).length;
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

  async listByParent(parentRunId: string): Promise<WorkflowRun[]> {
    const runs = await this.readAll();
    return runs.filter(r => r.parentRunId === parentRunId).map(r => structuredClone(r));
  }

  async listFiltered(opts: RunFilterOpts): Promise<WorkflowRun[]> {
    let rows = await this.readAll();
    if (opts.workflowId) rows = rows.filter(r => r.workflowId === opts.workflowId);
    if (opts.status)     rows = rows.filter(r => r.status === opts.status);
    if (opts.tenantId)   rows = rows.filter(r => r.tenantId === opts.tenantId);
    if (opts.before)     rows = rows.filter(r => r.startedAt < opts.before!);
    if (opts.after)      rows = rows.filter(r => r.startedAt > opts.after!);
    rows = rows.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (opts.limit)      rows = rows.slice(0, opts.limit);
    return rows.map(r => structuredClone(r));
  }

  async countActive(workflowId: string): Promise<number> {
    const runs = await this.readAll();
    return runs.filter(r => r.workflowId === workflowId && (r.status === 'running' || r.status === 'paused')).length;
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
