/**
 * @weaveintel/workflows — definition-store.ts
 *
 * `WorkflowDefinitionStore` is the contract apps implement to back workflow
 * definitions with a real database. The package ships an `InMemory` adapter
 * for tests and short-lived processes; geneweave provides a SQLite-backed
 * adapter (`DbWorkflowDefinitionStore`).
 *
 * The engine calls into the store in two situations:
 *   1. `startRun(workflowId, input)` — when the in-memory definition map
 *      misses, it falls back to the store.
 *   2. Optional eager preload at boot via `loadAllInto(engine)`.
 */
import type { WorkflowDefinition } from '@weaveintel/core';

export interface WorkflowDefinitionStore {
  list(): Promise<WorkflowDefinition[]>;
  get(idOrKey: string): Promise<WorkflowDefinition | null>;
  /**
   * Persist a definition. Stores are responsible for upsert semantics by id.
   * Returns the saved record (with `updatedAt` refreshed).
   */
  save(def: WorkflowDefinition): Promise<WorkflowDefinition>;
  delete(id: string): Promise<void>;
}

export class InMemoryWorkflowDefinitionStore implements WorkflowDefinitionStore {
  private readonly defs = new Map<string, WorkflowDefinition>();

  async list(): Promise<WorkflowDefinition[]> {
    return [...this.defs.values()].map(d => structuredClone(d));
  }

  async get(idOrKey: string): Promise<WorkflowDefinition | null> {
    const direct = this.defs.get(idOrKey);
    if (direct) return structuredClone(direct);
    // Allow lookup by name as a soft "key" alias.
    for (const d of this.defs.values()) {
      if (d.name === idOrKey) return structuredClone(d);
    }
    return null;
  }

  async save(def: WorkflowDefinition): Promise<WorkflowDefinition> {
    const saved: WorkflowDefinition = {
      ...def,
      updatedAt: new Date().toISOString(),
      createdAt: def.createdAt ?? new Date().toISOString(),
    };
    this.defs.set(saved.id, structuredClone(saved));
    return structuredClone(saved);
  }

  async delete(id: string): Promise<void> {
    this.defs.delete(id);
  }
}
