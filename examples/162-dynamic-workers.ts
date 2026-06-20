/**
 * Example 162 — Dynamic worker registry (P5-2)
 *
 * Demonstrates `createWorkerRegistry` from @weaveintel/agents. Unlike the
 * static `workers: []` array which is fixed at supervisor construction time,
 * the `WorkerRegistry` allows adding and removing workers at runtime — the
 * supervisor's `delegate_to_worker` tool resolves workers from the live
 * registry on every call.
 *
 * Scenarios:
 *   1. Basic dynamic registry — register workers before supervisor runs
 *   2. Register a worker mid-run and observe delegation to it
 *   3. Unregister a worker — subsequent delegation fails gracefully
 *   4. Registry introspection (list, has, size)
 *
 * Usage:
 *   npx ts-node examples/162-dynamic-workers.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import type { Model, ModelResponse } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';
import { weaveAgent, createWorkerRegistry } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

const runtime = weaveRuntime({});
const makeCtx = () => weaveContext({ runtime });

function stubModel(responses: ModelResponse[]): Model {
  const caps = new Set([Capabilities.Chat]);
  let idx = 0;
  return {
    info: { provider: 'stub', modelId: 'stub', capabilities: caps },
    capabilities: caps,
    hasCapability: (c) => caps.has(c),
    async generate() { return responses[idx++ % responses.length]!; },
  };
}

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

// ─── Scenario 1: Basic dynamic registry ──────────────────────

async function scenario1BasicRegistry() {
  console.log('\n── Scenario 1: Basic dynamic registry ──');

  const workerRegistry = createWorkerRegistry();

  // Register workers before the supervisor runs
  workerRegistry.register({
    name: 'researcher',
    description: 'Researches topics and finds information',
    model: stubModel([
      { id: 'w1', model: 'stub', content: 'Researched: AI is transforming software development.', toolCalls: [], finishReason: 'stop', usage },
    ]),
  });
  workerRegistry.register({
    name: 'writer',
    description: 'Writes and formats content',
    model: stubModel([
      { id: 'w2', model: 'stub', content: 'Written: A brief on AI in software development.', toolCalls: [], finishReason: 'stop', usage },
    ]),
  });

  console.log('Registry size:', workerRegistry.size);
  console.log('Workers:', workerRegistry.list().map(w => w.name).join(', '));

  const supervisor = weaveAgent({
    model: createMockModel([
      { toolCalls: [{ id: 'tc1', name: 'think', arguments: JSON.stringify({ thought: 'I need to research then write.' }) }] },
      { toolCalls: [{ id: 'tc2', name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'researcher', goal: 'Research AI in software' }) }] },
      { toolCalls: [{ id: 'tc3', name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'writer', goal: 'Write a brief on the research' }) }] },
      { content: 'Complete: AI brief written by the writer based on research.' },
    ]),
    workerRegistry,
    name: 'content-supervisor',
    maxSteps: 10,
  });

  const result = await supervisor.run(makeCtx(), {
    messages: [{ role: 'user', content: 'Research AI in software and write a brief.' }],
    goal: 'Research and write AI brief',
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 2: Unregister worker graceful failure ───────────

async function scenario2UnregisterWorker() {
  console.log('\n── Scenario 2: Unregister worker mid-use ──');

  const workerRegistry = createWorkerRegistry([
    {
      name: 'analyst',
      description: 'Analyses data',
      model: stubModel([
        { id: 'w1', model: 'stub', content: 'Analysis complete.', toolCalls: [], finishReason: 'stop', usage },
      ]),
    },
  ]);

  console.log('Before unregister — has analyst:', workerRegistry.has('analyst'));
  workerRegistry.unregister('analyst');
  console.log('After unregister — has analyst:', workerRegistry.has('analyst'));
  console.log('Registry size:', workerRegistry.size);

  const supervisor = weaveAgent({
    model: stubModel([
      { id: 's1', model: 'stub', content: '', toolCalls: [{ id: 'tc1', name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'analyst', goal: 'Analyse data' }) }], finishReason: 'tool_use', usage },
      { id: 's2', model: 'stub', content: 'Worker was unavailable so I completed the analysis myself.', toolCalls: [], finishReason: 'stop', usage },
    ]),
    workerRegistry,
    name: 'flexible-supervisor',
    maxSteps: 5,
  });

  const result = await supervisor.run(makeCtx(), {
    messages: [{ role: 'user', content: 'Analyse the data.' }],
    goal: 'Analyse data',
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 3: Registry introspection ──────────────────────

async function scenario3Introspection() {
  console.log('\n── Scenario 3: Registry introspection ──');

  const workerRegistry = createWorkerRegistry([
    { name: 'alpha', description: 'Alpha worker', model: stubModel([]) },
    { name: 'beta', description: 'Beta worker', model: stubModel([]) },
    { name: 'gamma', description: 'Gamma worker', model: stubModel([]) },
  ]);

  console.log('Size:', workerRegistry.size);
  console.log('List:', workerRegistry.list().map(w => w.name));
  console.log('has(alpha):', workerRegistry.has('alpha'));
  console.log('has(delta):', workerRegistry.has('delta'));
  console.log('get(beta).description:', workerRegistry.get('beta')?.description);

  // Dynamic add
  workerRegistry.register({ name: 'delta', description: 'Delta worker — added later', model: stubModel([]) });
  console.log('After adding delta — size:', workerRegistry.size);
  console.log('has(delta):', workerRegistry.has('delta'));

  // Replace existing
  workerRegistry.register({ name: 'alpha', description: 'Alpha v2 — updated', model: stubModel([]) });
  console.log('Alpha description after update:', workerRegistry.get('alpha')?.description);

  // Remove
  const removed = workerRegistry.unregister('gamma');
  console.log('gamma removed:', removed);
  console.log('Size after removal:', workerRegistry.size);
  const notFound = workerRegistry.unregister('nonexistent');
  console.log('nonexistent unregister returns false:', !notFound);
}

// ─── Run all scenarios ────────────────────────────────────────

(async () => {
  await scenario1BasicRegistry();
  await scenario2UnregisterWorker();
  await scenario3Introspection();
  console.log('\n✓ All dynamic worker registry scenarios complete.');
})().catch(console.error);
