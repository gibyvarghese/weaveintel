/**
 * @weaveintel/workflows — checkpoint-store.ts
 * Durable state persistence for workflow runs
 */
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CheckpointStore {
  save(runId: string, stepId: string, state: WorkflowState, workflowId?: string): Promise<WorkflowCheckpoint>;
  load(checkpointId: string): Promise<WorkflowCheckpoint | null>;
  latest(runId: string): Promise<WorkflowCheckpoint | null>;
  list(runId: string): Promise<WorkflowCheckpoint[]>;
  delete(runId: string): Promise<void>;
}

/**
 * In-memory checkpoint store — suitable for tests and single-process usage.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private store = new Map<string, WorkflowCheckpoint>();

  async save(runId: string, stepId: string, state: WorkflowState, workflowId?: string): Promise<WorkflowCheckpoint> {
    const cp: WorkflowCheckpoint = {
      id: newUUIDv7(),
      runId,
      workflowId,
      stepId,
      state: structuredClone(state),
      createdAt: new Date().toISOString(),
    };
    this.store.set(cp.id, cp);
    return cp;
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint | null> {
    return this.store.get(checkpointId) ?? null;
  }

  async latest(runId: string): Promise<WorkflowCheckpoint | null> {
    let best: WorkflowCheckpoint | null = null;
    for (const cp of this.store.values()) {
      if (cp.runId === runId && (!best || cp.createdAt > best.createdAt)) best = cp;
    }
    return best;
  }

  async list(runId: string): Promise<WorkflowCheckpoint[]> {
    return [...this.store.values()]
      .filter(cp => cp.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(runId: string): Promise<void> {
    for (const [id, cp] of this.store) {
      if (cp.runId === runId) this.store.delete(id);
    }
  }
}

/**
 * Durable JSON file-backed checkpoint store. All checkpoints are persisted to
 * a single JSON array file (append-only semantics via atomic rename). Suitable
 * for development, testing, and single-node deployments where SQLite is not
 * available.
 */
export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(runId: string, stepId: string, state: WorkflowState, workflowId?: string): Promise<WorkflowCheckpoint> {
    const cp: WorkflowCheckpoint = {
      id: newUUIDv7(),
      runId,
      ...(workflowId ? { workflowId } : {}),
      stepId,
      state: structuredClone(state),
      createdAt: new Date().toISOString(),
    };
    const all = await this.readAll();
    all.push(cp);
    await this.writeAll(all);
    return cp;
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint | null> {
    const all = await this.readAll();
    return all.find(cp => cp.id === checkpointId) ?? null;
  }

  async latest(runId: string): Promise<WorkflowCheckpoint | null> {
    const all = await this.readAll();
    const forRun = all.filter(cp => cp.runId === runId);
    if (forRun.length === 0) return null;
    return forRun.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  }

  async list(runId: string): Promise<WorkflowCheckpoint[]> {
    const all = await this.readAll();
    return all.filter(cp => cp.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(runId: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter(cp => cp.runId !== runId));
  }

  private async readAll(): Promise<WorkflowCheckpoint[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as WorkflowCheckpoint[];
    } catch {
      return [];
    }
  }

  private async writeAll(checkpoints: WorkflowCheckpoint[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(checkpoints, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
