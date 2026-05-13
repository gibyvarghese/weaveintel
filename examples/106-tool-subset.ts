/**
 * Example 106 — Cost Governor Phase 5: Dynamic Tool Subset (L3 lever).
 *
 * Demonstrates the @weaveintel/cost-governor toolFilter capability:
 *
 *   1. `decideToolSubset(config, availableKeys, ctx)` — pure decision.
 *   2. `weaveToolSubsetFilter(config)` — produces a `CostToolFilter`.
 *   3. `applyToolFilterToRegistry(...)` — narrows a real ToolRegistry.
 *   4. `weaveCostGovernor(policy)` — wires the filter onto the bundle.
 *
 * No DB, no LLM, no external services. Pure in-process demo.
 *
 * Production wiring (geneweave): the kaggle heartbeat resolves the policy
 * via `DbCostPolicyResolver` and supplies a `costToolFilter` closure to
 * the strategist `prepare()` method, which narrows the live tool registry
 * before the ReAct loop. Operators edit `cost_policies.levers_json` to
 * change the per-phase tool keys without redeploying code.
 */
import {
  weaveToolRegistry as createToolRegistry,
  weaveTool as defineTool,
} from '@weaveintel/core';
import {
  decideToolSubset,
  weaveToolSubsetFilter,
  applyToolFilterToRegistry,
  weaveCostGovernor,
  type ToolSubsetConfig,
} from '@weaveintel/cost-governor';

// ---------------------------------------------------------------------------
// 1. Build a fake tool registry of 6 kaggle-style tools.
// ---------------------------------------------------------------------------
function buildKaggleRegistry() {
  const reg = createToolRegistry();
  for (const name of [
    'kaggle_list_competitions',
    'kaggle_get_competition',
    'kaggle_push_kernel',
    'kaggle_wait_for_kernel',
    'kaggle_get_kernel_output',
    'web_search',
  ]) {
    reg.register(
      defineTool({
        name,
        description: `stub ${name}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: 'ok' }),
      }),
    );
  }
  return reg;
}

// ---------------------------------------------------------------------------
// 2. Operator-edited config (read from `cost_policies.levers_json` in prod).
// ---------------------------------------------------------------------------
const config: ToolSubsetConfig = {
  strategy: 'phase',
  phases: {
    discovery: ['kaggle_list_competitions', 'kaggle_get_competition', 'web_search'],
    kernel: ['kaggle_push_kernel', 'kaggle_wait_for_kernel', 'kaggle_get_kernel_output'],
    improvement: [
      'kaggle_push_kernel',
      'kaggle_wait_for_kernel',
      'kaggle_get_kernel_output',
      'kaggle_list_competitions',
    ],
  },
};

console.log('=== Phase 5 — Dynamic Tool Subset ===\n');

// ---------------------------------------------------------------------------
// 3. Pure decision API.
// ---------------------------------------------------------------------------
console.log('Pure decideToolSubset() across phases:');
for (const phase of ['discovery', 'kernel', 'improvement', 'unknown_phase'] as const) {
  const allKeys = [
    'kaggle_list_competitions',
    'kaggle_get_competition',
    'kaggle_push_kernel',
    'kaggle_wait_for_kernel',
    'kaggle_get_kernel_output',
    'web_search',
  ];
  const decision = decideToolSubset(config, allKeys, { phase, agentRole: 'strategist' });
  console.log(
    `  phase=${phase.padEnd(15)} filtered=${decision.filtered} kept=[${decision.keep.join(', ')}] reason=${decision.reason}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Pass-through cases (filter is NEVER load-bearing).
// ---------------------------------------------------------------------------
console.log('\nPass-through guarantees:');
const passNull = decideToolSubset(null, ['a', 'b'], { phase: 'discovery' });
console.log(`  null config         → filtered=${passNull.filtered} (kept all)`);
const passAll = decideToolSubset({ strategy: 'all', phases: {} }, ['a', 'b'], { phase: 'discovery' });
console.log(`  strategy='all'      → filtered=${passAll.filtered} (kept all)`);
const passMissing = decideToolSubset(config, ['a', 'b'], {});
console.log(`  no phase ctx        → filtered=${passMissing.filtered} (kept all)`);
const passZero = decideToolSubset(
  config,
  ['unrelated_tool'],
  { phase: 'discovery' },
);
console.log(`  zero overlap        → filtered=${passZero.filtered} kept=[${passZero.keep.join(', ')}]`);

// ---------------------------------------------------------------------------
// 5. CostToolFilter factory (the shape the bundle exposes).
// ---------------------------------------------------------------------------
console.log('\nweaveToolSubsetFilter() factory:');
const filter = weaveToolSubsetFilter(config);
const allKeys = [
  'kaggle_list_competitions',
  'kaggle_get_competition',
  'kaggle_push_kernel',
  'kaggle_wait_for_kernel',
  'kaggle_get_kernel_output',
  'web_search',
];
const keepDiscovery = await filter(allKeys, { phase: 'discovery', agentRole: 'strategist' });
console.log(`  filter('discovery') → kept=${keepDiscovery?.length ?? 'pass-through (null)'} of ${allKeys.length}`);
const keepKernel = await filter(allKeys, { phase: 'kernel', agentRole: 'strategist' });
console.log(`  filter('kernel')    → kept=${keepKernel?.length ?? 'pass-through (null)'} of ${allKeys.length}`);

// ---------------------------------------------------------------------------
// 6. applyToolFilterToRegistry — narrow a real registry.
// ---------------------------------------------------------------------------
console.log('\napplyToolFilterToRegistry() narrows a live ToolRegistry:');
const source = buildKaggleRegistry();
const target = createToolRegistry();
const result = await applyToolFilterToRegistry(source, filter, { phase: 'kernel' }, target);
console.log(
  `  phase=kernel kept=${result.kept.length} dropped=${result.dropped.length} filtered=${result.filtered}`,
);
console.log(`    kept: [${result.kept.join(', ')}]`);
console.log(`    dropped: [${result.dropped.join(', ')}]`);

// ---------------------------------------------------------------------------
// 7. weaveCostGovernor — bundle integration.
// ---------------------------------------------------------------------------
console.log('\nweaveCostGovernor() bundle exposes toolFilter:');
const bundle = weaveCostGovernor({ tier: 'balanced', toolSubset: config });
const bundleResult = await bundle.toolFilter(allKeys, { phase: 'improvement' });
console.log(
  `  bundle.toolFilter(phase=improvement) → kept=${bundleResult?.length ?? 'pass-through'} of ${allKeys.length}`,
);

// Pass-through bundle when strategy='all' (e.g. tier='max').
const maxBundle = weaveCostGovernor({ tier: 'max' });
const maxResult = await maxBundle.toolFilter(allKeys, { phase: 'kernel' });
console.log(
  `  tier='max' bundle.toolFilter        → ${maxResult === null ? 'pass-through (null)' : `kept=${maxResult.length}`}`,
);

console.log('\n✓ Phase 5 demo complete.');
