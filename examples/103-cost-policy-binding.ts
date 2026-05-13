/**
 * Example 103 — Cost Governor Phase 2: DB-driven cost policy resolution
 *
 * Demonstrates `@weaveintel/cost-governor` Phase 2 in pure-process mode
 * (no DB, no LLM, no external services).
 *
 * Covers:
 *   1. `weaveStaticCostPolicyResolver` — pinned single policy.
 *   2. A custom in-memory `CostPolicyResolver` that mimics the DB-backed
 *      resolver geneweave ships (`agent > mesh > workflow` precedence).
 *   3. `composeCostPolicyResolvers` — chain a per-tenant resolver in
 *      front of a static fallback.
 *   4. Per-run override via `perRunOverride` on the resolution context.
 *   5. Tier-preset merge — partial overrides on top of `TIER_PRESETS`.
 *   6. `resolveCostGovernorBundle` — one call returns a governor +
 *      provenance for audit logging.
 *
 * Run:   npx tsx examples/103-cost-policy-binding.ts
 */

import {
  TIER_PRESETS,
  resolveCostPolicy,
  weaveCostGovernor,
  weaveStaticCostPolicyResolver,
  composeCostPolicyResolvers,
  resolveCostGovernorBundle,
  type CostPolicy,
  type CostPolicyResolver,
  type CostPolicyResolutionContext,
  type ResolvedCostPolicyBinding,
} from '@weaveintel/cost-governor';

console.log('=== Cost Governor Phase 2 demo ===\n');

// 1. Pinned static resolver
const staticResolver = weaveStaticCostPolicyResolver({ tier: 'economy' });
console.log('1. static resolver →', await staticResolver.resolve({}));

// 2. Custom in-memory resolver mirroring DB binding shape
type Binding = {
  bindingKind: 'agent' | 'mesh' | 'workflow';
  bindingRef: string;
  policyKey: string;
  precedence: number;
};
const policies: Record<string, CostPolicy> = {
  'tenant.economy': { tier: 'economy', description: 'cheapest acceptable' },
  'tenant.perf':    { tier: 'performance', description: 'low latency' },
  'tenant.custom':  { tier: 'custom', maxCostUsdPerRun: 0.05, hardKillOnCeiling: true },
};
const bindings: Binding[] = [
  { bindingKind: 'mesh',     bindingRef: 'mesh-1',  policyKey: 'tenant.economy', precedence: 50 },
  { bindingKind: 'agent',    bindingRef: 'agent-A', policyKey: 'tenant.perf',    precedence: 100 },
  { bindingKind: 'workflow', bindingRef: 'wf-9',    policyKey: 'tenant.custom',  precedence: 10 },
];

const dbResolver: CostPolicyResolver = {
  async resolve(ctx: CostPolicyResolutionContext): Promise<ResolvedCostPolicyBinding | null> {
    const candidates = bindings
      .filter((b) =>
        (b.bindingKind === 'agent'    && b.bindingRef === ctx.agentId)    ||
        (b.bindingKind === 'mesh'     && b.bindingRef === ctx.meshId)     ||
        (b.bindingKind === 'workflow' && b.bindingRef === ctx.workflowId)
      )
      .sort((a, b) => b.precedence - a.precedence);
    const winner = candidates[0];
    if (!winner) return null;
    const policy = policies[winner.policyKey];
    if (!policy) return null;
    return {
      policy,
      source: `${winner.bindingKind}_binding` as ResolvedCostPolicyBinding['source'],
      bindingId: `bind-${winner.bindingRef}`,
      policyId: winner.policyKey,
    };
  },
};

console.log('\n2a. agent A on mesh-1 (agent precedence wins) →');
console.log(await dbResolver.resolve({ agentId: 'agent-A', meshId: 'mesh-1' }));

console.log('\n2b. some other agent on mesh-1 (mesh wins) →');
console.log(await dbResolver.resolve({ agentId: 'agent-Z', meshId: 'mesh-1' }));

console.log('\n2c. unknown ids (no binding) →');
console.log(await dbResolver.resolve({ agentId: 'nope' }));

// 3. Composed: tenant DB resolver in front of static fallback
const composed = composeCostPolicyResolvers([dbResolver, staticResolver]);
console.log('\n3. composed resolver, unknown ids → falls back to static economy →');
console.log(await composed.resolve({ agentId: 'nope' }));

// 4. Per-run override beats DB binding
console.log('\n4. per-run override beats binding →');
const overridden = await resolveCostGovernorBundle(composed, {
  agentId: 'agent-A',
  meshId: 'mesh-1',
  perRunOverride: { tier: 'max' },
});
console.log('   binding.source =', overridden.binding.source, ', tier =', overridden.binding.policy.tier);

// 5. Tier-preset merge — partial overrides land on top of the tier preset
const merged = resolveCostPolicy({
  tier: 'balanced',
  maxStepsCap: 99,                  // override balanced default (40)
  reasoningEffort: 'high',          // override balanced default ('medium')
});
console.log('\n5. balanced tier with overrides → maxStepsCap=', merged.maxStepsCap,
            ', reasoningEffort=', merged.reasoningEffort,
            ', historyCompaction (from preset)=', merged.historyCompaction.strategy,
            ', budgetCeilingUsd (from preset)=', merged.budgetCeilingUsd);

// 6. End-to-end bundle with provenance for audit logging
console.log('\n6. resolveCostGovernorBundle for agent-A →');
const result = await resolveCostGovernorBundle(composed, {
  agentId: 'agent-A',
  meshId: 'mesh-1',
});
console.log('   source     =', result.binding.source);
console.log('   policyId   =', result.binding.policyId);
console.log('   tier       =', result.binding.policy.tier);
console.log('   bundle has =', Object.keys(result.bundle).join(', '));

// Sanity: every preset still resolves cleanly via weaveCostGovernor
console.log('\n7. preset sanity:');
for (const tier of Object.keys(TIER_PRESETS) as Array<keyof typeof TIER_PRESETS>) {
  const b = weaveCostGovernor({ tier });
  console.log(`   ${tier.padEnd(12)} → bundle keys: ${Object.keys(b).join(', ')}`);
}

console.log('\n=== done ===');
