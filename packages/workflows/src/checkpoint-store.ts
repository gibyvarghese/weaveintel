/**
 * @weaveintel/workflows — checkpoint-store.ts
 * Durable state persistence for workflow runs
 */
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';

export interface CheckpointStore {
  save(runId: string, stepId: string, state: WorkflowState): Promise<WorkflowCheckpoint>;
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

  async save(runId: string, stepId: string, state: WorkflowState): Promise<WorkflowCheckpoint> {
    const cp: WorkflowCheckpoint = {
      id: randomUUID(),
      runId,
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
