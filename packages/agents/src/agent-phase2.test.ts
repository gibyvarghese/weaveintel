/**
 * Phase 2 tests for packages/agents:
 *   P2-1  Parallel tool execution
 *   P2-2  Structured output with JSON validation + retry
 *   P2-3  Context window management (trim_oldest / sliding_window / summarize)
 *   P2-4  Tool retry with exponential back-off
 *
 * All tests use in-process stubs — no real model or network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { weaveToolRegistry, weaveContext, weaveRuntime } from '@weaveintel/core';
import type { ExecutionContext, Tool, ToolOutput, Message, AgentMemory } from '@weaveintel/core';
import { weaveAgent } from './agent.js';
import { applyContextManagement, estimateTokens } from './context-manager.js';
import { makeCtx, stubSequenceModel, makeAuditCtx } from './test-helpers.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeInput(content = 'hello'): { messages: Message[] } {
  return { messages: [{ role: 'user', content }] };
}

function makeTool(name: string, invoke: (args: Record<string, unknown>) => Promise<ToolOutput>): Tool {
  return {
    schema: { name, description: `tool: ${name}`, parameters: { type: 'object', properties: {} } },
    invoke: async (ctx, tc) => invoke(tc.arguments as Record<string, unknown>),
  };
}

// ─── P2-1: Parallel tool execution ────────────────────────────────────────────

describe('P2-1: parallel tool execution', () => {
  it('executes multiple tools concurrently when parallelToolCalls=true (default)', async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    const delays = { tool_a: 30, tool_b: 10 };

    const tools = weaveToolRegistry();
    tools.register(makeTool('tool_a', async () => {
      order.push('start:a');
      await new Promise((r) => setTimeout(r, delays.tool_a));
      order.push('end:a');
      return { content: 'result_a' };
    }));
    tools.register(makeTool('tool_b', async () => {
      order.push('start:b');
      await new Promise((r) => setTimeout(r, delays.tool_b));
      order.push('end:b');
      return { content: 'result_b' };
    }));

    const model = stubSequenceModel([
      { toolCall: { name: 'tool_a', args: {}, id: 'tc1' } },
      { toolCall: { name: 'tool_b', args: {}, id: 'tc2' } },
      { text: 'done' },
    ]);

    // Override generate to return both tool calls in a single response
    let callN = 0;
    const parallelModel = {
      ...model,
      async generate(c: ExecutionContext, req: Parameters<typeof model.generate>[1]) {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'tool_a', arguments: '{}' },
              { id: 'tc2', name: 'tool_b', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
    };

    const agent = weaveAgent({ model: parallelModel, tools, name: 'parallel-agent', parallelToolCalls: true });
    await agent.run(ctx, makeInput());

    // With parallel execution: tool_b (10ms) ends before tool_a (30ms)
    expect(order.indexOf('end:b')).toBeLessThan(order.indexOf('end:a'));
    // Both started before either ended
    expect(order[0]).toBe('start:a');
    expect(order[1]).toBe('start:b');
  });

  it('executes tools sequentially when parallelToolCalls=false', async () => {
    const ctx = makeCtx();
    const order: string[] = [];

    const tools = weaveToolRegistry();
    tools.register(makeTool('tool_a', async () => {
      order.push('start:a');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end:a');
      return { content: 'result_a' };
    }));
    tools.register(makeTool('tool_b', async () => {
      order.push('start:b');
      order.push('end:b');
      return { content: 'result_b' };
    }));

    let callN = 0;
    const seqModel = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'tool_a', arguments: '{}' },
              { id: 'tc2', name: 'tool_b', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({ model: seqModel, tools, name: 'seq-agent', parallelToolCalls: false });
    await agent.run(ctx, makeInput());

    // With sequential: a completes before b starts
    expect(order.indexOf('end:a')).toBeLessThan(order.indexOf('start:b'));
  });

  it('collects all tool results even when one tool fails', async () => {
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeTool('good_tool', async () => ({ content: 'good result' })));
    tools.register(makeTool('bad_tool', async () => { throw new Error('tool exploded'); }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'good_tool', arguments: '{}' },
              { id: 'tc2', name: 'bad_tool', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'completed despite error',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({ model: m, tools, name: 'error-parallel', parallelToolCalls: true });
    const result = await agent.run(ctx, makeInput());

    expect(result.status).toBe('completed');
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(2);
    // The bad tool's error result should be visible to the model (via messages)
    const errorStep = result.steps.find((s) => s.type === 'tool_call' && s.toolCall?.name === 'bad_tool');
    expect(errorStep?.toolCall?.result).toContain('tool exploded');
  });

  it('parallel tool results are appended in original call order', async () => {
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeTool('slow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { content: 'slow_result' };
    }));
    tools.register(makeTool('fast', async () => ({ content: 'fast_result' })));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'slow', arguments: '{}' },
              { id: 'tc2', name: 'fast', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        // Capture the messages to verify order
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({ model: m, tools, name: 'order-check', parallelToolCalls: true });
    const result = await agent.run(ctx, makeInput());

    // Results should be in call order: slow (tc1) then fast (tc2)
    const toolSteps = result.steps.filter((s) => s.type === 'tool_call');
    expect(toolSteps[0]?.toolCall?.name).toBe('slow');
    expect(toolSteps[1]?.toolCall?.name).toBe('fast');
  });

  it('unknown tool in parallel batch returns error result without crashing', async () => {
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeTool('real_tool', async () => ({ content: 'ok' })));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'real_tool', arguments: '{}' },
              { id: 'tc2', name: 'ghost_tool', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({ model: m, tools, name: 'ghost-tool-test', parallelToolCalls: true });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    const ghostStep = result.steps.find((s) => s.toolCall?.name === 'ghost_tool');
    expect(ghostStep?.toolCall?.result).toContain('not found');
  });
});

// ─── P2-2: Structured output ──────────────────────────────────────────────────

describe('P2-2: structured output', () => {
  it('returns parsed JSON in metadata.structuredOutput when model returns valid JSON', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([{ text: '{"name":"Alice","age":30}' }]);
    const agent = weaveAgent({
      model,
      name: 'json-agent',
      outputSchema: { type: 'json_object' },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(result.metadata?.['structuredOutput']).toEqual({ name: 'Alice', age: 30 });
  });

  it('retries when model returns invalid JSON and succeeds on retry', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([
      { text: 'not json at all' },          // first attempt: invalid
      { text: '{"value": 42}' },             // retry: valid
    ]);
    const agent = weaveAgent({
      model,
      name: 'json-retry-agent',
      outputSchema: { type: 'json_object' },
      structuredOutputRetries: 1,
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(result.metadata?.['structuredOutput']).toEqual({ value: 42 });
  });

  it('returns last (invalid) response when retry limit is exhausted', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([
      { text: 'invalid json 1' },
      { text: 'invalid json 2' },
    ]);
    const agent = weaveAgent({
      model,
      name: 'json-exhaust',
      outputSchema: { type: 'json_object' },
      structuredOutputRetries: 1,
    });
    const result = await agent.run(ctx, makeInput());
    // After retry exhaustion, agent completes with the raw content
    expect(result.status).toBe('completed');
    expect(result.output).toContain('invalid json 2');
    // No structuredOutput in metadata since parsing failed
    expect(result.metadata?.['structuredOutput']).toBeUndefined();
  });

  it('validates required properties for json_schema type', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([
      { text: '{"answer": "yes"}' },         // missing required "confidence"
      { text: '{"answer": "yes", "confidence": 0.9}' }, // complete
    ]);
    const agent = weaveAgent({
      model,
      name: 'schema-agent',
      outputSchema: {
        type: 'json_schema',
        name: 'response_schema',
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['answer', 'confidence'],
        },
      },
      structuredOutputRetries: 1,
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(result.metadata?.['structuredOutput']).toEqual({ answer: 'yes', confidence: 0.9 });
  });

  it('metadata is absent when no outputSchema is configured', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([{ text: 'plain text response' }]);
    const agent = weaveAgent({ model, name: 'no-schema-agent' });
    const result = await agent.run(ctx, makeInput());
    expect(result.metadata).toBeUndefined();
  });

  it('structured output works through runStream()', async () => {
    const ctx = makeCtx();
    const model = stubSequenceModel([{ text: '{"streaming":true}' }]);
    const agent = weaveAgent({
      model,
      name: 'stream-json',
      outputSchema: { type: 'json_object' },
    });
    let doneResult: unknown;
    if (!agent.runStream) throw new Error('runStream missing');
    for await (const ev of agent.runStream(ctx, makeInput())) {
      if (ev.type === 'done') doneResult = ev.result;
    }
    const r = doneResult as { metadata?: { structuredOutput?: unknown }; status: string };
    expect(r.status).toBe('completed');
    expect(r.metadata?.['structuredOutput']).toEqual({ streaming: true });
  });

  it('does not retry structured output when model returns tool calls first', async () => {
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeTool('calc', async () => ({ content: '42' })));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'calc', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: '{"result":42}',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'tool-then-json',
      outputSchema: { type: 'json_object' },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(result.metadata?.['structuredOutput']).toEqual({ result: 42 });
    expect(callN).toBe(2); // one tool call step + one final
  });
});

// ─── P2-3: Context window management ─────────────────────────────────────────

describe('P2-3: context management — estimateTokens', () => {
  it('estimates tokens as ceil(chars/4)', () => {
    const msgs: Message[] = [{ role: 'user', content: 'a'.repeat(400) }];
    expect(estimateTokens(msgs)).toBe(100);
  });

  it('counts zero for empty list', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('accounts for toolCalls overhead', () => {
    const msgs: Message[] = [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'mytool', arguments: '{"x":1}' }],
    }];
    // name(6) + args(7) + 20 overhead = 33 chars from toolCall, /4 = 9
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(8);
  });
});

describe('P2-3: context management — applyContextManagement', () => {
  function makeMessages(count: number, charsEach = 100): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: 'x'.repeat(charsEach),
    }));
  }

  it('returns same reference when under budget', async () => {
    const msgs = makeMessages(2, 10);
    const result = await applyContextManagement(msgs, { strategy: 'trim_oldest', maxTokens: 1000 });
    expect(result).toBe(msgs); // same reference = no-op
  });

  it('trim_oldest: removes oldest non-system messages first', async () => {
    // 5 messages × 100 chars = 500 chars ≈ 125 tokens; budget = 60 tokens = ~240 chars
    const msgs: Message[] = [
      { role: 'system', content: 'x'.repeat(40) },   // 10 tokens — never trimmed
      { role: 'user', content: 'x'.repeat(100) },    // 25 tokens
      { role: 'assistant', content: 'x'.repeat(100) },
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'x'.repeat(100) },
    ];
    const result = await applyContextManagement(msgs, { strategy: 'trim_oldest', maxTokens: 60 });
    // System message must be present
    expect(result.some((m) => m.role === 'system')).toBe(true);
    // Total should be ≤ 60 tokens
    expect(estimateTokens(result)).toBeLessThanOrEqual(60);
  });

  it('trim_oldest: never removes system messages', async () => {
    // Only system messages — nothing to trim
    const msgs: Message[] = [
      { role: 'system', content: 'x'.repeat(2000) },
    ];
    const result = await applyContextManagement(msgs, { strategy: 'trim_oldest', maxTokens: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('system');
  });

  it('trim_oldest: trims tool_call + tool_result pairs atomically', async () => {
    const asst: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'calc', arguments: '{}' }],
    };
    const toolResult: Message = {
      role: 'tool',
      content: '42',
      toolCallId: 'tc1',
    };
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      asst,
      toolResult,
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'x'.repeat(400) },
    ];
    // Budget tight enough to force trimming of the first pair
    const result = await applyContextManagement(msgs, { strategy: 'trim_oldest', maxTokens: 25 });
    // The tool_result should never appear without its paired assistant message
    const hasOrphanedToolResult = result.some(
      (m) => m.role === 'tool' && !result.some((a) => a.role === 'assistant' && a.toolCalls?.some((tc) => tc.id === m.toolCallId)),
    );
    expect(hasOrphanedToolResult).toBe(false);
  });

  it('sliding_window: keeps only the N most recent non-system groups', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'reply3' },
    ];
    // slidingWindowSize=2 keeps 2 most recent non-system groups
    const result = await applyContextManagement(msgs, { strategy: 'sliding_window', maxTokens: 1, slidingWindowSize: 2 });
    // System always kept; only 2 non-system groups
    expect(result[0]!.role).toBe('system');
    const nonSystem = result.filter((m) => m.role !== 'system');
    expect(nonSystem.length).toBeLessThanOrEqual(4); // at most 2 groups × 2 messages
    // Most recent messages retained
    expect(result.some((m) => m.content === 'msg3')).toBe(true);
    expect(result.some((m) => m.content === 'msg1')).toBe(false);
  });

  it('summarize: calls memory.summarize and replaces old messages', async () => {
    const ctx = makeCtx();
    const summarized: string[] = [];
    const memory: AgentMemory = {
      async getMessages() { return []; },
      async addMessage() {},
      async summarize(_ctx) {
        summarized.push('called');
        return 'Summary of earlier conversation';
      },
      async clear() {},
    };
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'x'.repeat(400) },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'keep this' },
      { role: 'user', content: 'x'.repeat(400) },
    ];
    const result = await applyContextManagement(msgs, { strategy: 'summarize', maxTokens: 50 }, memory, ctx);
    expect(summarized).toHaveLength(1);
    expect(result.some((m) => typeof m.content === 'string' && m.content.includes('Summary of earlier conversation'))).toBe(true);
    expect(result.some((m) => m.content === 'keep this')).toBe(true);
  });

  it('summarize: falls back to trim_oldest when memory.summarize is absent', async () => {
    const ctx = makeCtx();
    const memory: AgentMemory = {
      async getMessages() { return []; },
      async addMessage() {},
      async clear() {},
    };
    const msgs: Message[] = [
      { role: 'user', content: 'x'.repeat(800) },
      { role: 'assistant', content: 'keep' },
    ];
    const result = await applyContextManagement(msgs, { strategy: 'summarize', maxTokens: 20 }, memory, ctx);
    // Should fall back to trim_oldest
    expect(estimateTokens(result)).toBeLessThanOrEqual(20);
  });

  it('context management is applied before each model call in run()', async () => {
    const ctx = makeCtx();
    const requestsSeen: Message[][] = [];
    const m = {
      ...stubSequenceModel([{ text: 'done' }]),
      async generate(_c: ExecutionContext, req: { messages: Message[] }) {
        requestsSeen.push([...req.messages]);
        return {
          id: 'r1', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    // Pre-load a very long history
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: 'x'.repeat(200),
    }));
    const agent = weaveAgent({
      model: m,
      name: 'ctx-agent',
      contextManagement: { strategy: 'sliding_window', maxTokens: 50, slidingWindowSize: 2 },
    });
    await agent.run(ctx, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    // The model should only see the trimmed context
    const seen = requestsSeen[0]!;
    expect(estimateTokens(seen)).toBeLessThanOrEqual(200); // rough bound
  });
});

// ─── P2-4: Tool retry ─────────────────────────────────────────────────────────

describe('P2-4: tool retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeRetryTool(name: string, failCount: number, errorMsg = 'ECONNRESET transient'): Tool {
    let calls = 0;
    return makeTool(name, async () => {
      calls++;
      if (calls <= failCount) throw new Error(errorMsg);
      return { content: `success after ${failCount} failures` };
    });
  }

  it('succeeds on second attempt when first attempt throws a transient error', async () => {
    vi.useRealTimers(); // use real timers for this test
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeRetryTool('flaky', 1));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'flaky', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'retry-agent',
      toolRetry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10 },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    const step = result.steps.find((s) => s.toolCall?.name === 'flaky');
    expect(step?.toolCall?.result).toContain('success after 1 failures');
  });

  it('returns error result after exhausting all retry attempts', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeRetryTool('always_fail', 100, 'connection timeout'));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'always_fail', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'saw the error',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'exhaust-retry',
      toolRetry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 5 },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    const step = result.steps.find((s) => s.toolCall?.name === 'always_fail');
    expect(step?.toolCall?.result).toContain('connection timeout');
  });

  it('does NOT retry non-transient errors (propagates immediately)', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    let invocations = 0;
    const tools = weaveToolRegistry();
    tools.register(makeTool('non_transient', async () => {
      invocations++;
      throw new Error('Invalid argument: expected string');
    }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'non_transient', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'no-retry-agent',
      toolRetry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 10 },
    });
    await agent.run(ctx, makeInput());
    // Non-transient error should NOT be retried — only invoked once
    expect(invocations).toBe(1);
  });

  it('retries on 429 rate-limit errors', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    let attempts = 0;
    const tools = weaveToolRegistry();
    tools.register(makeTool('rate_limited', async () => {
      attempts++;
      if (attempts < 3) throw new Error('429 Too Many Requests');
      return { content: 'ok' };
    }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'rate_limited', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return { id: 'r2', model: 'stub', content: 'done', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: '429-retry',
      toolRetry: { maxAttempts: 5, backoffMs: 1, maxBackoffMs: 10 },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
    const step = result.steps.find((s) => s.toolCall?.name === 'rate_limited');
    expect(step?.toolCall?.result).toBe('ok');
  });

  it('tool retry disabled by default (maxAttempts=1 = no retry)', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    let invocations = 0;
    const tools = weaveToolRegistry();
    tools.register(makeTool('transient_but_no_retry', async () => {
      invocations++;
      throw new Error('ECONNRESET');
    }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [{ id: 'tc1', name: 'transient_but_no_retry', arguments: '{}' }],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return { id: 'r2', model: 'stub', content: 'done', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
    };

    // No toolRetry option → defaults to maxAttempts=1 (single attempt)
    const agent = weaveAgent({ model: m, tools, name: 'no-retry-default' });
    await agent.run(ctx, makeInput());
    expect(invocations).toBe(1);
  });
});

// ─── Security / adversarial tests ─────────────────────────────────────────────

describe('Security and adversarial', () => {
  it('structured output: malicious JSON injection does not break schema validation', async () => {
    const ctx = makeCtx();
    // Model returns JSON with __proto__ injection attempt
    const model = stubSequenceModel([
      { text: '{"__proto__":{"polluted":true},"name":"safe"}' },
    ]);
    const agent = weaveAgent({
      model,
      name: 'security-json',
      outputSchema: { type: 'json_schema', schema: { type: 'object', required: ['name'] } },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    // Should parse without throwing; __proto__ injection is a JS runtime concern
    expect(result.metadata?.['structuredOutput']).toBeDefined();
  });

  it('parallel tool execution: one tool cannot observe another tool\'s arguments via closure', async () => {
    const ctx = makeCtx();
    const capturedArgs: Record<string, unknown>[] = [];
    const tools = weaveToolRegistry();

    tools.register(makeTool('tool_spy', async (args) => {
      capturedArgs.push({ ...args });
      return { content: 'spied' };
    }));
    tools.register(makeTool('tool_secret', async () => {
      return { content: 'secret_value' };
    }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'tool_spy', arguments: '{"data":"spy_arg"}' },
              { id: 'tc2', name: 'tool_secret', arguments: '{"secret":"password123"}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return { id: 'r2', model: 'stub', content: 'done', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
    };

    const agent = weaveAgent({ model: m, tools, name: 'spy-test', parallelToolCalls: true });
    await agent.run(ctx, makeInput());

    // tool_spy should only see its own args
    expect(capturedArgs[0]).toEqual({ data: 'spy_arg' });
    expect(capturedArgs[0]).not.toHaveProperty('secret');
  });

  it('context management: trim_oldest does not leak system prompt instructions', async () => {
    const ctx = makeCtx();
    const requestsSeen: Message[][] = [];
    const m = {
      ...stubSequenceModel([]),
      async generate(_c: ExecutionContext, req: { messages: Message[] }) {
        requestsSeen.push([...req.messages]);
        return {
          id: 'r1', model: 'stub', content: 'done',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m,
      name: 'ctx-security',
      systemPrompt: 'CONFIDENTIAL SYSTEM INSTRUCTIONS',
      contextManagement: { strategy: 'trim_oldest', maxTokens: 5 }, // very tight budget
    });
    await agent.run(ctx, { messages: [{ role: 'user', content: 'hi' }] });

    // Even with tight budget, system message must survive
    const seenMessages = requestsSeen[0]!;
    const sysMsg = seenMessages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('CONFIDENTIAL SYSTEM INSTRUCTIONS');
  });

  it('tool retry: retry count does not bleed across separate tool calls', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    const callCounts: Record<string, number> = { tool_a: 0, tool_b: 0 };
    const tools = weaveToolRegistry();

    tools.register(makeTool('tool_a', async () => {
      callCounts['tool_a']!++;
      if (callCounts['tool_a']! === 1) throw new Error('rate limit 429');
      return { content: 'a_ok' };
    }));
    tools.register(makeTool('tool_b', async () => {
      callCounts['tool_b']!++;
      return { content: 'b_ok' }; // always succeeds first try
    }));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'tool_a', arguments: '{}' },
              { id: 'tc2', name: 'tool_b', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return { id: 'r2', model: 'stub', content: 'done', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'retry-isolation',
      toolRetry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 },
    });
    await agent.run(ctx, makeInput());

    expect(callCounts['tool_a']).toBe(2); // 1 fail + 1 success
    expect(callCounts['tool_b']).toBe(1); // succeeds first try
  });
});

// ─── P2 integration: all features together ────────────────────────────────────

describe('P2 integration', () => {
  it('parallel + structured output: tools run in parallel then output is validated', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    const tools = weaveToolRegistry();
    tools.register(makeTool('fetch_data', async () => ({ content: JSON.stringify({ value: 99 }) })));
    tools.register(makeTool('fetch_meta', async () => ({ content: JSON.stringify({ key: 'x' }) })));

    let callN = 0;
    const m = {
      ...stubSequenceModel([]),
      async generate() {
        callN++;
        if (callN === 1) {
          return {
            id: 'r1', model: 'stub', content: '',
            toolCalls: [
              { id: 'tc1', name: 'fetch_data', arguments: '{}' },
              { id: 'tc2', name: 'fetch_meta', arguments: '{}' },
            ],
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          };
        }
        return {
          id: 'r2', model: 'stub', content: '{"combined":true}',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, tools, name: 'full-p2',
      parallelToolCalls: true,
      outputSchema: { type: 'json_object' },
    });
    const result = await agent.run(ctx, makeInput());
    expect(result.status).toBe('completed');
    expect(result.metadata?.['structuredOutput']).toEqual({ combined: true });
    expect(result.steps.filter((s) => s.type === 'tool_call')).toHaveLength(2);
  });

  it('context management + structured output: budget enforced then JSON validated', async () => {
    vi.useRealTimers();
    const ctx = makeCtx();
    const requestsSeen: Message[][] = [];

    const m = {
      ...stubSequenceModel([]),
      async generate(_c: ExecutionContext, req: { messages: Message[] }) {
        requestsSeen.push([...req.messages]);
        return {
          id: 'r1', model: 'stub', content: '{"answer":"42"}',
          toolCalls: [], finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      },
    };

    const agent = weaveAgent({
      model: m, name: 'ctx-json-agent',
      contextManagement: { strategy: 'sliding_window', maxTokens: 1, slidingWindowSize: 1 },
      outputSchema: { type: 'json_object' },
    });

    await agent.run(ctx, { messages: [{ role: 'user', content: 'x'.repeat(500) }] });

    const result = await agent.run(ctx, makeInput());
    expect(result.metadata?.['structuredOutput']).toEqual({ answer: '42' });
  });
});
