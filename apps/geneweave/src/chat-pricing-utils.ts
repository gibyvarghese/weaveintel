import type { DatabaseAdapter } from './db.js';

export interface ModelPricing {
  input: number;
  output: number;
}

export interface PricingCache {
  ts: number;
  pricing: Map<string, ModelPricing>;
}

export async function loadModelPricing(
  db: DatabaseAdapter,
  cache: PricingCache | null,
): Promise<{ pricing: Map<string, ModelPricing>; cache: PricingCache | null }> {
  const now = Date.now();
  if (cache && now - cache.ts < 60_000) {
    return { pricing: cache.pricing, cache };
  }

  try {
    const rows = await db.listModelPricing();
    const pricing = new Map<string, ModelPricing>();
    for (const row of rows) {
      if (row.enabled) pricing.set(row.model_id, { input: row.input_cost_per_1m, output: row.output_cost_per_1m });
    }
    const nextCache = { ts: now, pricing };
    return { pricing, cache: nextCache };
  } catch {
    return { pricing: new Map<string, ModelPricing>(), cache };
  }
}