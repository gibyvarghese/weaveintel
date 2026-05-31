/**
 * Phase 3 — integration test: runtime → context → agent → model/tool → spans + audit.
 */

import { describe, it, expect } from 'vitest';
import {
  weaveRuntime,
  weaveContext,
  weaveTool as defineTool,
  weaveToolRegistry as createToolRegistry,
  Capabilities,
  type AuditEntry,
  type AuditLogger,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ExecutionContext,
  type RuntimeGuardrailsSlot,
} from '@weaveintel/core';
import { weaveInMemoryTracer } from '@weaveintel/observability';
import { weaveAgent } from './agent.js';

function makeRuntime(entries: AuditEntry[], guardrails?: RuntimeGuardrailsSlot) {
  const audit: AuditLogger = { async log(e) { entries.push(e); } };
  return weaveRuntime({
    tracer: weaveInMemoryTracer(),
    audit,
    ...(guardrails ? { guardrails } : {}),
  });
}

function stubModelSequence(): Model {
  let call = 0;
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  return {
    info: { provider: 'stub', modelId: 'integration-stub', capabilities: caps },
    capabilities: caps,
    hasCapability(id) { return caps.has(id); },
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      call += 1;
      if (call === 1) {
        return {
          id: 'r1',
          model: 'integration-stub',
          content: '',
          toolCalls: [{ id: 't1', name: 'ping', arguments: '{}' }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }
      return {
        id: 'r2',
        model: 'integration-stub',
        content: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
}

describe('Phase 3 — ambient runtime end-to-end', () => {
  it('a single run touches tracer + audit + tool registry without explicit wiring', async () => {
    const entries: AuditEntry[] = [];
    const runtime = makeRuntime(entries);
    const ctx = weaveContext({ runtime });

    const tools = createToolRegistry();
    tools.register(defineTool({
      name: 'ping',
      description: 'returns pong',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'pong'; },
    }));

    const agent = weaveAgent({ name: 'it-agent', model: stubModelSequence(), tools, maxSteps: 4 });
    const result = await agent.run(ctx, { goal: 'pong', messages: [{ role: 'user', content: 'hi' }] });

    expect(result.steps.length).toBeGreaterThanOrEqual(2);

    const actions = entries.map((e) => `${e.action}/${e.outcome}`);
    expect(actions).toEqual(expect.arrayContaining([
      'agent.run.start/success',
      'agent.tool.invoke/success',
      'agent.run.end/success',
    ]));

    const tracer = runtime.tracer as ReturnType<typeof weaveInMemoryTracer>;
    const spanNames = tracer.spans.map((s) => s.name);
    expect(spanNames).toEqual(expect.arrayContaining(['agents.model.generate', 'agents.tool.invoke']));
  });

  it('guardrails deny on a tool call is audited and the agent continues gracefully', async () => {
    const entries: AuditEntry[] = [];
    const runtime = makeRuntime(entries, {
      async checkToolCall(_c, schema) {
        return schema.name === 'ping' ? { allow: false, reason: 'denied-by-test' } : { allow: true };
      },
    });

    const tools = createToolRegistry();
    tools.register(defineTool({
      name: 'ping',
      description: 'returns pong',
      parameters: { type: 'object', properties: {} },
      async execute() { return 'pong'; },
    }));

    const agent = weaveAgent({ name: 'it-agent-denied', model: stubModelSequence(), tools, maxSteps: 4 });
    await agent.run(weaveContext({ runtime }), { goal: 'denied', messages: [{ role: 'user', content: 'hi' }] });

    const deny = entries.find((e) => e.action === 'agent.tool.invoke' && e.outcome === 'denied');
    expect(deny).toBeDefined();
    expect(deny?.details?.['reason']).toBe('denied-by-test');
  });
});
