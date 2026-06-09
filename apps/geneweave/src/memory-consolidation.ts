/**
 * geneWeave — memory consolidation wiring
 *
 * Bridges @weaveintel/memory's `weaveMemoryConsolidator` into geneWeave.
 * Two trigger modes:
 *
 *   1. Explicit call — `triggerConsolidationForUser(userId, sessionId)` is
 *      invoked from the chat engine after message processing completes.
 *      The consolidation runs asynchronously (fire-and-forget) so it never
 *      blocks the response stream.
 *
 *   2. Cron sweep — when `MEMORY_CONSOLIDATION_CRON=true`, a periodic setInterval
 *      sweeps all unconsolidated episodic entries every hour (configurable via
 *      `MEMORY_CONSOLIDATION_INTERVAL_MS`).
 *
 * The consolidator reads episodic-tagged entries from the SQLite store and
 * writes durable semantic facts to the active semantic-memory backend
 * (pgvector when PGVECTOR_URL is set, SQLite otherwise).
 */

import type {
  ExecutionContext,
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemoryFilter,
} from '@weaveintel/core';
import { weaveMemoryConsolidator, type MemoryConsolidatorOptions } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';

// ── SQLite episodic store adapter ─────────────────────────────────────────────

function createEpisodicStore(db: DatabaseAdapter): MemoryStore {
  return {
    async write(_ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      // Persist _consolidated markers so we don't re-process the same entries
      for (const entry of entries) {
        if (entry.metadata['_consolidated'] && entry.type === 'episodic') {
          try {
            // Write a tiny marker row so future queries can filter it out
            await db.saveSemanticMemory({
              id: `${entry.id}:consolidated_marker`,
              userId: entry.userId ?? 'unknown',
              content: `__consolidated__ ${entry.id}`,
              memoryType: 'episodic',
              source: 'consolidation-marker',
              embedding: undefined,
            });
          } catch {
            // Non-critical — worst case we re-process the entry next run
          }
        }
      }
    },

    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      const userId = options.filter?.userId;
      if (!userId) return [];
      const rows = await db.listSemanticMemory(userId, options.topK ?? 50);
      return rows
        .filter((r) => r.source === 'user' || r.memory_type === 'episodic')
        .filter((r) => !r.content.startsWith('__consolidated__'))
        .map((r): MemoryEntry => ({
          id: r.id,
          type: 'episodic',
          content: r.content,
          metadata: { memory_type: r.memory_type, source: r.source },
          createdAt: r.created_at,
          userId,
        }));
    },

    async delete(_ctx: ExecutionContext, _ids: string[]): Promise<void> { /* unused */ },
    async clear(_ctx: ExecutionContext, _filter?: MemoryFilter): Promise<void> { /* unused */ },
  };
}

// ── Semantic store adapter (wraps active backend) ────────────────────────────

function createSemanticStore(): MemoryStore {
  return {
    async write(ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void> {
      const backend = getActiveSemanticMemoryBackend();
      if (!backend) return;
      for (const entry of entries) {
        await backend.save(ctx, {
          id: entry.id,
          userId: entry.userId ?? ctx.userId ?? 'unknown',
          content: entry.content,
          memoryType: 'consolidated',
          source: (entry.metadata['_sourceTag'] as string | undefined) ?? 'consolidation',
        });
      }
    },

    async query(ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      const backend = getActiveSemanticMemoryBackend();
      if (!backend) return [];
      const userId = options.filter?.userId ?? ctx.userId ?? 'unknown';
      const rows = await backend.list(userId, options.topK ?? 50);
      return rows.map((r): MemoryEntry => ({
        id: r.id,
        type: 'semantic',
        content: r.content,
        metadata: { memory_type: r.memory_type, source: r.source },
        createdAt: r.created_at,
        userId,
      }));
    },

    async delete(_ctx: ExecutionContext, _ids: string[]): Promise<void> { /* unused */ },
    async clear(_ctx: ExecutionContext, _filter?: MemoryFilter): Promise<void> { /* unused */ },
  };
}

// ── Module-level consolidator singleton ──────────────────────────────────────

let _consolidatorDb: DatabaseAdapter | null = null;
let _runConsolidation: ((userId: string | undefined, sessionId: string | undefined) => Promise<void>) | null = null;

/**
 * Initialise memory consolidation.  Call once from `createGeneWeave()` after
 * the semantic memory backend is ready.
 */
export function initMemoryConsolidation(opts: {
  db: DatabaseAdapter;
  llmExtractor?: MemoryConsolidatorOptions['llmExtractor'];
}): void {
  if (_consolidatorDb) return; // already initialised
  _consolidatorDb = opts.db;

  const consolidator = weaveMemoryConsolidator({
    episodicStore: createEpisodicStore(opts.db),
    semanticStore: createSemanticStore(),
    llmExtractor: opts.llmExtractor,
    minConfidence: 0.6,
    sourceTag: 'geneweave-consolidation',
  });

  _runConsolidation = async (userId: string | undefined, sessionId: string | undefined) => {
    const ctx: ExecutionContext = {
      executionId: `consolidation:${sessionId ?? userId ?? Date.now()}`,
      userId: userId ?? undefined,
      metadata: { sessionId, userId },
      tracer: { trace: () => { /* noop */ }, span: () => { /* noop */ } },
    } as unknown as ExecutionContext;

    try {
      const result = await consolidator.consolidate(ctx, { userId, sessionId, batchSize: 50 });
      if (result.factsWritten > 0 || result.errors.length > 0) {
        console.log(
          `[consolidation] user=${userId ?? '-'} session=${sessionId ?? '-'} ` +
          `read=${result.episodicRead} extracted=${result.factsExtracted} ` +
          `deduped=${result.factsDeduped} written=${result.factsWritten}` +
          (result.errors.length ? ` errors=${result.errors.join('; ')}` : ''),
        );
      }
    } catch (err) {
      console.warn('[consolidation] run failed:', String(err));
    }
  };

  // Optional cron sweep
  if (process.env['MEMORY_CONSOLIDATION_CRON'] === 'true') {
    const intervalMs = parseInt(process.env['MEMORY_CONSOLIDATION_INTERVAL_MS'] ?? '3600000', 10);
    setInterval(() => {
      void _runConsolidation?.(undefined, undefined);
    }, intervalMs);
    console.log(`[consolidation] cron sweep active — interval ${intervalMs / 1000}s`);
  }

  console.log('[consolidation] memory consolidation initialised');
}

/**
 * Trigger consolidation for a user/session asynchronously (fire-and-forget).
 * Call this after a message is processed — it never blocks the response.
 */
export function triggerConsolidationForUser(userId: string, sessionId?: string): void {
  if (!_runConsolidation) return;
  void _runConsolidation(userId, sessionId);
}

export { weaveMemoryConsolidator } from '@weaveintel/memory';
export type { MemoryConsolidatorOptions } from '@weaveintel/memory';
