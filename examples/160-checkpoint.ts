/**
 * Example 160 — Agent checkpoint (P5-1)
 *
 * Demonstrates saving agent run state to an `InMemoryCheckpointStore` as a
 * simulated agent progresses through tool-call steps. After the run completes
 * the example shows how to inspect the stored checkpoint.
 *
 * Scenarios:
 *   1. Basic run with per-step checkpointing
 *   2. Checkpoint saved on budget_exceeded early termination
 *   3. Custom run ID for checkpoint lookup
 *
 * Usage:
 *   npx ts-node examples/160-checkpoint.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import type { Model, ModelResponse } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';
import { weaveAgent, InMemoryCheckpointStore } from '@weaveintel/agents';
import { weaveTool, weaveToolRegistry } from '@weaveintel/core';

const runtime = weaveRuntime({});
const makeCtx = () => weaveContext({ runtime });

function makeToolCallingModel(responses: ModelResponse[]): Model {
  const caps = new Set([Capabilities.Chat]);
  let idx = 0;
  return {
    info: { provider: 'stub', modelId: 'stub', capabilities: caps },
    capabilities: caps,
    hasCapability: (c) => caps.has(c),
    async generate(_ctx, _req) {
      const r = responses[idx++ % responses.length]!;
      return r;
    },
  };
}

// ─── Scenario 1: Per-step checkpointing ──────────────────────

async function scenario1PerStepCheckpoint() {
  console.log('\n── Scenario 1: Per-step checkpointing ──');

  const store = new InMemoryCheckpointStore();
  const runId = 'demo-run-001';

  // Counter tool to simulate 2 tool calls
  const counterTool = weaveTool({
    name: 'increment',
    description: 'Increment a counter',
    parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    execute: async (args) => `incremented to ${Number(args.value) + 1}`,
  });
  const tools = weaveToolRegistry();
  tools.register(counterTool);

  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  const model = makeToolCallingModel([
    { id: '1', model: 'stub', content: '', toolCalls: [{ id: 'tc1', name: 'increment', arguments: '{"value":0}' }], finishReason: 'tool_calls', usage },
    { id: '2', model: 'stub', content: '', toolCalls: [{ id: 'tc2', name: 'increment', arguments: '{"value":1}' }], finishReason: 'tool_calls', usage },
    { id: '3', model: 'stub', content: 'Counter reached 2. Done.', toolCalls: [], finishReason: 'stop', usage },
  ]);

  const agent = weaveAgent({
    model,
    tools,
    name: 'counter-agent',
    maxSteps: 10,
    checkpoint: {
      store,
      intervalSteps: 1,  // save after every step
      runId,
    },
  });

  const result = await agent.run(makeCtx(), {
    messages: [{ role: 'user', content: 'Increment the counter twice.' }],
    goal: 'Increment counter twice',
  });

  console.log('Run status:', result.status);
  console.log('Output:', result.output);
  console.log('Checkpoints stored:', store.size);

  const cp = await store.load(runId);
  console.log('Last checkpoint stepIndex:', cp?.stepIndex);
  console.log('Last checkpoint status:', cp?.status);
  console.log('Last checkpoint messages count:', cp?.messages.length);
}

// ─── Scenario 2: Checkpoint on budget_exceeded ────────────────

async function scenario2BudgetExceededCheckpoint() {
  console.log('\n── Scenario 2: Checkpoint on budget_exceeded ──');

  const store = new InMemoryCheckpointStore();
  const usage = { promptTokens: 600, completionTokens: 500, totalTokens: 1100 };

  const model = makeToolCallingModel([
    { id: '1', model: 'stub', content: '', toolCalls: [{ id: 'tc1', name: 'noop', arguments: '{}' }], finishReason: 'tool_calls', usage },
    { id: '2', model: 'stub', content: 'done', toolCalls: [], finishReason: 'stop', usage },
  ]);

  const noopTool = weaveTool({
    name: 'noop',
    description: 'Does nothing',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
  const tools = weaveToolRegistry();
  tools.register(noopTool);

  const agent = weaveAgent({
    model,
    tools,
    name: 'budget-test-agent',
    maxSteps: 10,
    checkpoint: { store, intervalSteps: 1 },
  });

  // Config maxTokenBudget at 500 — will hit on step 1 (600 prompt tokens > 500)
  (agent.config as { maxTokenBudget?: number }).maxTokenBudget = 500;

  const result = await agent.run(makeCtx(), {
    messages: [{ role: 'user', content: 'Run until budget exceeded.' }],
    goal: 'budget test',
  });

  console.log('Run status:', result.status); // should be 'budget_exceeded'
  const checkpoints = await store.list('budget-test-agent');
  const terminalCp = checkpoints.find(c => c.status === 'budget_exceeded');
  console.log('Terminal checkpoint found:', !!terminalCp);
  console.log('Terminal status:', terminalCp?.status);
}

// ─── Scenario 3: Custom run ID + list checkpoints ────────────

async function scenario3CustomRunIdAndList() {
  console.log('\n── Scenario 3: Custom run ID + list all checkpoints ──');

  const store = new InMemoryCheckpointStore();
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

  for (let runNum = 1; runNum <= 3; runNum++) {
    const model = makeToolCallingModel([
      { id: '1', model: 'stub', content: `Run ${runNum} complete.`, toolCalls: [], finishReason: 'stop', usage },
    ]);

    const agent = weaveAgent({
      model,
      name: 'multi-run-agent',
      maxSteps: 5,
      checkpoint: { store, runId: `run-${runNum}` },
    });

    await agent.run(makeCtx(), {
      messages: [{ role: 'user', content: `Run number ${runNum}` }],
      goal: `run ${runNum}`,
    });
  }

  const allCheckpoints = await store.list('multi-run-agent');
  console.log('Total checkpoints:', allCheckpoints.length);
  for (const cp of allCheckpoints) {
    console.log(` - runId: ${cp.runId}, status: ${cp.status}, steps: ${cp.stepIndex}`);
  }
}

// ─── Run all scenarios ────────────────────────────────────────

(async () => {
  await scenario1PerStepCheckpoint();
  await scenario2BudgetExceededCheckpoint();
  await scenario3CustomRunIdAndList();
  console.log('\n✓ All checkpoint scenarios complete.');
})().catch(console.error);
