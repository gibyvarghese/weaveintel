// SPDX-License-Identifier: MIT
/**
 * @weaveintel/cost-governor — Phase 3 (Shared Cost Slot)
 *
 * Bridges a `CostLedger` into the `RuntimeCostSlot` DI interface so the chat
 * path and the live-agent supervisor share a single per-entity spending counter
 * without duplicating budget-enforcement logic.
 *
 * Entity key: tenantId takes priority over userId — a multi-user tenant shares
 * one budget pool. Solo users (tenantId = null) are keyed by userId.
 *
 * All operations are best-effort: gate() and record() swallow errors and
 * fail-open so KV failures never crash the hot path.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { RuntimeCostSlot } from '@weaveintel/core';
import type { CostLedger } from './types.js';

export interface RuntimeCostAdapterOptions {
  /** Backing ledger — `createDurableCostLedger()` for production, in-memory for tests. */
  ledger: CostLedger;
  /**
   * Global ceiling in USD for all entities. `null` means no limit — gate()
   * always returns `{ allowed: true }`.
   */
  globalLimitUsd: number | null;
}

function entityKey(userId: string, tenantId: string | null): string {
  return tenantId ?? userId;
}

export function createRuntimeCostAdapter(opts: RuntimeCostAdapterOptions): RuntimeCostSlot {
  const { ledger, globalLimitUsd } = opts;

  return {
    async gate({ userId, tenantId }) {
      if (globalLimitUsd === null) return { allowed: true };
      try {
        const key = entityKey(userId, tenantId);
        const used = await ledger.total(key);
        if (used >= globalLimitUsd) {
          return {
            allowed: false,
            reason: `Spending limit of $${globalLimitUsd.toFixed(4)} USD exceeded (current spend: $${used.toFixed(4)} USD).`,
          };
        }
        return { allowed: true };
      } catch {
        return { allowed: true };
      }
    },

    async record({ userId, tenantId, model, provider, promptTokens, completionTokens, costUsd }) {
      try {
        const key = entityKey(userId, tenantId);
        await ledger.record({
          id: newUUIDv7(),
          runId: key,
          source: 'model',
          lever: 'model',
          subject: model,
          provider,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          costUsd,
          observedAt: Date.now(),
        });
      } catch {
        // best-effort
      }
    },

    async getBudgetStatus(entityId) {
      try {
        const used = await ledger.total(entityId);
        return { used, limit: globalLimitUsd, period: 'lifetime' };
      } catch {
        return { used: 0, limit: globalLimitUsd, period: 'lifetime' };
      }
    },
  };
}
