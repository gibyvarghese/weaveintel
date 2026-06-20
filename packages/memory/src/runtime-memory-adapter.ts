/**
 * Phase 5 — `createRuntimeMemoryAdapter`
 *
 * Builds a `RuntimeMemorySlot` from concrete memory instances so it can be
 * passed to `weaveRuntime({ memory: … })` without coupling core to any
 * specific memory backend.
 *
 * Usage:
 *
 *   import { createRuntimeMemoryAdapter } from '@weaveintel/memory';
 *   import { weaveSemanticMemory, weaveEntityMemory, weaveWorkingMemory, weaveSqliteMemoryStore } from '@weaveintel/memory';
 *
 *   const store = weaveSqliteMemoryStore({ path: './agent-memory.db' });
 *   const memoryAdapter = createRuntimeMemoryAdapter({
 *     semantic: weaveSemanticMemory(embeddingModel, store),
 *     working: weaveWorkingMemory(),
 *     store,
 *   });
 *
 *   const runtime = weaveRuntime({ memory: memoryAdapter, … });
 */

import type { RuntimeMemorySlot } from '@weaveintel/core';
import type { SemanticMemory, WorkingMemory, MemoryStore } from '@weaveintel/core';

export interface RuntimeMemoryAdapterOptions {
  /** Embedding-based semantic store + recall. */
  readonly semantic: SemanticMemory;
  /** Per-agent scratch state (patch, checkpoint, restore). */
  readonly working: WorkingMemory;
  /** Raw MemoryStore for multi-type queries (episodic, entity, procedural). */
  readonly store: MemoryStore;
  /**
   * Optional consolidation function. Called by `runtime.memory.consolidate(userId)`
   * on the cold path (session-end, cron) to distil episodic → semantic facts.
   * When omitted, `consolidate` is a no-op.
   */
  readonly consolidate?: (userId: string) => Promise<void>;
}

/**
 * Build a `RuntimeMemorySlot` from concrete memory instances.
 * The slot is a thin value-object — all behaviour lives in the instances
 * passed in.
 */
export function createRuntimeMemoryAdapter(
  opts: RuntimeMemoryAdapterOptions,
): RuntimeMemorySlot {
  return {
    semantic: opts.semantic,
    working: opts.working,
    store: opts.store,
    async consolidate(userId: string): Promise<void> {
      if (opts.consolidate) {
        await opts.consolidate(userId);
      }
    },
  };
}
