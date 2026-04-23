/**
 * GeneWeave chat — model routing and cache policy resolution
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import type { CachePolicy, ModelHealth } from '@weaveintel/core';
import { SmartModelRouter } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import { resolvePolicy } from '@weaveintel/cache';
import { FALLBACK_PRICING } from './chat-runtime.js';
import type { DatabaseAdapter } from './db.js';

// ── Model routing ────────────────────────────────────────────

/**
 * Select model + provider using the active routing policy from the DB.
 * Returns null if no enabled policy exists (caller falls back to default).
 */
export async function routeModel(
  db: DatabaseAdapter,
  candidates: Array<{ id: string; provider: string }>,
  healthList: ModelHealth[],
  opts?: { provider?: string; model?: string },
): Promise<{ provider: string; modelId: string } | null> {
  try {
    const policies = await db.listRoutingPolicies();
    const active = policies.find(p => p.enabled);
    if (!active) return null;

    const routerCandidates = candidates.map(m => ({
      modelId: m.id,
      providerId: m.provider,
    }));

    if (routerCandidates.length === 0) return null;

    // Load pricing & quality from DB (falls back to hardcoded if DB is empty)
    const pricingRows = await db.listModelPricing();
    const pricingMap = new Map(pricingRows.filter(r => r.enabled).map(r => [`${r.provider}:${r.model_id}`, r]));

    // Cost data from DB model_pricing table
    const costs: ModelCostInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      const fb = FALLBACK_PRICING[c.modelId];
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        inputCostPer1M: row ? row.input_cost_per_1m : fb ? fb.input : 10,
        outputCostPer1M: row ? row.output_cost_per_1m : fb ? fb.output : 30,
      };
    });

    // Quality scores from DB model_pricing table
    const qualities: ModelQualityInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        qualityScore: row ? row.quality_score : 0.7,
      };
    });

    const router = new SmartModelRouter({
      candidates: routerCandidates,
      costs,
      qualities,
      initialHealth: healthList,
    });

    const decision = await router.route(
      { prompt: '' },
      {
        id: active.id,
        name: active.name,
        strategy: active.strategy as any,
        constraints: active.constraints ? JSON.parse(active.constraints) : undefined,
        weights: active.weights ? JSON.parse(active.weights) : undefined,
        fallbackModelId: active.fallback_model ?? undefined,
        fallbackProviderId: active.fallback_provider ?? undefined,
        enabled: true,
      },
    );

    return { provider: decision.providerId, modelId: decision.modelId };
  } catch {
    return null;
  }
}

// ── Cache policy resolution ──────────────────────────────────

/**
 * Resolve the best-matching cache policy from admin-configured policies.
 */
export async function resolveActiveCache(
  db: DatabaseAdapter,
  _mode: string,
): Promise<CachePolicy | null> {
  try {
    const rows = await db.listCachePolicies();
    const enabled = rows.filter(r => r.enabled);
    if (!enabled.length) return null;
    const policies: CachePolicy[] = enabled.map(r => ({
      id: r.id,
      name: r.name,
      scope: (r.scope as CachePolicy['scope']) ?? 'global',
      ttlMs: r.ttl_ms ?? 300_000,
      maxEntries: r.max_entries ?? 1000,
      bypassPatterns: r.bypass_patterns ? JSON.parse(r.bypass_patterns) : [],
      invalidateOnEvents: r.invalidate_on ? JSON.parse(r.invalidate_on) : [],
      enabled: true,
    }));
    return resolvePolicy(policies, {}) ?? null;
  } catch {
    return null;
  }
}
