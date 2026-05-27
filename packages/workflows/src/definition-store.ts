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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/**
 * Durable JSON file-backed definition store for local development and
 * testing across process restarts (no SQLite required).
 */
export class JsonFileWorkflowDefinitionStore implements WorkflowDefinitionStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<WorkflowDefinition[]> {
    const defs = await this.readAll();
    return defs.map(d => structuredClone(d));
  }

  async get(idOrKey: string): Promise<WorkflowDefinition | null> {
    const defs = await this.readAll();
    const direct = defs.find(d => d.id === idOrKey) ?? null;
    if (direct) return structuredClone(direct);
    const byName = defs.find(d => d.name === idOrKey) ?? null;
    return byName ? structuredClone(byName) : null;
  }

  async save(def: WorkflowDefinition): Promise<WorkflowDefinition> {
    const defs = await this.readAll();
    const saved: WorkflowDefinition = {
      ...def,
      updatedAt: new Date().toISOString(),
      createdAt: def.createdAt ?? new Date().toISOString(),
    };
    const idx = defs.findIndex(d => d.id === saved.id);
    if (idx >= 0) {
      defs[idx] = structuredClone(saved);
    } else {
      defs.push(structuredClone(saved));
    }
    await this.writeAll(defs);
    return structuredClone(saved);
  }

  async delete(id: string): Promise<void> {
    const defs = await this.readAll();
    await this.writeAll(defs.filter(d => d.id !== id));
  }

  private async readAll(): Promise<WorkflowDefinition[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as WorkflowDefinition[];
    } catch {
      return [];
    }
  }

  private async writeAll(defs: WorkflowDefinition[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(defs, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
