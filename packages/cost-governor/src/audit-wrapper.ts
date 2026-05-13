/**
 * Wraps a `ToolAuditEmitter` so every tool invocation also lands in the
 * cost ledger as an inventory entry (USD = 0 in Phase 1). This gives the
 * admin breakdown a per-tool dimension without needing tool pricing yet.
 */

import type { ToolAuditEmitter } from '@weaveintel/tools';
import type { ToolAuditEvent } from '@weaveintel/core';
import type { CostLedgerEntry, CostLedgerSink } from './types.js';

export interface ToolCostContext {
  runId: string;
  stepId?: string;
  agentId?: string;
  agentRole?: string;
}

export interface WrapAuditOptions {
  inner: ToolAuditEmitter;
  sink: CostLedgerSink;
  newId: () => string;
  /** Resolves the per-event cost context. May read from the audit event
   *  itself (e.g. derive runId from `event.chatId`). May be async. */
  resolveContext: (event: ToolAuditEvent) => ToolCostContext | null | undefined | Promise<ToolCostContext | null | undefined>;
}

export function wrapAuditEmitterWithCostLedger(opts: WrapAuditOptions): ToolAuditEmitter {
  const { inner, sink, newId, resolveContext } = opts;
  return {
    async emit(event): Promise<void> {
      try { await inner.emit(event); } catch {/* swallow — same contract as inner */}
      try {
        if (event.outcome !== 'success' && event.outcome !== 'error') return;
        const ctx = await resolveContext(event);
        if (!ctx || !ctx.runId) return;
        const entry: CostLedgerEntry = {
          id: newId(),
          runId: ctx.runId,
          ...(ctx.stepId    !== undefined ? { stepId: ctx.stepId       } : {}),
          ...(ctx.agentId   !== undefined ? { agentId: ctx.agentId     } : {}),
          ...(ctx.agentRole !== undefined ? { agentRole: ctx.agentRole } : {}),
          source: 'tool',
          lever: 'tool',
          subject: event.toolName,
          costUsd: 0,
          observedAt: Date.now(),
          metadata: {
            outcome: event.outcome,
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          },
        };
        await sink.append(entry);
      } catch {/* swallow */}
    },
  };
}
