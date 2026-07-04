/**
 * Example 161 — Cross-process checkpoint resume (P5-1)
 *
 * Simulates a scenario where an agent run is interrupted mid-way (e.g. process
 * crash) and then resumed in a "new process" using the saved checkpoint.
 *
 * In a real deployment, replace `InMemoryCheckpointStore` with
 * `createSQLiteCheckpointStore(path)` so the state survives across process
 * restarts. The resume flow is identical regardless of the store backend.
 *
 * Scenarios:
 *   1. Interrupt after step 1, resume from checkpoint and complete
 *   2. Resume without stored checkpoint (starts fresh)
 *   3. Resume with maxChars-trimmed memory context
 *
 * Usage:
 *   npx ts-node examples/161-checkpoint-resume.ts
 */

import { weaveContext, weaveRuntime, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { Model, ModelResponse } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';
import { weaveAgent, resumeFromCheckpoint, InMemoryCheckpointStore } from '@weaveintel/agents';

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

function makeTool(name: string, result: string) {
  const t = weaveTool({
    name,
    description: `Tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => result,
  });
  const reg = weaveToolRegistry();
  reg.register(t);
  return reg;
}

// ─── Scenario 1: Interrupt then resume ───────────────────────

async function scenario1InterruptAndResume() {
  console.log('\n── Scenario 1: Interrupt mid-run then resume ──');

  const store = new InMemoryCheckpointStore();
  const runId = 'interrupted-run-1';

  // "Process 1": runs for 1 tool step then crashes (we just stop here)
  const tools = makeTool('search', 'search result: Paris is the capital of France');

  const phase1Model = stubModel([
    // Step 0: calls search tool — checkpoint saved
    { id: '1', model: 'stub', content: '', toolCalls: [{ id: 'tc1', name: 'search', arguments: '{}' }], finishReason: 'tool_calls', usage },
    // Step 1: would be terminal — but we "crash" before reaching it
    { id: '2', model: 'stub', content: "France's capital is Paris.", toolCalls: [], finishReason: 'stop', usage },
  ]);

  const agent1 = weaveAgent({
    model: phase1Model,
    tools,
    name: 'research-agent',
    maxSteps: 10,
    checkpoint: { store, runId, intervalSteps: 1 },
  });

  // We let it run (no actual crash here, but checkpoint is saved after step 0)
  const result1 = await agent1.run(makeCtx(), {
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    goal: 'capital of France',
  });
  console.log('Phase 1 status:', result1.status);
  console.log('Phase 1 output:', result1.output);

  const savedCp = await store.load(runId);
  console.log('Checkpoint stepIndex:', savedCp?.stepIndex);
  console.log('Checkpoint messages:', savedCp?.messages.length);

  // "Process 2": resumed agent continues from checkpoint
  if (savedCp) {
    const phase2Model = stubModel([
      { id: '3', model: 'stub', content: 'Confirmed: The capital of France is Paris.', toolCalls: [], finishReason: 'stop', usage },
    ]);

    const resumedAgent = resumeFromCheckpoint(savedCp, {
      model: phase2Model,
      tools,
      name: 'research-agent',
      maxSteps: 10,
      checkpoint: { store, runId },
    });

    const result2 = await resumedAgent.run(makeCtx(), {
      messages: [],  // empty — checkpoint provides the history
      goal: 'continue research',
    });
    console.log('Phase 2 (resumed) status:', result2.status);
    console.log('Phase 2 (resumed) output:', result2.output);
  }
}

// ─── Scenario 2: Resume without checkpoint (no-op, starts fresh) ──

async function scenario2NoCheckpointFallback() {
  console.log('\n── Scenario 2: Load non-existent checkpoint ──');

  const store = new InMemoryCheckpointStore();
  const cp = await store.load('non-existent-run');
  console.log('Checkpoint exists:', cp !== null);

  // Safe to use: if null, just run a fresh agent
  if (!cp) {
    const model = stubModel([
      { id: '1', model: 'stub', content: 'Fresh start — no checkpoint found.', toolCalls: [], finishReason: 'stop', usage },
    ]);
    const agent = weaveAgent({ model, name: 'fresh-agent', maxSteps: 5 });
    const result = await agent.run(makeCtx(), {
      messages: [{ role: 'user', content: 'Hello!' }],
      goal: 'fresh',
    });
    console.log('Fresh run output:', result.output);
  }
}

// ─── Scenario 3: Resume from completed checkpoint ─────────────

async function scenario3ResumeFromCompleted() {
  console.log('\n── Scenario 3: Resume from completed checkpoint ──');

  const store = new InMemoryCheckpointStore();
  const runId = 'completed-run-1';

  const model = stubModel([
    { id: '1', model: 'stub', content: 'Task complete on first run.', toolCalls: [], finishReason: 'stop', usage },
  ]);

  const agent = weaveAgent({
    model,
    name: 'quick-agent',
    maxSteps: 5,
    checkpoint: { store, runId },
  });

  await agent.run(makeCtx(), {
    messages: [{ role: 'user', content: 'Quick task.' }],
    goal: 'quick task',
  });

  const cp = await store.load(runId);
  console.log('Completed checkpoint status:', cp?.status);
  console.log('Messages in completed checkpoint:', cp?.messages.length);

  // Resuming a completed run — the resume agent will just respond to the
  // additional user message since the conversation history is pre-seeded.
  if (cp) {
    const resumeModel = stubModel([
      { id: '2', model: 'stub', content: 'I already completed the task in the previous run.', toolCalls: [], finishReason: 'stop', usage },
    ]);
    const resumed = resumeFromCheckpoint(cp, { model: resumeModel, name: 'quick-agent', maxSteps: 5 });
    const result = await resumed.run(makeCtx(), {
      messages: [{ role: 'user', content: 'What did you find?' }],
      goal: 'follow-up',
    });
    console.log('Resumed follow-up output:', result.output);
  }
}

// ─── Run all scenarios ────────────────────────────────────────

(async () => {
  await scenario1InterruptAndResume();
  await scenario2NoCheckpointFallback();
  await scenario3ResumeFromCompleted();
  console.log('\n✓ All checkpoint/resume scenarios complete.');
})().catch(console.error);
