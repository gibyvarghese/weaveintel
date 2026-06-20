/**
 * Example 165: Cost-aware agent routing (P6-3)
 *
 * Demonstrates integrating @weaveintel/cost-governor with weaveAgent to:
 *   - Track per-run token costs in a ledger
 *   - Compact conversation history before expensive model calls
 *   - Gate runs against a budget ceiling
 *   - Store cost breakdown in AgentResult.metadata.costBreakdown
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveCostGovernor, createInMemoryCostLedger } from '@weaveintel/cost-governor';
import type { ExecutionContext } from '@weaveintel/core';
import type { Model } from '@weaveintel/core';

// --- Stub model that simulates token costs ---

const model: Model = {
  async generate(_ctx, req) {
    const lastMsg = req.messages.at(-1);
    const content = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
    return {
      content: `Processed: ${content.slice(0, 50)}`,
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  },
};

// --- Build cost governor ---

// 'balanced' tier enables history compaction at 80% of budget and
// tool output truncation at 500 chars.
const bundle = weaveCostGovernor({ tier: 'balanced' });
const ledger = createInMemoryCostLedger();

const agent = weaveAgent({
  name: 'cost-aware-agent',
  model,
  costGovernor: {
    bundle,
    ledger,
    runId: 'demo-run-001',
    // pricing: myPricingResolver,  // optional: resolves $/1k tokens per model
  },
});

async function main(): Promise<void> {
  const ctx = { userId: 'cost-demo', sessionId: 'cost-governor-demo' } as ExecutionContext;

  // Run a multi-turn conversation
  console.log('=== Cost-Aware Agent Run ===');
  const result = await agent.run(ctx, {
    messages: [
      { role: 'user', content: 'Explain the concept of quantum entanglement in simple terms.' },
    ],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('Steps:', result.steps.length);
  console.log('Token usage:', JSON.stringify(result.usage));

  const costBreakdown = result.metadata?.['costBreakdown'];
  if (costBreakdown) {
    console.log('\n=== Cost Breakdown ===');
    console.log(JSON.stringify(costBreakdown, null, 2));
  } else {
    console.log('\nCost breakdown: not available (ledger or pricing resolver not wired)');
  }

  // Run another query in the same run to accumulate cost
  const result2 = await agent.run(ctx, {
    messages: [
      { role: 'user', content: 'Now explain quantum computing.' },
    ],
  });
  console.log('\n=== Second Run ===');
  console.log('Output:', result2.output);
  console.log('Token usage:', JSON.stringify(result2.usage));

  // Check governor bundle policy
  console.log('\n=== Governor Policy ===');
  console.log('Tier:', bundle.policy.tier);
  console.log('History compaction strategy:', bundle.policy.historyCompaction.strategy);
  console.log('Tool subset strategy:', bundle.policy.toolSubset.strategy);
}

main().catch(console.error);
