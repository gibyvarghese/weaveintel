/**
 * Example 143 — Shared Cost Governor Slot (Phase 3)
 *
 * Demonstrates the `RuntimeCostSlot` DI pattern:
 *   - A single `createDurableCostLedger` is backed by in-memory KV
 *   - Wrapped in `createRuntimeCostAdapter` with a $0.10 per-user ceiling
 *   - Mounted on `weaveRuntime({ cost: adapter })`
 *   - `gate()` allows the first call, then denies after spend accumulates
 *   - `getBudgetStatus()` returns the live spend + limit
 *
 * In geneWeave production, this ledger is backed by `weaveSqlitePersistence`
 * and the ceiling is read from `WEAVE_COST_LIMIT_USD`. The same adapter is
 * mounted once and shared across the chat path and the live-agent supervisor.
 */

import { weaveRuntime, weaveInMemoryPersistence, RuntimeCapabilities } from '@weaveintel/core';
import { createDurableCostLedger, createRuntimeCostAdapter } from '@weaveintel/cost-governor';

async function main() {
  const persistenceSlot = weaveInMemoryPersistence();

  const ledger = createDurableCostLedger({
    runtime: { persistence: persistenceSlot } as any,
    namespace: 'runtime-cost',
  });

  const LIMIT_USD = 0.10;
  const costAdapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: LIMIT_USD });

  const runtime = weaveRuntime({
    tlsFloor: false,
    persistence: persistenceSlot,
    cost: costAdapter,
  });

  console.log('Cost capability advertised:', runtime.has(RuntimeCapabilities.Cost));

  const userId = 'user-alice';
  const tenantId = null;

  // ── First gate check: should be allowed ──────────────────────────────────
  const check1 = await runtime.cost!.gate({ userId, tenantId });
  console.log('\n[Turn 1] Budget check before any spend:', check1);

  // Simulate a $0.04 model call
  await runtime.cost!.record({ userId, tenantId, model: 'claude-haiku-4-5', provider: 'anthropic', promptTokens: 1000, completionTokens: 200, costUsd: 0.04 });
  console.log('[Turn 1] Recorded $0.04 spend');

  // ── Second gate check: still under limit ─────────────────────────────────
  const check2 = await runtime.cost!.gate({ userId, tenantId });
  console.log('\n[Turn 2] Budget check after $0.04 spend:', check2);

  // Simulate two more model calls
  await runtime.cost!.record({ userId, tenantId, model: 'claude-haiku-4-5', provider: 'anthropic', promptTokens: 2000, completionTokens: 400, costUsd: 0.05 });
  console.log('[Turn 2] Recorded another $0.05 spend (cumulative: $0.09)');

  await runtime.cost!.record({ userId, tenantId, model: 'claude-haiku-4-5', provider: 'anthropic', promptTokens: 500, completionTokens: 100, costUsd: 0.02 });
  console.log('[Turn 3] Recorded another $0.02 spend (cumulative: $0.11)');

  // ── Third gate check: over limit ─────────────────────────────────────────
  const check3 = await runtime.cost!.gate({ userId, tenantId });
  console.log('\n[Turn 4] Budget check after cumulative $0.11 spend:', check3);

  // ── Budget status ─────────────────────────────────────────────────────────
  const status = await runtime.cost!.getBudgetStatus(userId);
  console.log('\nFinal budget status:', {
    used: `$${status.used.toFixed(4)}`,
    limit: status.limit !== null ? `$${status.limit.toFixed(4)}` : 'unlimited',
    period: status.period,
    overBudget: status.limit !== null && status.used > status.limit,
  });

  // ── Tenant pooling demo ───────────────────────────────────────────────────
  console.log('\n── Tenant pooling demo ──');
  const tenantLedger = createDurableCostLedger({ namespace: 'tenant-cost' });
  const tenantAdapter = createRuntimeCostAdapter({ ledger: tenantLedger, globalLimitUsd: 0.05 });

  // Two users under the same tenant share the budget pool
  await tenantAdapter.record({ userId: 'user-bob', tenantId: 'acme-corp', model: 'm', provider: 'p', promptTokens: 100, completionTokens: 50, costUsd: 0.03 });
  console.log('user-bob recorded $0.03 spend under acme-corp');

  const aliceCheck = await tenantAdapter.gate({ userId: 'user-alice', tenantId: 'acme-corp' });
  console.log('user-alice gate check (same tenant, $0.03 pooled, limit $0.05):', aliceCheck);

  await tenantAdapter.record({ userId: 'user-alice', tenantId: 'acme-corp', model: 'm', provider: 'p', promptTokens: 200, completionTokens: 100, costUsd: 0.03 });
  console.log('user-alice recorded $0.03 spend (tenant cumulative: $0.06)');

  const bobCheck = await tenantAdapter.gate({ userId: 'user-bob', tenantId: 'acme-corp' });
  console.log('user-bob gate check (tenant over-budget now):', bobCheck);
}

main().catch(console.error);
