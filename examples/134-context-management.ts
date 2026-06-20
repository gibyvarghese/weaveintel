/**
 * Example 134 — Context window management (P2-3)
 *
 * Demonstrates all three context management strategies:
 *  - trim_oldest:    drops oldest non-system message groups when over budget
 *  - sliding_window: keeps only the N most recent groups
 *  - summarize:      condenses old turns via memory.summarize() then trims
 *
 * Key invariants enforced:
 *  1. System messages are NEVER removed.
 *  2. tool_use + tool_result message pairs are NEVER split.
 *
 * Usage:
 *   npx ts-node examples/134-context-management.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import type { AgentMemory, ExecutionContext, Message } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { estimateTokens } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

// ── Track what the model actually receives ────────────────────────────────────

function trackingModel(label: string) {
  const seenMessages: Message[][] = [];
  const base = createMockModel({ name: label, responses: ['done'] });
  const m = {
    ...base,
    seenMessages,
    async generate(ctx: ExecutionContext, req: { messages: Message[] }) {
      seenMessages.push([...req.messages]);
      return base.generate(ctx, req);
    },
  };
  return m;
}

// ── Build a long conversation history ────────────────────────────────────────

function makeLongHistory(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: `This is turn ${i + 1} user message. ${'detail '.repeat(20)}` });
    msgs.push({ role: 'assistant', content: `This is turn ${i + 1} assistant response. ${'answer '.repeat(20)}` });
  }
  return msgs;
}

const runtime = weaveRuntime({ audit: { async log() {} } });
const ctx = weaveContext({ runtime });

const longHistory = makeLongHistory(10);
console.log(`History size: ~${estimateTokens(longHistory)} tokens`);

// ── Strategy 1: trim_oldest ───────────────────────────────────────────────────

console.log('\n=== Strategy: trim_oldest (budget = 200 tokens) ===');
const model1 = trackingModel('trim-model');
const agent1 = weaveAgent({
  model: model1,
  name: 'trim-agent',
  systemPrompt: 'You are a helpful assistant.',
  contextManagement: { strategy: 'trim_oldest', maxTokens: 200 },
});
await agent1.run(ctx, {
  messages: [...longHistory.slice(1), { role: 'user', content: 'What did we discuss?' }],
});
const seen1 = model1.seenMessages[0]!;
console.log(`Model received ${seen1.length} messages (~${estimateTokens(seen1)} tokens)`);
console.log(`System message preserved: ${seen1[0]?.role === 'system'}`);
console.log(`Oldest user turns dropped: ${!seen1.some((m) => m.content?.includes('turn 1'))}`);

// ── Strategy 2: sliding_window ────────────────────────────────────────────────

console.log('\n=== Strategy: sliding_window (last 3 groups) ===');
const model2 = trackingModel('window-model');
const agent2 = weaveAgent({
  model: model2,
  name: 'window-agent',
  systemPrompt: 'You are a helpful assistant.',
  contextManagement: { strategy: 'sliding_window', maxTokens: 1, slidingWindowSize: 3 },
});
await agent2.run(ctx, {
  messages: [...longHistory.slice(1), { role: 'user', content: 'Summarise the last thing we talked about.' }],
});
const seen2 = model2.seenMessages[0]!;
const nonSystem2 = seen2.filter((m) => m.role !== 'system');
console.log(`Non-system messages kept: ${nonSystem2.length} (of ${longHistory.length - 1} original)`);
console.log(`Most recent content present: ${seen2.some((m) => m.content?.includes('turn 10'))}`);

// ── Strategy 3: summarize ─────────────────────────────────────────────────────

console.log('\n=== Strategy: summarize (custom memory.summarize) ===');
const summaryCalls: string[] = [];
const memory: AgentMemory = {
  async getMessages() { return []; },
  async addMessage() {},
  async clear() {},
  async summarize(ctx) {
    summaryCalls.push('called');
    return 'We discussed 10 turns of questions and answers about various topics.';
  },
};

const model3 = trackingModel('summarize-model');
const agent3 = weaveAgent({
  model: model3,
  name: 'summarize-agent',
  systemPrompt: 'You are a helpful assistant.',
  memory,
  contextManagement: { strategy: 'summarize', maxTokens: 200 },
});
await agent3.run(ctx, {
  messages: [...longHistory.slice(1), { role: 'user', content: 'Continue the discussion.' }],
});
const seen3 = model3.seenMessages[0]!;
console.log(`summarize() called: ${summaryCalls.length > 0}`);
console.log(`Summary injected: ${seen3.some((m) => m.content?.includes('Conversation summary'))}`);
console.log(`Recent turns preserved: ${seen3.some((m) => m.content?.includes('turn 10'))}`);
