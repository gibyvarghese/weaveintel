/**
 * @weaveintel/geneweave — Model Pricing Sync
 *
 * Fetches available models from provider APIs (using configured API keys)
 * and populates the model_pricing table with known pricing data.
 *
 * Provider API capabilities:
 *  - OpenAI:    GET /v1/models → lists model IDs (no pricing in response)
 *  - Anthropic: GET /v1/models → lists model IDs (no pricing in response)
 *
 * Since neither provider exposes pricing via API, we maintain a built-in
 * pricing registry and use the API to discover which models are accessible
 * with the configured API key.
 */

import type { DatabaseAdapter, ModelPricingRow } from './db.js';

// ─── Built-in pricing registry ───────────────────────────────
// Source of truth for known pricing (per 1M tokens) and quality scores.
// Updated periodically. The sync process uses this to populate the DB.

interface KnownModelPricing {
  displayName: string;
  input: number;
  output: number;
  quality: number;
}

const OPENAI_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'gpt-4o':           { displayName: 'GPT-4o',         input: 2.50,  output: 10.00, quality: 0.90 },
  'gpt-4o-mini':      { displayName: 'GPT-4o Mini',    input: 0.15,  output: 0.60,  quality: 0.75 },
  'gpt-4.1':          { displayName: 'GPT-4.1',        input: 2.00,  output: 8.00,  quality: 0.90 },
  'gpt-4.1-mini':     { displayName: 'GPT-4.1 Mini',   input: 0.40,  output: 1.60,  quality: 0.75 },
  'gpt-4.1-nano':     { displayName: 'GPT-4.1 Nano',   input: 0.10,  output: 0.40,  quality: 0.60 },
  'o3':               { displayName: 'o3',              input: 2.00,  output: 8.00,  quality: 0.85 },
  'o3-mini':          { displayName: 'o3 Mini',         input: 1.10,  output: 4.40,  quality: 0.75 },
  'o4-mini':          { displayName: 'o4 Mini',         input: 1.10,  output: 4.40,  quality: 0.75 },
  'gpt-4-turbo':      { displayName: 'GPT-4 Turbo',    input: 10.00, output: 30.00, quality: 0.88 },
  'gpt-4':            { displayName: 'GPT-4',           input: 30.00, output: 60.00, quality: 0.88 },
  'gpt-3.5-turbo':    { displayName: 'GPT-3.5 Turbo',  input: 0.50,  output: 1.50,  quality: 0.65 },
};

const ANTHROPIC_PRICING_REGISTRY: Record<string, KnownModelPricing> = {
  'claude-opus-4-20250514':      { displayName: 'Claude Opus 4',        input: 15.00, output: 75.00, quality: 0.95 },
  'claude-sonnet-4-20250514':    { displayName: 'Claude Sonnet 4',      input: 3.00,  output: 15.00, quality: 0.85 },
  'claude-haiku-4-20250414':     { displayName: 'Claude Haiku 4',       input: 1.00,  output: 5.00,  quality: 0.70 },
  'claude-3-5-sonnet-20241022':  { displayName: 'Claude 3.5 Sonnet',    input: 3.00,  output: 15.00, quality: 0.85 },
  'claude-3-5-haiku-20241022':   { displayName: 'Claude 3.5 Haiku',     input: 1.00,  output: 5.00,  quality: 0.70 },
  'claude-3-opus-20240229':      { displayName: 'Claude 3 Opus',        input: 15.00, output: 75.00, quality: 0.92 },
  'claude-3-sonnet-20240229':    { displayName: 'Claude 3 Sonnet',      input: 3.00,  output: 15.00, quality: 0.82 },
  'claude-3-haiku-20240307':     { displayName: 'Claude 3 Haiku',       input: 0.25,  output: 1.25,  quality: 0.68 },
};

export interface SyncResult {
  provider: string;
  discovered: number;
  matched: number;
  upserted: number;
  errors: string[];
}

export interface PricingSyncReport {
  results: SyncResult[];
  totalUpserted: number;
  syncedAt: string;
}

// ─── Fetch models from OpenAI ────────────────────────────────

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { data: Array<{ id: string }> };
  return body.data.map(m => m.id);
}

// ─── Fetch models from Anthropic ─────────────────────────────

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { data: Array<{ id: string }> };
  return body.data.map(m => m.id);
}

// ─── Match models against registry ───────────────────────────

function matchModels(
  discoveredIds: string[],
  registry: Record<string, KnownModelPricing>,
): Array<{ modelId: string; pricing: KnownModelPricing }> {
  const matches: Array<{ modelId: string; pricing: KnownModelPricing }> = [];
  for (const id of discoveredIds) {
    // Exact match
    if (registry[id]) {
      matches.push({ modelId: id, pricing: registry[id] });
      continue;
    }
    // Prefix match (e.g., 'gpt-4o-2024-08-06' → 'gpt-4o')
    for (const [registryId, pricing] of Object.entries(registry)) {
      if (id.startsWith(registryId + '-') || id.startsWith(registryId + ':')) {
        matches.push({ modelId: id, pricing });
        break;
      }
    }
  }
  return matches;
}

// ─── Main sync function ──────────────────────────────────────

export async function syncModelPricing(
  db: DatabaseAdapter,
  providers: Record<string, { apiKey?: string }>,
): Promise<PricingSyncReport> {
  const results: SyncResult[] = [];
  let totalUpserted = 0;
  const syncedAt = new Date().toISOString();

  for (const [provider, config] of Object.entries(providers)) {
    const result: SyncResult = { provider, discovered: 0, matched: 0, upserted: 0, errors: [] };

    try {
      let discoveredIds: string[];
      let registry: Record<string, KnownModelPricing>;

      if (provider === 'openai') {
        if (!config.apiKey) {
          result.errors.push('Missing apiKey — skipped');
          results.push(result);
          continue;
        }
        discoveredIds = await fetchOpenAIModels(config.apiKey);
        registry = OPENAI_PRICING_REGISTRY;
      } else if (provider === 'anthropic') {
        if (!config.apiKey) {
          result.errors.push('Missing apiKey — skipped');
          results.push(result);
          continue;
        }
        discoveredIds = await fetchAnthropicModels(config.apiKey);
        registry = ANTHROPIC_PRICING_REGISTRY;
      } else {
        result.errors.push(`Unknown provider "${provider}" — skipped`);
        results.push(result);
        continue;
      }

      result.discovered = discoveredIds.length;
      const matched = matchModels(discoveredIds, registry);
      result.matched = matched.length;

      for (const { modelId, pricing } of matched) {
        const id = `mp-${provider}-${modelId}`.replace(/[^a-zA-Z0-9-]/g, '-');
        const row: Omit<ModelPricingRow, 'created_at' | 'updated_at'> = {
          id,
          model_id: modelId,
          provider,
          display_name: pricing.displayName,
          input_cost_per_1m: pricing.input,
          output_cost_per_1m: pricing.output,
          quality_score: pricing.quality,
          source: 'sync',
          last_synced_at: syncedAt,
          enabled: 1,
        };
        await db.upsertModelPricing(row);
        result.upserted++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
    }

    totalUpserted += result.upserted;
    results.push(result);
  }

  return { results, totalUpserted, syncedAt };
}
