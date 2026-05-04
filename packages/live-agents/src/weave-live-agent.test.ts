/**
 * Phase 4 — `weaveLiveAgent` constructor tests.
 *
 * Validates parity with `weaveAgent`-style usage:
 *  - Returns `{ handler, definition }`.
 *  - Synthesizes a default `prepare()` from `systemPrompt` + `tools`.
 *  - Throws when neither `model` nor `modelResolver` is supplied.
 *  - Throws when neither `prepare` nor `systemPrompt` is supplied.
 *  - `definition.capabilities` correctly reflects which slots were set.
 *  - The returned handler runs end-to-end and returns `{ completed: true }`.
 *  - Captures `memory` and `bus` aliases on the definition.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  weaveToolRegistry,
  type ExecutionContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type Tool,
  type ToolInput,
  type ToolOutput,
} from '@weaveintel/core';
import { weaveLiveAgent, type LiveAgentBus } from './weave-live-agent.js';
import { weaveLiveAgentPolicy } from './policy.js';
import { weaveModelResolver } from './model-resolver.js';
import type { ActionExecutionContext, ContextPolicy } from './types.js';

function fakeModel(id: string): Model {
  return {
    info: { provider: 'fake', modelId: id, capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(
      _ctx: ExecutionContext,
      _req: ModelRequest,
    ): Promise<ModelResponse> {
      return {
        id: 'res-1',
        model: id,
        content: 'final answer',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

function stubTool(name: string): Tool {
  return {
    name,
    description: `stub ${name}`,
    schema: { type: 'object', properties: {} },
    riskLevel: 'read-only',
    async invoke(_i: ToolInput): Promise<ToolOutput> {
      return { content: 'ok' };
    },
  } as unknown as Tool;
}

function stubActionCtx(): ActionExecutionContext {
  return {
    agent: { id: 'agent-1', meshId: 'mesh-1' },
    stateStore: {
      async listMessagesForRecipient() {
        return [];
      },
    },
  } as unknown as ActionExecutionContext;
}

const stubExecCtx = (): ExecutionContext =>
  ({ userId: 'test', logger: console } as unknown as ExecutionContext);

const stubAction = () =>
  ({ type: 'StartTask', agentId: 'agent-1' } as never);

describe('weaveLiveAgent — construction', () => {
  it('throws when neither model nor modelResolver is supplied', () => {
    expect(() =>
      weaveLiveAgent({ name: 'no-model', systemPrompt: 'hi' }),
    ).toThrowError(/model.*modelResolver/);
  });

  it('throws when neither prepare nor systemPrompt is supplied', () => {
    expect(() =>
      weaveLiveAgent({ name: 'no-prompt', model: fakeModel('m1') }),
    ).toThrowError(/prepare.*systemPrompt/);
  });

  it('returns { handler, definition } with capability flags', () => {
    const { handler, definition } = weaveLiveAgent({
      name: 'r1',
      role: 'researcher',
      model: fakeModel('m1'),
      tools: weaveToolRegistry(),
      systemPrompt: 'You are a tester.',
      policy: weaveLiveAgentPolicy({ auditEmitter: { emit: vi.fn() } }),
    });
    expect(typeof handler).toBe('function');
    expect(definition.name).toBe('r1');
    expect(definition.role).toBe('researcher');
    expect(definition.capabilities.model).toBe(true);
    expect(definition.capabilities.modelResolver).toBe(false);
    expect(definition.capabilities.tools).toBe(true);
    expect(definition.capabilities.policy).toBe(true);
    expect(definition.capabilities.memory).toBe(false);
    expect(definition.capabilities.bus).toBe(false);
    expect(definition.capabilities.customPrepare).toBe(false);
  });

  it('records memory + bus aliases on the definition', () => {
    const memory: ContextPolicy = {
      windowTurns: 10,
    } as unknown as ContextPolicy;
    const bus: LiveAgentBus = { emit: vi.fn() };
    const { definition } = weaveLiveAgent({
      name: 'with-aliases',
      model: fakeModel('m1'),
      systemPrompt: 'hi',
      memory,
      bus,
    });
    expect(definition.capabilities.memory).toBe(true);
    expect(definition.capabilities.bus).toBe(true);
    expect(definition.options.memory).toBe(memory);
    expect(definition.options.bus).toBe(bus);
  });

  it('flags modelResolver capability when supplied', () => {
    const { definition } = weaveLiveAgent({
      name: 'routed',
      modelResolver: weaveModelResolver({ model: fakeModel('m1') }),
      systemPrompt: 'hi',
    });
    expect(definition.capabilities.model).toBe(true); // resolver counts
    expect(definition.capabilities.modelResolver).toBe(true);
  });

  it('flags customPrepare when an explicit prepare is supplied', () => {
    const { definition } = weaveLiveAgent({
      name: 'custom',
      model: fakeModel('m1'),
      prepare: () => ({ systemPrompt: 'sp', userGoal: 'go' }),
    });
    expect(definition.capabilities.customPrepare).toBe(true);
  });
});

describe('weaveLiveAgent — handler runtime', () => {
  it('runs end-to-end with a synthesized prepare and returns { completed: true }', async () => {
    const tools = weaveToolRegistry();
    tools.register(stubTool('noop'));
    const { handler } = weaveLiveAgent({
      name: 'runner',
      model: fakeModel('m1'),
      tools,
      systemPrompt: 'You are a tester.',
      log: () => {},
    });
    const result = (await handler(stubAction(), stubActionCtx(), stubExecCtx())) as {
      completed: boolean;
    };
    expect(result.completed).toBe(true);
  });

  it('forwards policy enforcement when present', async () => {
    const auditEmitter = { emit: vi.fn() };
    const { handler } = weaveLiveAgent({
      name: 'audited',
      model: fakeModel('m1'),
      policy: weaveLiveAgentPolicy({ auditEmitter }),
      async prepare() {
        const tools = weaveToolRegistry();
        tools.register(stubTool('noop'));
        return {
          systemPrompt: 'go',
          tools,
          userGoal: 'go',
        };
      },
      log: () => {},
    });
    const result = (await handler(stubAction(), stubActionCtx(), stubExecCtx())) as {
      completed: boolean;
    };
    expect(result.completed).toBe(true);
    // The fake model never actually calls a tool so audit count may be 0;
    // the assertion that matters is that policy wiring did not crash.
  });
});
