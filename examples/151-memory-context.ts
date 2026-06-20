/**
 * Example 151 — Proactive memory context injection (P4-2)
 *
 * Demonstrates the `memoryContext` option in `ToolCallingAgentOptions`:
 * - The `retrieve` hook is called before each model.generate() call
 * - Retrieved context is prepended ephemerally to the system prompt
 * - The original `messages` array is never mutated
 * - maxChars prevents oversized context from crowding out the real prompt
 *
 * Scenarios:
 *   1. Agent receives personalized memory context before each turn
 *   2. Memory context is trimmed to maxChars when too large
 *   3. Context injection fails gracefully when retrieve throws
 *
 * Usage:
 *   npx ts-node examples/151-memory-context.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

const runtime = weaveRuntime({});

function makeCtx() {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// ─── Scenario 1: Personalized memory context injection ────────

async function scenario1PersonalizedContext() {
  console.log('\n── Scenario 1: Proactive memory context injection ──');

  const retrieveCallLog: string[] = [];

  const agent = weaveAgent({
    model: createMockModel([
      { content: 'Based on what I know about you: you enjoy coffee and prefer dark mode. How can I help?' },
    ]),
    name: 'personalised-agent',
    systemPrompt: 'You are a helpful assistant.',
    maxSteps: 3,
    memoryContext: {
      async retrieve(_ctx: ExecutionContext, userText: string) {
        retrieveCallLog.push(userText.slice(0, 50));
        // Simulate loading from a memory store
        return [
          '[User memory context]',
          '- Preference: coffee over tea',
          '- UI theme: dark mode',
          '- Recent topic: TypeScript best practices',
        ].join('\n');
      },
      maxChars: 2000,
    },
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Personalised greeting',
    messages: [{ role: 'user', content: 'Tell me what you know about my preferences.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('retrieve() called with queries:', retrieveCallLog);
}

// ─── Scenario 2: Context trimming at maxChars ─────────────────

async function scenario2ContextTrimming() {
  console.log('\n── Scenario 2: Memory context trimmed to maxChars ──');

  const HUGE_CONTEXT = 'Important memory: '.repeat(500); // ~9000 chars

  const agent = weaveAgent({
    model: createMockModel([
      { content: 'I will use the relevant parts of your memory context.' },
    ]),
    name: 'trim-agent',
    systemPrompt: 'You are a concise assistant.',
    maxSteps: 3,
    memoryContext: {
      retrieve: async () => HUGE_CONTEXT,
      maxChars: 200, // aggressive trim
    },
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Test trimming',
    messages: [{ role: 'user', content: 'Summarise what you know about me.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('HUGE_CONTEXT length:', HUGE_CONTEXT.length, '→ trimmed to 200 chars');
}

// ─── Scenario 3: Retrieve throws — graceful degradation ───────

async function scenario3RetrieveThrows() {
  console.log('\n── Scenario 3: retrieve() throws — agent continues gracefully ──');

  const agent = weaveAgent({
    model: createMockModel([
      { content: 'I could not access memory context but I am happy to help!' },
    ]),
    name: 'resilient-agent',
    systemPrompt: 'You are a helpful assistant.',
    maxSteps: 3,
    memoryContext: {
      retrieve: async () => {
        throw new Error('Memory service unavailable');
      },
    },
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Graceful failure',
    messages: [{ role: 'user', content: 'What do you remember about me?' }],
  });

  // Agent should still complete — retrieve error is caught internally
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 4: Multi-step — context refreshed each step ─────

async function scenario4MultiStepContextRefresh() {
  console.log('\n── Scenario 4: Context refreshed on each model.generate() call ──');

  let callCount = 0;

  const agent = weaveAgent({
    model: createMockModel([
      { toolCalls: [{ id: 'tc1', name: 'non_existent_tool', arguments: '{}' }] },
      { content: 'Task complete after using context on both steps.' },
    ]),
    name: 'multi-step-agent',
    maxSteps: 5,
    memoryContext: {
      async retrieve(_ctx: ExecutionContext, userText: string) {
        callCount++;
        return `[Memory snapshot #${callCount}] User asked: "${userText.slice(0, 30)}"`;
      },
    },
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Multi-step test',
    messages: [{ role: 'user', content: 'Do a multi-step operation.' }],
  });

  // retrieve() is called once per model.generate() invocation
  console.log('retrieve() call count:', callCount);
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1PersonalizedContext();
  await scenario2ContextTrimming();
  await scenario3RetrieveThrows();
  await scenario4MultiStepContextRefresh();
  console.log('\n✓ All memory context injection scenarios complete.');
})().catch(console.error);
