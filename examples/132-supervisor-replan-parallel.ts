/**
 * Example 132 — Supervisor re-plan + parallel delegation (W3)
 *
 * Demonstrates two supervisor enhancements:
 *   • `replanOnFailure` — when a worker returns no output the supervisor
 *     receives a REPLAN_REQUIRED signal and can revise its plan
 *   • `parallelDelegation` — adds `delegate_to_workers_parallel` batch tool
 *     so the supervisor can dispatch independent sub-tasks concurrently
 *
 * Both options are additive — existing supervisor behaviour is unchanged
 * when neither flag is set.
 *
 * Run: npx tsx examples/132-supervisor-replan-parallel.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext, Capabilities } from '@weaveintel/core';
import type { Model, ExecutionContext, ModelRequest, ModelResponse } from '@weaveintel/core';

const baseUsage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

function makeSequenceModel(name: string, responses: ModelResponse[]): Model {
  let call = 0;
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  return {
    info: { provider: 'stub', modelId: name, capabilities: caps, displayName: name },
    capabilities: caps,
    hasCapability(id) { return caps.has(id); },
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      const resp = responses[call % responses.length]!;
      call++;
      return resp;
    },
  };
}

async function main() {
  // ── Scenario A: Parallel delegation ──────────────────────────────────────
  console.log('=== Scenario A: Parallel delegation ===');

  const workerModel = makeSequenceModel('worker', [
    { id: 'w1', model: 'worker', content: 'Research complete: TypeScript is strongly typed.', toolCalls: [], finishReason: 'stop', usage: baseUsage },
  ]);

  // Supervisor: first calls delegate_to_workers_parallel, then synthesises
  const supervisorModel = makeSequenceModel('supervisor', [
    {
      id: 's1', model: 'supervisor', content: '', finishReason: 'tool_calls', usage: baseUsage,
      toolCalls: [{
        id: 'c1', name: 'delegate_to_workers_parallel',
        arguments: JSON.stringify({ tasks: [
          { worker: 'researcher', goal: 'Find facts about TypeScript' },
          { worker: 'writer', goal: 'Draft a brief overview' },
        ]}),
      }],
    },
    {
      id: 's2', model: 'supervisor', content: 'TypeScript overview: a strongly typed superset of JavaScript with excellent tooling.', toolCalls: [], finishReason: 'stop', usage: baseUsage,
    },
  ]);

  const agentA = weaveAgent({
    model: supervisorModel,
    maxSteps: 6,
    name: 'supervisor-parallel-demo',
    replanOnFailure: true,
    parallelDelegation: true,
    workers: [
      { name: 'researcher', description: 'Finds factual information', model: workerModel },
      { name: 'writer', description: 'Drafts written content', model: workerModel },
    ],
  });

  const ctx = weaveContext({});
  const resultA = await agentA.run(ctx, {
    messages: [{ role: 'user', content: 'Give me a TypeScript overview' }],
  });

  console.log('Status      :', resultA.status);
  console.log('Output      :', resultA.output);
  console.log('Steps       :', resultA.steps.length);

  // ── Scenario B: Replan on failure (worker returns empty output) ───────────
  console.log('\n=== Scenario B: Replan on failure ===');

  // Worker with empty content triggers replanOnFailure (!result.output)
  const emptyWorker = makeSequenceModel('empty-worker', [
    { id: 'ew1', model: 'empty-worker', content: '', toolCalls: [], finishReason: 'stop', usage: baseUsage },
  ]);

  // Supervisor: turn 1 → delegates (gets REPLAN_REQUIRED back), turn 2 → recovers
  const replanSupervisor = makeSequenceModel('replan-supervisor', [
    {
      id: 'rs1', model: 'replan-supervisor', content: '', finishReason: 'tool_calls', usage: baseUsage,
      toolCalls: [{ id: 'rc1', name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'flaky', goal: 'Summarize TypeScript' }) }],
    },
    {
      id: 'rs2', model: 'replan-supervisor', content: 'The worker failed so I will answer directly: TypeScript is a superset of JavaScript.', toolCalls: [], finishReason: 'stop', usage: baseUsage,
    },
  ]);

  const agentB = weaveAgent({
    model: replanSupervisor,
    maxSteps: 6,
    name: 'supervisor-replan-demo',
    replanOnFailure: true,
    workers: [
      { name: 'flaky', description: 'An unreliable worker', model: emptyWorker },
    ],
  });

  const resultB = await agentB.run(ctx, {
    messages: [{ role: 'user', content: 'Summarize TypeScript for me' }],
  });

  console.log('Status      :', resultB.status);
  console.log('Output      :', resultB.output);
  console.log('Steps       :', resultB.steps.length);

  // Find the tool result step to show the REPLAN_REQUIRED signal
  const delegateStep = resultB.steps.find((s) => s.toolCall?.name === 'delegate_to_worker');
  const toolResult = delegateStep?.toolCall?.result ?? '';
  console.log('REPLAN signal injected:', toolResult.includes('REPLAN_REQUIRED') ? 'YES ✓' : 'NO ✗');
  if (toolResult.includes('REPLAN_REQUIRED')) {
    console.log('Signal text :', toolResult.slice(0, 120).replace(/\n/g, ' '));
  }
}

main().catch(console.error);
