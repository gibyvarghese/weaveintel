/**
 * Unit tests for weaveAgentAsA2AServer (Phase 3 — task store, state machine, multi-turn)
 */

import { describe, it, expect, vi } from 'vitest';
import { weaveAgentAsA2AServer } from './agent-server.js';
import { createInMemoryA2ATaskStore } from './task-store.js';
import type { Agent, AgentInput, AgentResult, A2ATask, ExecutionContext } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockCtx: ExecutionContext = {
  executionId: 'test-exec',
  metadata: {},
};

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    output: 'agent output',
    messages: [],
    steps: [],
    usage: { totalSteps: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, totalDurationMs: 100, toolCalls: 0, delegations: 0 },
    status: 'completed',
    ...overrides,
  };
}

function makeAgent(resultOrFn: AgentResult | ((input: AgentInput) => AgentResult) = makeAgentResult()): Agent {
  const fn = typeof resultOrFn === 'function' ? resultOrFn : () => resultOrFn;
  return {
    config: { name: 'test-agent', maxSteps: 10 } as Agent['config'],
    run: vi.fn().mockImplementation(async (_ctx: ExecutionContext, input: AgentInput) => fn(input)),
  };
}

function makeCard() {
  return {
    name: 'test-agent',
    description: 'Test',
    version: '1.0.0',
    skills: [{ id: 'test', name: 'Test', description: 'Test skill' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: true },
    supportedInterfaces: [{ url: 'http://localhost/a2a', protocolBinding: 'JSONRPC' as const, protocolVersion: '1.0' }],
  };
}

function makeParams(text = 'hello', overrides: Record<string, unknown> = {}) {
  return {
    message: {
      role: 'user' as const,
      parts: [{ text }],
      contextId: newUUIDv7(),
      messageId: newUUIDv7(),
      ...overrides,
    },
  };
}

// ─── Basic handleMessage ──────────────────────────────────────────────────────

describe('weaveAgentAsA2AServer — handleMessage', () => {
  it('returns COMPLETED task for successful agent run', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams('hello'));
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.id).toBeTruthy();
    expect(task.contextId).toBeTruthy();
    expect(task.artifacts.length).toBeGreaterThan(0);
    expect(task.history.length).toBeGreaterThan(0);
  });

  it('returns FAILED task when agent throws', async () => {
    const agent = makeAgent();
    vi.mocked(agent.run).mockRejectedValue(new Error('boom'));
    const server = weaveAgentAsA2AServer({ agent, card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_FAILED');
  });

  it('returns FAILED task when agent status is "failed"', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(makeAgentResult({ status: 'failed', output: 'error msg' })), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_FAILED');
  });

  it('maps budget_exceeded to TASK_STATE_FAILED', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(makeAgentResult({ status: 'budget_exceeded' })), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_FAILED');
  });

  it('maps cancelled to TASK_STATE_CANCELED', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(makeAgentResult({ status: 'cancelled' })), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('maps needs_approval to TASK_STATE_INPUT_REQUIRED', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(makeAgentResult({ status: 'needs_approval', output: 'Do you approve?' })), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task.status.message?.parts[0]?.text).toContain('Do you approve?');
  });

  it('maps guardrail_denied to TASK_STATE_REJECTED', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(makeAgentResult({ status: 'guardrail_denied', output: 'Blocked by policy' })), card: makeCard() });
    const task = await server.handleMessage(mockCtx, makeParams());
    expect(task.status.state).toBe('TASK_STATE_REJECTED');
  });
});

// ─── Task store integration ───────────────────────────────────────────────────

describe('weaveAgentAsA2AServer — task store', () => {
  it('persists task through SUBMITTED → WORKING → COMPLETED', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(mockCtx, makeParams());

    const stored = await store.load(task.id);
    expect(stored).not.toBeNull();
    expect(stored!.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('persists FAILED task in store', async () => {
    const store = createInMemoryA2ATaskStore();
    const agent = makeAgent();
    vi.mocked(agent.run).mockRejectedValue(new Error('agent error'));
    const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
    const task = await server.handleMessage(mockCtx, makeParams());

    const stored = await store.load(task.id);
    expect(stored?.status.state).toBe('TASK_STATE_FAILED');
  });

  it('getTask returns null without store', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard() });
    expect(await server.getTask!(mockCtx, 'any-id')).toBeNull();
  });

  it('getTask returns stored task', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(mockCtx, makeParams());
    const fetched = await server.getTask!(mockCtx, task.id);
    expect(fetched?.id).toBe(task.id);
    expect(fetched?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('getTask returns null for unknown id', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    expect(await server.getTask!(mockCtx, 'no-such-task')).toBeNull();
  });

  it('listTasks returns all stored tasks', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    await server.handleMessage(mockCtx, makeParams('task 1'));
    await server.handleMessage(mockCtx, makeParams('task 2'));
    const page = await server.listTasks!(mockCtx);
    expect(page.tasks.length).toBe(2);
  });

  it('cancelTask marks task as CANCELED', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(mockCtx, makeParams());
    await server.cancelTask!(mockCtx, task.id);
    const canceled = await store.load(task.id);
    expect(canceled?.status.state).toBe('TASK_STATE_CANCELED');
  });
});

// ─── Guardrails (Phase 3) ─────────────────────────────────────────────────────

describe('weaveAgentAsA2AServer — guardrail pre-check', () => {
  it('returns REJECTED when guardrail blocks input', async () => {
    const store = createInMemoryA2ATaskStore();
    const ctxWithGuardrail: ExecutionContext = {
      ...mockCtx,
      runtime: {
        guardrails: {
          checkInput: vi.fn().mockResolvedValue({ allow: false, reason: 'Blocked by policy' }),
        },
      } as unknown as ExecutionContext['runtime'],
    };
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(ctxWithGuardrail, makeParams('bad content'));
    expect(task.status.state).toBe('TASK_STATE_REJECTED');
    expect(task.status.message?.parts[0]?.text).toContain('Blocked by policy');
  });

  it('proceeds normally when guardrail allows', async () => {
    const store = createInMemoryA2ATaskStore();
    const ctxWithGuardrail: ExecutionContext = {
      ...mockCtx,
      runtime: {
        guardrails: {
          checkInput: vi.fn().mockResolvedValue({ allow: true }),
        },
      } as unknown as ExecutionContext['runtime'],
    };
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(ctxWithGuardrail, makeParams('good content'));
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('proceeds normally when guardrail throws (best-effort)', async () => {
    const store = createInMemoryA2ATaskStore();
    const ctxWithGuardrail: ExecutionContext = {
      ...mockCtx,
      runtime: {
        guardrails: {
          checkInput: vi.fn().mockRejectedValue(new Error('guardrail crash')),
        },
      } as unknown as ExecutionContext['runtime'],
    };
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });
    const task = await server.handleMessage(ctxWithGuardrail, makeParams());
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

// ─── Multi-turn (Phase 3) ─────────────────────────────────────────────────────

describe('weaveAgentAsA2AServer — multi-turn resumption', () => {
  it('resumes INPUT_REQUIRED task with continuation message', async () => {
    const store = createInMemoryA2ATaskStore();
    let callCount = 0;
    const agent = makeAgent((input) => {
      callCount++;
      if (callCount === 1) {
        return makeAgentResult({ status: 'needs_approval', output: 'Do you want to proceed?' });
      }
      return makeAgentResult({ output: `User replied: ${input.messages[input.messages.length - 1]?.content}` });
    });

    const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });

    // First turn — gets INPUT_REQUIRED
    const task1 = await server.handleMessage(mockCtx, makeParams('start workflow'));
    expect(task1.status.state).toBe('TASK_STATE_INPUT_REQUIRED');

    // Second turn — resume with the taskId
    const task2 = await server.handleMessage(mockCtx, {
      message: {
        role: 'user',
        parts: [{ text: 'yes, proceed' }],
        taskId: task1.id,
        contextId: task1.contextId,
        messageId: newUUIDv7(),
      },
    });
    expect(task2.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task2.id).toBe(task1.id); // same task
    expect(task2.history.length).toBeGreaterThan(task1.history.length);
  });

  it('returns FAILED when resuming a task not in INPUT_REQUIRED/AUTH_REQUIRED', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });

    const task1 = await server.handleMessage(mockCtx, makeParams('hello'));
    expect(task1.status.state).toBe('TASK_STATE_COMPLETED');

    // Try to resume a completed task
    const task2 = await server.handleMessage(mockCtx, {
      message: {
        role: 'user',
        parts: [{ text: 'try to continue' }],
        taskId: task1.id,
        contextId: task1.contextId,
        messageId: newUUIDv7(),
      },
    });
    expect(task2.status.state).toBe('TASK_STATE_FAILED');
  });

  it('returns FAILED when resuming a non-existent task', async () => {
    const store = createInMemoryA2ATaskStore();
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard(), store });

    const result = await server.handleMessage(mockCtx, {
      message: {
        role: 'user',
        parts: [{ text: 'continue' }],
        taskId: 'ghost-task-id',
        messageId: newUUIDv7(),
      },
    });
    expect(result.status.state).toBe('TASK_STATE_FAILED');
  });

  it('passes full conversation history to agent on resume', async () => {
    const store = createInMemoryA2ATaskStore();
    let capturedInput: AgentInput | null = null;
    const agent = makeAgent((input) => {
      capturedInput = input;
      if (input.messages.length === 1) {
        return makeAgentResult({ status: 'needs_approval', output: 'Need approval' });
      }
      return makeAgentResult({ output: 'Done' });
    });

    const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
    const task1 = await server.handleMessage(mockCtx, makeParams('first message'));

    await server.handleMessage(mockCtx, {
      message: {
        role: 'user',
        parts: [{ text: 'second message' }],
        taskId: task1.id,
        contextId: task1.contextId,
        messageId: newUUIDv7(),
      },
    });

    // On resume, agent receives full history (both user messages + any agent replies)
    expect(capturedInput!.messages.length).toBeGreaterThanOrEqual(2);
    expect(capturedInput!.messages[0]!.role).toBe('user');
  });
});

// ─── Deprecated shims ─────────────────────────────────────────────────────────

describe('weaveAgentAsA2AServer — deprecated shims', () => {
  it('handleTask shim works', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard() });
    const result = await server.handleTask!(mockCtx, {
      id: 'legacy-id',
      input: { role: 'user', parts: [{ text: 'legacy call' }] },
    });
    expect(result.status).toBe('completed');
    expect(result.id).toBe('legacy-id');
  });

  it('handleStreamTask shim yields events', async () => {
    const server = weaveAgentAsA2AServer({ agent: makeAgent(), card: makeCard() });
    const events = [];
    for await (const e of server.handleStreamTask!(mockCtx, {
      id: 'legacy-stream-id',
      input: { role: 'user', parts: [{ text: 'stream' }] },
    })) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(['completed', 'failed', 'working']).toContain(last.status);
  });
});
