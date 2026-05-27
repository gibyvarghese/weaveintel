/**
 * @weaveintel/cost-governor — Default seed data
 *
 * Export: `DEFAULT_COST_POLICIES` — 4 framework cost tier rows.
 *
 * These cover the base tiers (economy → max). App-specific rows
 * (e.g. kaggle phase-driven tool subsets) belong in the app's own seed.
 *
 * @example
 * ```ts
 * import { DEFAULT_COST_POLICIES } from '@weaveintel/cost-governor';
 * const existing = await db.listCostPolicies();
 * const existingKeys = new Set(existing.map(p => p.key));
 * for (const p of DEFAULT_COST_POLICIES) {
 *   if (!existingKeys.has(p.key)) await db.createCostPolicy(p);
 * }
 * ```
 */

export type CostPolicySeedRow = {
  id: string;
  key: string;
  tier: string;
  levers_json: string;
  description: string;
  enabled: 0 | 1;
};

export const DEFAULT_COST_POLICIES: CostPolicySeedRow[] = [
  {
    id: '019700000-c057-7000-8000-000000000001',
    key: 'economy',
    tier: 'economy',
    levers_json: '{}',
    description: 'Cheapest tier: small models, aggressive caching, history compaction, minimal tools.',
    enabled: 1,
  },
  {
    id: '019700000-c057-7000-8000-000000000002',
    key: 'balanced',
    tier: 'balanced',
    levers_json: '{}',
    description: 'Default tier: balanced quality/cost. Caching enabled, moderate tool subset.',
    enabled: 1,
  },
  {
    id: '019700000-c057-7000-8000-000000000003',
    key: 'performance',
    tier: 'performance',
    levers_json: '{}',
    description: 'Higher quality tier: prefers stronger models, looser tool subset, caching still on.',
    enabled: 1,
  },
  {
    id: '019700000-c057-7000-8000-000000000004',
    key: 'max',
    tier: 'max',
    levers_json: '{}',
    description: 'Maximum quality tier: best models, all tools, full history, caching for prefix reuse only.',
    enabled: 1,
  },
];
