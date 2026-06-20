/**
 * Example 132 — Parallel tool execution (P2-1)
 *
 * Demonstrates how weaveAgent executes multiple tool calls returned in a single
 * model response concurrently via Promise.all.  All tool results are collected
 * before the next model call, preserving the original call order in the
 * conversation history.
 *
 * Usage:
 *   npx ts-node examples/132-parallel-tools.ts
 */

import { weaveContext, weaveRuntime, weaveToolRegistry } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

// ── Mock tools with artificial latency ───────────────────────────────────────

function latencyTool(name: string, ms: number): Tool {
  return {
    schema: {
      name,
      description: `Simulates a ${ms}ms API call`,
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    async invoke(_ctx, tc) {
      await new Promise((r) => setTimeout(r, ms));
      return { content: `${name} result for "${(tc.arguments as { query?: string }).query ?? 'n/a'}"` };
    },
  };
}

// ── Model that returns two tool calls in a single response ────────────────────

let callIndex = 0;
const model = createMockModel({
  name: 'demo-model',
  responses: ['parallel tools done'],
});

const originalGenerate = model.generate.bind(model);
(model as typeof model & { generate: typeof model.generate }).generate = async (ctx, req) => {
  callIndex++;
  if (callIndex === 1) {
    // First call: return two tool calls simultaneously
    return {
      id: 'r1',
      model: 'demo-model',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'fetch_weather', arguments: '{"query":"London"}' },
        { id: 'tc2', name: 'fetch_stocks',  arguments: '{"query":"AAPL"}' },
      ],
      finishReason: 'tool_calls',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }
  // After tool results, return final answer
  return originalGenerate(ctx, req);
};

// ── Setup ─────────────────────────────────────────────────────────────────────

const tools = weaveToolRegistry();
tools.register(latencyTool('fetch_weather', 80));
tools.register(latencyTool('fetch_stocks',  40));

const runtime = weaveRuntime({ audit: { async log(e) { console.log('[audit]', e.action); } } });
const ctx = weaveContext({ runtime });

const agent = weaveAgent({
  model,
  tools,
  name: 'parallel-demo',
  parallelToolCalls: true, // default — shown explicitly for clarity
  maxSteps: 5,
});

// ── Run ───────────────────────────────────────────────────────────────────────

const t0 = Date.now();
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is the weather in London and the AAPL stock price?' }],
});
const elapsed = Date.now() - t0;

console.log('\n=== Result ===');
console.log('Status:', result.status);
console.log('Output:', result.output);
console.log('Steps:');
for (const step of result.steps) {
  if (step.type === 'tool_call') {
    console.log(`  [tool] ${step.toolCall?.name} → ${step.toolCall?.result}`);
  }
}
console.log(`\nTotal time: ${elapsed}ms`);
console.log('(Sequential would take ~120ms; parallel takes ~80ms)');
