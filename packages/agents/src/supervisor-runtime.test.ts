/**
 * Unit + regression tests for supervisor-runtime.ts
 *
 * Critical regression (P1-1): verify that reset() clears per-run state so a
 * single supervisor instance can handle multiple consecutive run() calls.
 * The bug: delegationResults and thinkingLog were allocated ONCE in the
 * closure, so after the first run exhausted maxDelegations the second run
 * would immediately hit the delegation cap.
 */

import { describe, it, expect } from 'vitest';
import { buildSupervisorRuntime } from './supervisor-runtime.js';
import { makeCtx, makeAuditCtx, stubAgent } from './test-helpers.js';
import { weaveAgent } from './agent.js';
import {
  weaveRuntime,
  weaveContext,
  Capabilities,
  type Model,
  type ExecutionContext,
  type ModelRequest,
  type ModelResponse,
} from '@weaveintel/core';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRuntime(opts: { name: string; outputText: string }) {
  return buildSupervisorRuntime({
    supervisorName: 'test-supervisor',
    workers: [{ name: opts.name, description: 'test worker', model: {} as Model }],
    buildWorkerAgent: (_w) => stubAgent(opts.outputText, _w.name),
    maxDelegations: 2,
  });
}

/** Call a tool by name on the runtime's tool registry. */
async function callTool(
  ctx: ExecutionContext,
  runtime: ReturnType<typeof buildSupervisorRuntime>,
  toolName: string,
  args: Record<string, unknown>,
) {
  const tool = runtime.tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not found`);
  return tool.invoke(ctx, { name: toolName, arguments: args });
}

// ── Interface ─────────────────────────────────────────────────────────────────

describe('buildSupervisorRuntime — interface', () => {
  it('returns tools, systemPrompt, workersConfig, reset', () => {
    const rt = makeRuntime({ name: 'worker', outputText: 'ok' });
    expect(typeof rt.tools).toBe('object');
    expect(typeof rt.systemPrompt).toBe('string');
    expect(typeof rt.workersConfig).toBe('object');
    expect(typeof rt.reset).toBe('function');
  });

  it('workersConfig includes each worker by name', () => {
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [
        { name: 'alpha', description: 'A', model: {} as Model },
        { name: 'beta', description: 'B', model: {} as Model },
      ],
      buildWorkerAgent: (_w) => stubAgent('x', _w.name),
      maxDelegations: 4,
    });
    expect(rt.workersConfig).toHaveProperty('alpha');
    expect(rt.workersConfig).toHaveProperty('beta');
  });

  it('systemPrompt contains worker names', () => {
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'my-worker', description: 'does stuff', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('x', _w.name),
      maxDelegations: 2,
    });
    expect(rt.systemPrompt).toContain('my-worker');
  });

  it('utility tools are registered by default (datetime, math_eval, unit_convert)', () => {
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    expect(rt.tools.get('datetime')).toBeDefined();
    expect(rt.tools.get('math_eval')).toBeDefined();
    expect(rt.tools.get('unit_convert')).toBeDefined();
  });

  it('includeUtilityTools=false skips utility tools', () => {
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('x', _w.name),
      maxDelegations: 2,
      includeUtilityTools: false,
    });
    expect(rt.tools.get('datetime')).toBeUndefined();
    expect(rt.tools.get('math_eval')).toBeUndefined();
  });

  it('think and plan tools are always registered', () => {
    const rt = makeRuntime({ name: 'w', outputText: 'x' });
    expect(rt.tools.get('think')).toBeDefined();
    expect(rt.tools.get('plan')).toBeDefined();
  });

  it('delegate_to_worker is always registered', () => {
    const rt = makeRuntime({ name: 'w', outputText: 'x' });
    expect(rt.tools.get('delegate_to_worker')).toBeDefined();
  });

  it('delegate_to_workers_parallel only registered when parallelDelegation=true', () => {
    const withParallel = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('x', _w.name),
      maxDelegations: 4,
      parallelDelegation: true,
    });
    expect(withParallel.tools.get('delegate_to_workers_parallel')).toBeDefined();

    const withoutParallel = makeRuntime({ name: 'w', outputText: 'x' });
    expect(withoutParallel.tools.get('delegate_to_workers_parallel')).toBeUndefined();
  });
});

// ── think tool ────────────────────────────────────────────────────────────────

describe('think tool', () => {
  it('returns a log string containing the thought', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    const result = await callTool(ctx, rt, 'think', { thought: 'I need to plan', reasoning_phase: 'planning' });
    expect(result.content).toContain('I need to plan');
    expect(result.content).toContain('PLANNING');
  });

  it('defaults reasoning_phase to "analysis" when omitted', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    const result = await callTool(ctx, rt, 'think', { thought: 'analyzing...' });
    expect(result.content).toContain('ANALYSIS');
  });

  it('accumulates multiple thoughts before reset', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    await callTool(ctx, rt, 'think', { thought: 'thought 1' });
    await callTool(ctx, rt, 'think', { thought: 'thought 2' });
    // Both should succeed without error
    const result = await callTool(ctx, rt, 'think', { thought: 'thought 3' });
    expect(result.isError).toBeFalsy();
  });
});

// ── plan tool ─────────────────────────────────────────────────────────────────

describe('plan tool', () => {
  it('returns a plan string containing objective', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    const result = await callTool(ctx, rt, 'plan', {
      objective: 'Find the answer',
      approach: 'Search then verify',
      workers_needed: 'researcher',
    });
    expect(result.content).toContain('Find the answer');
    expect(result.content).toContain('Search then verify');
  });

  it('includes blockers when provided', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    const result = await callTool(ctx, rt, 'plan', {
      objective: 'obj',
      approach: 'approach',
      workers_needed: 'w',
      blockers: 'may be slow',
    });
    expect(result.content).toContain('may be slow');
  });
});

// ── delegate_to_worker ────────────────────────────────────────────────────────

describe('delegate_to_worker tool', () => {
  it('delegates to the worker and returns its output', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'researcher', description: 'finds things', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('research result', _w.name),
      maxDelegations: 5,
    });
    const result = await callTool(ctx, rt, 'delegate_to_worker', {
      worker: 'researcher',
      goal: 'Find the answer to life',
    });
    expect(result.content).toContain('research result');
    expect(result.isError).toBeFalsy();
  });

  it('delegation to unknown worker returns an error string (not a throw)', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'real-worker', outputText: 'ok' });
    const result = await callTool(ctx, rt, 'delegate_to_worker', {
      worker: 'nonexistent-worker',
      goal: 'do something',
    });
    expect(result.content).toContain('Error');
    expect(result.content).toContain('nonexistent-worker');
  });

  it('maxDelegations enforced within a single run: returning error after cap', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'test', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('ok', _w.name),
      maxDelegations: 1, // cap at 1
    });

    // First delegation should succeed
    const first = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task 1' });
    expect(first.content).toContain('ok');

    // Second delegation should hit the cap
    const second = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task 2' });
    expect(second.content).toContain('Maximum number of delegations');
  });

  it('policy.approveDelegation denial returns denial message without calling worker', async () => {
    const ctx = makeCtx();
    let workerCalled = false;
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => {
        const a = stubAgent('ok', _w.name);
        const origRun = a.run.bind(a);
        a.run = async (...args) => { workerCalled = true; return origRun(...args); };
        return a;
      },
      maxDelegations: 5,
      policy: {
        async shouldContinue() { return { continue: true }; },
        async approveDelegation() { return { approved: false, reason: 'test-denied' }; },
      },
    });
    const result = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'do it' });
    expect(result.content).toContain('Delegation denied');
    expect(result.content).toContain('test-denied');
    expect(workerCalled).toBe(false);
  });
});

// ── P1-1 REGRESSION: reset() clears state between run() calls ────────────────

describe('P1-1 regression — reset() clears per-run state', () => {
  it('reset() allows delegation on a fresh run after maxDelegations was reached', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => stubAgent('result', _w.name),
      maxDelegations: 1,
    });

    // Exhaust the delegation budget in the first run
    const first = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task 1' });
    expect(first.content).toContain('result'); // first call succeeds

    const overCap = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task 2' });
    expect(overCap.content).toContain('Maximum'); // cap hit

    // Reset — simulates start of a new run() call
    rt.reset();

    // After reset, delegation should work again
    const afterReset = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task 3' });
    expect(afterReset.content).toContain('result');
    expect(afterReset.content).not.toContain('Maximum');
  });

  it('reset() clears thinking log (no cross-run state pollution)', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'x' });

    // First "run" — add thoughts
    await callTool(ctx, rt, 'think', { thought: 'pre-reset thought' });
    rt.reset();

    // After reset, think should work without any accumulated state from before
    const result = await callTool(ctx, rt, 'think', { thought: 'post-reset thought' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('post-reset thought');
  });

  it('reset() is idempotent — multiple resets without delegates do not break', async () => {
    const ctx = makeCtx();
    const rt = makeRuntime({ name: 'w', outputText: 'ok' });
    rt.reset();
    rt.reset();
    rt.reset();
    const result = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'task' });
    expect(result.content).toContain('ok');
  });
});

// ── P1-1 REGRESSION via weaveAgent end-to-end ────────────────────────────────
//
// This is the most important test: a supervisor Agent instance created by
// weaveAgent() must be re-runnable without bleeding delegation counts from
// a previous invocation. Prior to the fix the second run() would immediately
// return "Maximum number of delegations reached" on the first delegate call.

describe('P1-1 regression — weaveAgent supervisor reusable across run() calls', () => {
  /** Scripted model for supervisor: always delegates to "worker", then responds. */
  function makeSupervisorModel(): Model {
    const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
    let callCount = 0;
    return {
      info: { provider: 'stub', modelId: 'sup-model', capabilities: caps },
      capabilities: caps,
      hasCapability: (id) => caps.has(id),
      async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        // Odd calls: delegate; even calls: terminal response
        if (callCount % 2 === 1) {
          return {
            id: `r${callCount}`,
            model: 'sup-model',
            content: '',
            toolCalls: [{ id: `tc${callCount}`, name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'w', goal: 'sub-task' }) }],
            finishReason: 'tool_calls',
            usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          };
        }
        return {
          id: `r${callCount}`,
          model: 'sup-model',
          content: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        };
      },
    };
  }

  it('second run() on same supervisor instance completes successfully', async () => {
    const model = makeSupervisorModel();
    const supervisor = weaveAgent({
      model,
      name: 'test-supervisor',
      workers: [{ name: 'w', description: 'worker', model: {} as Model }],
      maxDelegations: 2,
    });

    const audit: import('@weaveintel/core').AuditLogger = { async log() {} };
    const runtime = weaveRuntime({ audit });
    const ctx = weaveContext({ runtime });

    // — First run —
    const first = await supervisor.run(ctx, { messages: [{ role: 'user', content: 'first request' }] });
    expect(first.status).toBe('completed');
    expect(first.output).toBe('done');

    // — Second run on the SAME agent instance —
    const second = await supervisor.run(ctx, { messages: [{ role: 'user', content: 'second request' }] });

    // Without the P1-1 fix the second run would fail immediately when
    // delegate_to_worker checked delegationResults.length >= maxDelegations.
    expect(second.status).toBe('completed');
    expect(second.output).toBe('done');
  });

  it('third run also succeeds — no cross-run accumulation', async () => {
    const model = makeSupervisorModel();
    const supervisor = weaveAgent({
      model,
      name: 'test-supervisor-3x',
      workers: [{ name: 'w', description: 'worker', model: {} as Model }],
      maxDelegations: 2,
    });

    const audit: import('@weaveintel/core').AuditLogger = { async log() {} };
    const runtime = weaveRuntime({ audit });
    const ctx = weaveContext({ runtime });

    for (let i = 0; i < 3; i++) {
      const result = await supervisor.run(ctx, { messages: [{ role: 'user', content: `request ${i + 1}` }] });
      expect(result.status).toBe('completed');
    }
  });
});

// ── W3 — replanOnFailure ─────────────────────────────────────────────────────

describe('replanOnFailure', () => {
  it('failed worker output includes REPLAN_REQUIRED when flag is on', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => {
        const config = { name: _w.name };
        return {
          config,
          async run() {
            return {
              output: '',
              messages: [],
              steps: [],
              usage: { totalSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDurationMs: 0, toolCalls: 0, delegations: 0 },
              status: 'failed' as const,
            };
          },
        };
      },
      maxDelegations: 5,
      replanOnFailure: true,
    });

    const result = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'fail' });
    expect(result.content).toContain('REPLAN_REQUIRED');
    expect(result.content).toContain('WORKER_FAILED');
  });

  it('failed worker without replanOnFailure: returns raw output only', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (_w) => ({
        config: { name: _w.name },
        async run() {
          return {
            output: 'partial result',
            messages: [],
            steps: [],
            usage: { totalSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDurationMs: 0, toolCalls: 0, delegations: 0 },
            status: 'failed' as const,
          };
        },
      }),
      maxDelegations: 5,
      replanOnFailure: false,
    });

    const result = await callTool(ctx, rt, 'delegate_to_worker', { worker: 'w', goal: 'do thing' });
    expect(result.content).not.toContain('REPLAN_REQUIRED');
  });
});

// ── W3 — parallel delegation ──────────────────────────────────────────────────

describe('delegate_to_workers_parallel', () => {
  it('runs tasks in parallel and aggregates results', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [
        { name: 'alpha', description: 'A', model: {} as Model },
        { name: 'beta', description: 'B', model: {} as Model },
      ],
      buildWorkerAgent: (w) => stubAgent(`${w.name}-done`, w.name),
      maxDelegations: 10,
      parallelDelegation: true,
    });

    const result = await callTool(ctx, rt, 'delegate_to_workers_parallel', {
      tasks: [
        { worker: 'alpha', goal: 'task A' },
        { worker: 'beta', goal: 'task B' },
      ],
    });
    expect(result.content).toContain('alpha-done');
    expect(result.content).toContain('beta-done');
  });

  it('parallel dispatch exceeding maxDelegations returns an error', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [
        { name: 'a', description: 'A', model: {} as Model },
        { name: 'b', description: 'B', model: {} as Model },
        { name: 'c', description: 'C', model: {} as Model },
      ],
      buildWorkerAgent: (w) => stubAgent('ok', w.name),
      maxDelegations: 2,
      parallelDelegation: true,
    });

    const result = await callTool(ctx, rt, 'delegate_to_workers_parallel', {
      tasks: [
        { worker: 'a', goal: 'task A' },
        { worker: 'b', goal: 'task B' },
        { worker: 'c', goal: 'task C' }, // would push to 3, exceeding cap of 2
      ],
    });
    expect(result.content).toContain('maxDelegations');
  });

  it('unknown worker in parallel tasks returns per-task error without crashing', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'real', description: 'r', model: {} as Model }],
      buildWorkerAgent: (w) => stubAgent('ok', w.name),
      maxDelegations: 10,
      parallelDelegation: true,
    });

    const result = await callTool(ctx, rt, 'delegate_to_workers_parallel', {
      tasks: [{ worker: 'ghost', goal: 'task' }],
    });
    expect(result.content).toContain('Error');
  });

  it('empty tasks array returns an error', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (w) => stubAgent('ok', w.name),
      maxDelegations: 5,
      parallelDelegation: true,
    });
    const result = await callTool(ctx, rt, 'delegate_to_workers_parallel', { tasks: [] });
    expect(result.content).toContain('non-empty');
  });
});

// ── P1-2 regression — requireApproval via weaveAgent ─────────────────────────

describe('P1-2 regression — requireApproval → needs_approval', () => {
  function makeModelThatResponds(text = 'answer') {
    const caps = new Set([Capabilities.Chat]);
    return {
      info: { provider: 'stub', modelId: 'stub', capabilities: caps },
      capabilities: caps,
      hasCapability: (id: string) => caps.has(id as never),
      async generate(): Promise<ModelResponse> {
        return { id: 'r1', model: 'stub', content: text, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    } as Model;
  }

  it('requireApproval=true without policy gate returns needs_approval', async () => {
    const { ctx, entries } = makeAuditCtx();
    const agent = weaveAgent({ model: makeModelThatResponds(), requireApproval: true, name: 'gated' });
    const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe('needs_approval');
    expect(result.output).toBe('');
    expect(entries.some((e) => e.action === 'agent.approval.required')).toBe(true);
  });

  it('requireApproval=true WITH approveToolCall gate runs normally', async () => {
    const { ctx } = makeAuditCtx();
    const agent = weaveAgent({
      model: makeModelThatResponds('hello'),
      requireApproval: true,
      name: 'gated-with-policy',
      policy: {
        async shouldContinue() { return { continue: true }; },
        async approveToolCall() { return { approved: true }; },
      },
    });
    const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello');
  });

  it('requireApproval=false never returns needs_approval', async () => {
    const { ctx } = makeAuditCtx();
    const agent = weaveAgent({ model: makeModelThatResponds('ok'), requireApproval: false, name: 'not-gated' });
    const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe('completed');
  });

  it('requireApproval not set (default) never returns needs_approval', async () => {
    const { ctx } = makeAuditCtx();
    const agent = weaveAgent({ model: makeModelThatResponds('ok'), name: 'no-approval-flag' });
    const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe('completed');
  });
});

// ── Security: math injection via delegate goal ────────────────────────────────

describe('security — injection via delegate goal', () => {
  it('code injection in goal string does not execute — treated as plain text goal', async () => {
    const ctx = makeCtx();
    const rt = buildSupervisorRuntime({
      supervisorName: 'sv',
      workers: [{ name: 'w', description: 'd', model: {} as Model }],
      buildWorkerAgent: (w) => stubAgent('safe-output', w.name),
      maxDelegations: 5,
    });

    // This looks like an injection but is just the goal string
    const maliciousGoal = '; require("child_process").exec("rm -rf /"); //';
    const result = await callTool(ctx, rt, 'delegate_to_worker', {
      worker: 'w',
      goal: maliciousGoal,
    });
    // The stub agent simply returns its fixed output; no code is executed
    expect(result.content).toContain('safe-output');
  });
});
