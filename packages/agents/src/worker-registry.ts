/**
 * @weaveintel/agents — P5-2: Dynamic Worker Registry
 *
 * Replaces the fixed `Map<string, Agent>` built once at supervisor construction
 * time with a mutable `WorkerRegistry` that supports runtime registration,
 * deregistration, and enumeration of workers.
 *
 * The supervisor's `delegate_to_worker` tool queries the registry at call time,
 * so newly registered workers are immediately available without recreating
 * the supervisor instance.
 *
 * Usage:
 * ```ts
 * import { createWorkerRegistry } from '@weaveintel/agents';
 *
 * const registry = createWorkerRegistry([researchWorker]);
 *
 * const agent = weaveAgent({
 *   model,
 *   workerRegistry: registry,
 * });
 *
 * // Add a worker at runtime — instantly available to the supervisor
 * registry.register(writingWorker);
 *
 * // Remove a worker
 * registry.unregister('research');
 * ```
 */

import type { WorkerDefinition } from './supervisor-runtime.js';

// ─── Interface ────────────────────────────────────────────────

/**
 * A mutable, thread-safe registry of `WorkerDefinition` entries.
 *
 * The supervisor runtime reads from this registry on every tool call, so
 * mutations take effect immediately without rebuilding the supervisor.
 */
export interface WorkerRegistry {
  /**
   * Add or replace a worker. If a worker with the same `name` already exists
   * it is replaced; any cached agent instance for that name is cleared so the
   * next delegation rebuilds it with the new definition.
   */
  register(def: WorkerDefinition): void;
  /**
   * Remove a worker by name.
   * Returns `true` when the worker existed and was removed, `false` otherwise.
   */
  unregister(name: string): boolean;
  /** Retrieve the current definition for a worker, or `undefined` if absent. */
  get(name: string): WorkerDefinition | undefined;
  /** Snapshot of the current worker list in registration order. */
  list(): WorkerDefinition[];
  /** Whether a worker with this name is currently registered. */
  has(name: string): boolean;
  /** Total number of registered workers. */
  get size(): number;
}

// ─── Factory ──────────────────────────────────────────────────

/**
 * Create a dynamic worker registry, optionally pre-populated with an initial
 * set of workers.
 *
 * Worker order is preserved (insertion-ordered Map internally).
 */
export function createWorkerRegistry(
  initialWorkers: WorkerDefinition[] = [],
): WorkerRegistry {
  const defs = new Map<string, WorkerDefinition>();

  for (const w of initialWorkers) {
    if (!w.name || typeof w.name !== 'string') {
      throw new Error(`WorkerRegistry: worker definition must have a non-empty name string`);
    }
    defs.set(w.name, w);
  }

  return {
    register(def) {
      if (!def.name || typeof def.name !== 'string') {
        throw new Error(`WorkerRegistry.register: definition must have a non-empty name string`);
      }
      defs.set(def.name, def);
    },

    unregister(name) {
      return defs.delete(name);
    },

    get(name) {
      return defs.get(name);
    },

    list() {
      return [...defs.values()];
    },

    has(name) {
      return defs.has(name);
    },

    get size() {
      return defs.size;
    },
  };
}
