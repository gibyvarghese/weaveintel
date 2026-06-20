/**
 * @weaveintel/agents — Phase 6 comprehensive tests
 *
 * Tests for:
 *   P6-1: Multi-tier evaluation pipeline
 *   P6-2: A2A-native supervisor
 *   P6-3: Cost-aware agent routing
 *   P6-4: Compliance-aware tool execution
 *   P6-5: Vision-loop browser agent
 */

import { describe, it, expect, vi } from 'vitest';
import type { Model, ExecutionContext, Critic, Verifier, CritiqueResult, VerifyResult } from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';
import { runEvalPipeline } from './eval-pipeline.js';
import type { EvalPipelineOptions } from './eval-pipeline.js';
import { weaveAgent } from './agent.js';
import { weaveA2ASupervisor, createInMemoryA2ATaskStore } from './a2a-supervisor.js';
import type { A2ATaskSendParams } from '@weaveintel/core';

import type { Tool as CoreTool, ToolOutput } from '@weaveintel/core';

function makeToolRegistry(tools: Array<{ name: string; description?: string; execute: (p: Record<string, unknown>) => Promise<string> }>) {
  const reg = weaveToolRegistry();
  for (const t of tools) {
    const tool: CoreTool = {
      schema: {
        name: t.name,
        description: t.description ?? t.name,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
      invoke: async (_ctx, tc): Promise<ToolOutput> => {
        const result = await t.execute(tc.arguments as Record<string, unknown>);
        return { content: result };
      },
    };
    reg.register(tool);
  }
  return reg;
}

// ─── Shared test utilities ─────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    userId: 'user-1',
    sessionId: 'sess-1',
    ...overrides,
  } as ExecutionContext;
}

function makeModel(response: string, tokens = 10): Model {
  return {
    generate: vi.fn().mockResolvedValue({
      content: response,
      toolCalls: [],
      usage: { promptTokens: tokens, completionTokens: tokens, totalTokens: tokens * 2 },
    }),
  } as unknown as Model;
}

// ─── P6-1: runEvalPipeline ────────────────────────────────────

describe('P6-1: runEvalPipeline', () => {

  // Positive: schema stage accepts valid JSON
  it('schema stage: accepts valid JSON object', async () => {
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'object', required: ['name'] } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: '{"name":"Alice"}',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
    expect(out.report.stages[0]?.stage).toBe('schema');
  });

  // Negative: schema stage rejects invalid JSON
  it('schema stage: rejects non-JSON when type=object', async () => {
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'object' } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'just plain text',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(false);
    expect(out.rejectionFeedback).toMatch(/JSON/);
  });

  // Negative: schema stage rejects missing required property
  it('schema stage: rejects object missing required property', async () => {
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'object', required: ['age'] } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: '{"name":"Bob"}',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(false);
    expect(out.report.stages[0]).toMatchObject({ stage: 'schema', accepted: false });
    const schemaResult = out.report.stages[0] as { errors: string[] };
    expect(schemaResult.errors.some((e) => e.includes('age'))).toBe(true);
  });

  // Positive: schema stage accepts valid string
  it('schema stage: accepts string content when type=string', async () => {
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'string' } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'hello world',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
  });

  // Positive: reflect stage with accepting critic
  it('reflect stage: accepts when critic scores above threshold', async () => {
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: true, score: 0.9, feedback: undefined } satisfies CritiqueResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'reflect', critic, minScore: 0.7 }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'excellent response',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
    expect(out.report.overallScore).toBeCloseTo(0.9);
  });

  // Negative: reflect stage rejects low-quality output
  it('reflect stage: rejects when critic score is too low', async () => {
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: false, score: 0.3, feedback: 'Too vague' } satisfies CritiqueResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'reflect', critic, minScore: 0.7 }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'bad response',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(false);
    expect(out.rejectionFeedback).toContain('Too vague');
  });

  // Positive: verify stage passes
  it('verify stage: accepts when verifier passes', async () => {
    const verifier: Verifier = {
      verify: vi.fn().mockResolvedValue({ passed: true, score: 1.0 } satisfies VerifyResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'verify', verifier }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'verified output',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
  });

  // Negative: verify stage rejects
  it('verify stage: rejects and captures reason', async () => {
    const verifier: Verifier = {
      verify: vi.fn().mockResolvedValue({ passed: false, reason: 'Factual error detected', score: 0.1 } satisfies VerifyResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'verify', verifier }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'bad output',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(false);
    expect(out.rejectionFeedback).toContain('Factual error');
  });

  // Positive: ensemble stage picks best candidate
  it('ensemble stage: runs arbiter and accepts result', async () => {
    const extraModel = makeModel(JSON.stringify({ winner: 1, rationale: 'First is best', score: 0.95 }));
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'ensemble', models: [extraModel], criteria: 'accuracy' }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'original response',
      agentModel: makeModel(JSON.stringify({ winner: 1, rationale: 'First is best', score: 0.95 })),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
    const ensResult = out.report.stages[0] as { candidates: number };
    expect(ensResult.candidates).toBeGreaterThanOrEqual(1);
  });

  // Positive: failFast=false runs all stages even after rejection
  it('failFast=false: all stages run even after first rejection', async () => {
    const verifier: Verifier = {
      verify: vi.fn().mockResolvedValue({ passed: false, reason: 'Fail' } satisfies VerifyResult),
    };
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: false, feedback: 'Bad' } satisfies CritiqueResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [
        { type: 'schema', schema: { type: 'object' } },
        { type: 'verify', verifier },
        { type: 'reflect', critic },
      ],
      failFast: false,
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'not json',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.stages).toHaveLength(3);
    expect(out.report.accepted).toBe(false);
  });

  // Positive: failFast=true stops at first rejection
  it('failFast=true (default): stops at first rejection', async () => {
    const verifier: Verifier = {
      verify: vi.fn().mockResolvedValue({ passed: false } satisfies VerifyResult),
    };
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: true } satisfies CritiqueResult),
    };
    const opts: EvalPipelineOptions = {
      stages: [
        { type: 'schema', schema: { type: 'object' } },
        { type: 'verify', verifier },
        { type: 'reflect', critic },
      ],
      failFast: true,
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'not json',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    // Only schema stage should run (first rejection stops pipeline)
    expect(out.report.stages).toHaveLength(1);
  });

  // Edge case: critic throws — fail open
  it('reflect stage: critic error causes fail-open (accept)', async () => {
    const critic: Critic = {
      critique: vi.fn().mockRejectedValue(new Error('critic crashed')),
    };
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'reflect', critic }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'response',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
  });

  // Edge case: empty stages → always accepted
  it('empty stages: pipeline accepts without running anything', async () => {
    const opts: EvalPipelineOptions = { stages: [] };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'anything',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
    expect(out.report.stages).toHaveLength(0);
    expect(out.report.overallScore).toBe(1.0);
  });

  // Security: very large JSON schema — shouldn't OOM
  it('schema stage: handles deeply nested content without crashing', async () => {
    const bigContent = JSON.stringify({ name: 'a'.repeat(100_000) });
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'object', required: ['name'] } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: bigContent,
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.accepted).toBe(true);
  });

  // Security: JSON with prototype pollution attempt
  it('schema stage: rejects __proto__ injection in content gracefully', async () => {
    const opts: EvalPipelineOptions = {
      stages: [{ type: 'schema', schema: { type: 'object', required: ['name'] } }],
    };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: '{"__proto__":{"polluted":true},"name":"ok"}',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    // Should either accept (required field present) or reject but NOT throw
    expect(() => out.report.accepted).not.toThrow();
    // Ensure prototype is not polluted
    expect((({} as Record<string, unknown>)['polluted'])).toBeUndefined();
  });

  // Stress: many stages in pipeline
  it('stress: 20-stage pipeline runs without error', async () => {
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: true, score: 0.8 } satisfies CritiqueResult),
    };
    const stages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { type: 'schema' as const, schema: { type: 'string' } }
        : { type: 'reflect' as const, critic },
    );
    const opts: EvalPipelineOptions = { stages, failFast: false };
    const out = await runEvalPipeline(opts, {
      ctx: makeCtx(),
      content: 'hello',
      agentModel: makeModel(''),
      agentName: 'test',
    });
    expect(out.report.stages).toHaveLength(20);
  });
});

// ─── P6-2: weaveA2ASupervisor ─────────────────────────────────

describe('P6-2: weaveA2ASupervisor', () => {

  function makeSupervisor(modelResponse = 'Hello!') {
    return weaveA2ASupervisor({
      name: 'test-supervisor',
      agentCard: { description: 'Test supervisor' },
      model: makeModel(modelResponse),
    });
  }

  function makeParams(text: string, taskId?: string): A2ATaskSendParams {
    return {
      message: {
        role: 'user',
        parts: [{ text }],
        messageId: 'msg-1',
        contextId: 'ctx-1',
      },
      ...(taskId ? { metadata: { taskId } } : {}),
    };
  }

  it('handleMessage: returns completed task', async () => {
    const sup = makeSupervisor('Done!');
    const task = await sup.handleMessage(makeCtx(), makeParams('hello'));
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0]?.parts[0]).toMatchObject({ text: 'Done!' });
  });

  it('handleMessage: uses provided taskId from metadata', async () => {
    const sup = makeSupervisor('ok');
    const task = await sup.handleMessage(makeCtx(), makeParams('hello', 'my-task-id'));
    expect(task.id).toBe('my-task-id');
  });

  it('getTask: returns null for unknown task', async () => {
    const sup = makeSupervisor();
    const task = await sup.getTask!(makeCtx(), 'unknown-id');
    expect(task).toBeNull();
  });

  it('getTask: returns saved task after handleMessage', async () => {
    const sup = makeSupervisor('reply');
    const created = await sup.handleMessage(makeCtx(), makeParams('ping'));
    const fetched = await sup.getTask!(makeCtx(), created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('listTasks: returns all tasks', async () => {
    const sup = makeSupervisor('r');
    await sup.handleMessage(makeCtx(), makeParams('task 1'));
    await sup.handleMessage(makeCtx(), makeParams('task 2'));
    const page = await sup.listTasks!(makeCtx());
    expect(page.tasks).toHaveLength(2);
  });

  it('cancelTask: marks task as cancelled', async () => {
    const sup = makeSupervisor('r');
    const task = await sup.handleMessage(makeCtx(), makeParams('work'));
    await sup.cancelTask!(makeCtx(), task.id);
    const fetched = await sup.getTask!(makeCtx(), task.id);
    expect(fetched?.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('createPushConfig: stores and retrieves config by pushConfigId', async () => {
    const sup = makeSupervisor();
    const task = await sup.handleMessage(makeCtx(), makeParams('t'));
    const entry = await sup.createPushConfig!(makeCtx(), task.id, { url: 'https://cb.example.com' });
    expect(entry.pushConfigId).toBeTruthy();
    expect(entry.taskId).toBe(task.id);
    const fetched = await sup.getPushConfig!(makeCtx(), task.id, entry.pushConfigId);
    expect(fetched?.url).toBe('https://cb.example.com');
  });

  it('deletePushConfig: removes config and returns true', async () => {
    const sup = makeSupervisor();
    const task = await sup.handleMessage(makeCtx(), makeParams('t'));
    const entry = await sup.createPushConfig!(makeCtx(), task.id, { url: 'https://cb.example.com' });
    const deleted = await sup.deletePushConfig!(makeCtx(), task.id, entry.pushConfigId);
    expect(deleted).toBe(true);
    const fetched = await sup.getPushConfig!(makeCtx(), task.id, entry.pushConfigId);
    expect(fetched).toBeNull();
  });

  it('handleStreamMessage: yields working → completed tasks', async () => {
    const sup = makeSupervisor('stream result');
    const params = makeParams('stream this');
    const events: unknown[] = [];
    for await (const ev of sup.handleStreamMessage!(makeCtx(), params)) {
      events.push(ev);
    }
    expect(events.length).toBeGreaterThanOrEqual(2); // working + final
    const last = events[events.length - 1] as { task: { status: { state: string } } };
    expect(last.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('handleMessage: model error results in FAILED task', async () => {
    const failingModel: Model = {
      generate: vi.fn().mockRejectedValue(new Error('Model crashed')),
    } as unknown as Model;
    const sup = weaveA2ASupervisor({ name: 'fail-sup', model: failingModel });
    const task = await sup.handleMessage(makeCtx(), makeParams('do something'));
    expect(task.status.state).toBe('TASK_STATE_FAILED');
  });

  it('stop: aborts all in-flight tasks', async () => {
    const sup = makeSupervisor();
    await sup.stop();
    // Should not throw and subsequent getTask calls should still work
    const task = await sup.getTask!(makeCtx(), 'any-id');
    expect(task).toBeNull();
  });

  it('card: has valid A2A agent card', () => {
    const sup = makeSupervisor();
    expect(sup.card.name).toBe('test-supervisor');
    expect(sup.card.supportedInterfaces).toHaveLength(1);
    expect(sup.card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC');
  });

  it('custom taskStore: can inject external store', async () => {
    const store = createInMemoryA2ATaskStore();
    const sup = weaveA2ASupervisor({ name: 'stored', model: makeModel('ok'), taskStore: store });
    const task = await sup.handleMessage(makeCtx(), makeParams('hello'));
    const external = await store.load(task.id);
    expect(external?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  // Security: very long message
  it('security: handles very long message without hanging', async () => {
    const longText = 'x'.repeat(100_000);
    const sup = makeSupervisor('ok');
    const task = await sup.handleMessage(makeCtx(), makeParams(longText));
    expect(task.id).toBeTruthy();
  });

  // Security: empty message
  it('security: handles empty message text', async () => {
    const sup = makeSupervisor('ok');
    const task = await sup.handleMessage(makeCtx(), makeParams(''));
    expect(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED']).toContain(task.status.state);
  });

  // Stress: 50 concurrent tasks
  it('stress: 50 concurrent handleMessage calls complete without corruption', async () => {
    const sup = makeSupervisor('ok');
    const tasks = await Promise.all(
      Array.from({ length: 50 }, (_, i) => sup.handleMessage(makeCtx(), makeParams(`task ${i}`))),
    );
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(50);
  });
});

// ─── P6-3: Cost-aware routing in weaveAgent ───────────────────

describe('P6-3: costGovernor option', () => {

  it('costGovernor with no ledger: agent still runs without error', async () => {
    const model = makeModel('result');
    const agent = weaveAgent({
      name: 'cost-agent',
      model,
      costGovernor: {
        bundle: {
          policy: { tier: 'balanced' } as never,
          modelResolver: async () => null,
          toolFilter: async () => null,
          promptShaper: async () => null,
          cacheShaper: { compute: () => null },
          historyCompactor: (h) => h,
          budgetGate: { check: () => {} },
          maxStepsCap: 20,
          reasoningEffort: 'medium' as const,
          toolOutputTruncator: (s: string) => ({ text: s, truncated: false, originalBytes: Buffer.byteLength(s) }),
        },
      },
    });
    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('result');
  });
});

// ─── P6-4: Compliance-aware tool execution ────────────────────

describe('P6-4: complianceTools option', () => {

  it('complianceTools: runs tool when compliance is not wired (no ctx.runtime.compliance)', async () => {
    const echoed: string[] = [];
    const model: Model = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"msg":"hi"}' }],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        })
        .mockResolvedValueOnce({
          content: 'done',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        }),
    } as unknown as Model;

    const tools = makeToolRegistry([
      { name: 'echo', description: 'Echo', execute: async (p) => { echoed.push(String(p['msg'] ?? '')); return `echoed: ${p['msg']}`; } },
    ]);

    const agent = weaveAgent({
      name: 'compliance-agent',
      model,
      tools,
      complianceTools: {
        subjectId: 'user-42',
        purpose: 'test',
        enforceConsent: true,
      },
    });

    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'echo hi' }] });
    // Without compliance wired, tool should run (fail-open)
    expect(result.status).toBe('completed');
    expect(echoed).toContain('hi');
  });

  it('complianceTools with enforceConsent: blocks tool when consent denied', async () => {
    const model: Model = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'sensitive_tool', arguments: '{}' }],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        })
        .mockResolvedValueOnce({
          content: 'ok',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        }),
    } as unknown as Model;

    let toolExecuted = false;
    const tools = makeToolRegistry([
      { name: 'sensitive_tool', description: 'Sensitive op', execute: async () => { toolExecuted = true; return 'executed'; } },
    ]);

    const agent = weaveAgent({
      name: 'gated-agent',
      model,
      tools,
      complianceTools: {
        subjectId: 'user-blocked',
        purpose: 'test',
        enforceConsent: true,
      },
    });

    // Wire a compliance runtime that denies consent
    const ctx = makeCtx({
      runtime: {
        compliance: {
          isAllowed: (_subjectId: string, _purpose: string) => false,
          auditLog: vi.fn(),
        },
      } as unknown as ExecutionContext['runtime'],
    });

    const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'do sensitive thing' }] });
    expect(result.status).toBe('completed');
    expect(toolExecuted).toBe(false); // tool was blocked
  });
});

// ─── P6-5: Vision loop ────────────────────────────────────────

describe('P6-5: visionLoop option', () => {

  it('visionLoop: detects screenshot output and triggers additional model call', async () => {
    const screenshotBase64 = 'iVBORw0KGgo='; // fake base64 PNG
    const screenshotResult = JSON.stringify({ format: 'png', base64: screenshotBase64 });

    let callCount = 0;
    const messagesPerCall: unknown[][] = [];
    const model: Model = {
      generate: vi.fn().mockImplementation((_, req) => {
        callCount++;
        messagesPerCall.push([...(req.messages ?? [])]);
        if (callCount === 1) {
          return Promise.resolve({
            content: '',
            toolCalls: [{ id: 'tc1', name: 'browser_screenshot', arguments: '{}' }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          });
        }
        return Promise.resolve({
          content: 'I can see the page now.',
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        });
      }),
    } as unknown as Model;

    const tools = makeToolRegistry([
      { name: 'browser_screenshot', description: 'Take screenshot', execute: async () => screenshotResult },
    ]);
    const agent = weaveAgent({
      name: 'vision-agent',
      model,
      visionLoop: true,
      tools,
    });

    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'show me the screen' }] });
    expect(result.status).toBe('completed');
    // At least 2 generate calls: one for tool, one after seeing screenshot
    expect(callCount).toBeGreaterThanOrEqual(2);
    // The second call's messages should include the screenshot as image content
    const secondCallMessages = messagesPerCall[1] ?? [];
    const hasImageContent = secondCallMessages.some(
      (m) => Array.isArray((m as { content?: unknown }).content),
    );
    expect(hasImageContent).toBe(true);
  });

  it('visionLoop=false: does not inject vision messages for screenshot outputs', async () => {
    const screenshotResult = JSON.stringify({ format: 'png', base64: 'abc123=' });
    const capturedMessages: Array<{ role: string; content: unknown }> = [];

    const model: Model = {
      generate: vi.fn().mockImplementation((_, req) => {
        capturedMessages.push(...(req.messages ?? []));
        if (capturedMessages.length <= 2) {
          return Promise.resolve({
            content: '',
            toolCalls: [{ id: 'tc1', name: 'screenshot', arguments: '{}' }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          });
        }
        return Promise.resolve({
          content: 'done',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        });
      }),
    } as unknown as Model;

    const tools2 = makeToolRegistry([
      { name: 'screenshot', description: 'Take screenshot', execute: async () => screenshotResult },
    ]);
    const agent = weaveAgent({
      name: 'no-vision-agent',
      model,
      visionLoop: false,
      tools: tools2,
    });

    await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'screenshot please' }] });
    // No image content should be in captured messages
    const imageMsgs = capturedMessages.filter((m) => Array.isArray(m.content));
    expect(imageMsgs).toHaveLength(0);
  });

  // Security: malformed screenshot JSON doesn't crash
  it('visionLoop: handles malformed screenshot JSON gracefully', async () => {
    const model: Model = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'shot', arguments: '{}' }],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        })
        .mockResolvedValueOnce({
          content: 'done',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        }),
    } as unknown as Model;

    const malformedTools = makeToolRegistry([
      { name: 'shot', description: 'Broken screenshot', execute: async () => '{ invalid json <<<' },
    ]);
    const agent = weaveAgent({
      name: 'malformed-vision',
      model,
      visionLoop: true,
      tools: malformedTools,
    });

    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'go' }] });
    expect(result.status).toBe('completed');
  });

  // Security: base64 bomb — huge base64 string shouldn't crash
  it('visionLoop: handles very large base64 without crashing', async () => {
    const hugeBase64 = 'A'.repeat(1_000_000);
    const screenshotResult = JSON.stringify({ format: 'png', base64: hugeBase64 });

    const model: Model = {
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'shot', arguments: '{}' }],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        })
        .mockResolvedValueOnce({
          content: 'done',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        }),
    } as unknown as Model;

    const largeTools = makeToolRegistry([
      { name: 'shot', description: 'Huge screenshot', execute: async () => screenshotResult },
    ]);
    const agent = weaveAgent({
      name: 'large-vision',
      model,
      visionLoop: true,
      tools: largeTools,
    });

    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'go' }] });
    expect(result.status).toBe('completed');
  });
});

// ─── P6 integration: multiple features together ───────────────

describe('P6 integration: combined features', () => {

  it('eval pipeline + vision loop: both apply independently', async () => {
    const critic: Critic = {
      critique: vi.fn().mockResolvedValue({ accepted: true, score: 0.95 } satisfies CritiqueResult),
    };
    const agent = weaveAgent({
      name: 'combined-agent',
      model: makeModel('integrated result'),
      visionLoop: true,
      evalPipeline: {
        stages: [{ type: 'reflect', critic }],
      },
    });
    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'do both' }] });
    expect(result.status).toBe('completed');
    expect(result.metadata?.['evalPipeline']).toBeDefined();
    const report = result.metadata?.['evalPipeline'] as { accepted: boolean };
    expect(report.accepted).toBe(true);
  });

  it('eval pipeline with schema stage: metadata captured in AgentResult', async () => {
    const agent = weaveAgent({
      name: 'schema-agent',
      model: makeModel('{"answer":"42"}'),
      evalPipeline: {
        stages: [{ type: 'schema', schema: { type: 'object', required: ['answer'] } }],
      },
    });
    const result = await agent.run(makeCtx(), { messages: [{ role: 'user', content: 'give JSON' }] });
    expect(result.status).toBe('completed');
    expect(result.metadata?.['evalPipeline']).toBeDefined();
    const report = result.metadata?.['evalPipeline'] as { accepted: boolean; stages: unknown[] };
    expect(report.accepted).toBe(true);
    expect(report.stages).toHaveLength(1);
  });
});
