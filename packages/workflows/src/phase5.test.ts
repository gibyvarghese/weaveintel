/**
 * Phase 5 unit tests — input validation, cost ceiling, replay determinism.
 */
import { describe, it, expect } from 'vitest';
import {
  DefaultWorkflowEngine,
  validateWorkflowInput,
  WorkflowInputValidationError,
  InMemoryCostMeter,
  WorkflowReplayRecorder,
  createReplayRegistry,
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  InMemoryWorkflowRunRepository,
  type WorkflowEngineOptions,
  type WorkflowRunRepository,
} from './index.js';
import type { WorkflowDefinition, WorkflowPolicy, WorkflowRun } from '@weaveintel/core';

function basicDef(extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test',
    version: '1.0.0',
    entryStepId: 'a',
    steps: [
      { id: 'a', name: 'A', type: 'deterministic', handler: 'noop', next: 'b' },
      { id: 'b', name: 'B', type: 'deterministic', handler: 'noop' },
    ],
    ...extra,
  };
}

function makeEngine(opts: WorkflowEngineOptions = {}): DefaultWorkflowEngine {
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createScriptResolver());
  return new DefaultWorkflowEngine({ resolverRegistry: reg, ...opts });
}

/** Repo wrapper that captures the first runId seen so resolvers can charge a meter. */
class RunIdCapturingRepo implements WorkflowRunRepository {
  inner = new InMemoryWorkflowRunRepository();
  firstId: string | null = null;
  async save(run: WorkflowRun): Promise<void> {
    if (!this.firstId) this.firstId = run.id;
    return this.inner.save(run);
  }
  get(id: string) { return this.inner.get(id); }
  list(workflowId?: string) { return this.inner.list(workflowId); }
  delete(id: string) { return this.inner.delete(id); }
}

describe('Phase 5A.1 — input schema validation', () => {
  it('accepts well-formed input', () => {
    const r = validateWorkflowInput({ name: 'x', n: 5 }, {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, n: { type: 'number', minimum: 0 } },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects missing required', () => {
    const r = validateWorkflowInput({}, { type: 'object', required: ['name'] });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.path).toBe('name');
  });

  it('rejects nested type mismatch with full path', () => {
    const r = validateWorkflowInput(
      { user: { age: 'oops' } },
      { type: 'object', properties: { user: { type: 'object', properties: { age: { type: 'number' } } } } },
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.path).toBe('user.age');
  });

  it('enforces enum + bounds', () => {
    const r = validateWorkflowInput({ s: 'BIG', n: 200 }, {
      type: 'object',
      properties: { s: { enum: ['a', 'b'] }, n: { type: 'number', maximum: 100 } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
  });

  it('engine.startRun rejects invalid input', async () => {
    const engine = makeEngine();
    await engine.createDefinition(basicDef({ inputSchema: { type: 'object', required: ['must'] } }));
    await expect(engine.startRun('wf-test', {})).rejects.toBeInstanceOf(WorkflowInputValidationError);
  });

  it('engine.startRun accepts valid input', async () => {
    const engine = makeEngine();
    await engine.createDefinition(basicDef({ inputSchema: { type: 'object', required: ['must'] } }));
    const run = await engine.startRun('wf-test', { must: 'ok' });
    expect(run.status).toBe('completed');
  });
});

describe('Phase 5A.2 — cost ceiling', () => {
  it('halts run when cumulative cost exceeds policy.costCeiling', async () => {
    const meter = new InMemoryCostMeter();
    const events: Array<{ type: string }> = [];
    const repo = new RunIdCapturingRepo();
    const reg = new HandlerResolverRegistry();
    reg.register({
      kind: 'noop',
      resolve: async () => async () => {
        if (repo.firstId) meter.record(repo.firstId, { costUsd: 0.3 });
        return {};
      },
    });

    const policy: WorkflowPolicy = { costCeiling: 0.5 };
    const engine = new DefaultWorkflowEngine({
      resolverRegistry: reg,
      costMeter: meter,
      defaultPolicy: policy,
      runRepository: repo,
      bus: {
        emit: (e: { type: string }) => { events.push(e); return 0; },
        on: () => () => {},
        onAll: () => () => {},
        onMatch: () => () => {},
      } as unknown as import('@weaveintel/core').EventBus,
    });
    await engine.createDefinition(basicDef());
    const run = await engine.startRun('wf-test', {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Cost ceiling exceeded/);
    expect(events.some(e => e.type === 'workflow:cost_exceeded')).toBe(true);
    expect(typeof run.costTotal).toBe('number');
    expect(run.costTotal!).toBeGreaterThan(0.5);
  });

  it('does not halt when costCeiling is unset', async () => {
    const meter = new InMemoryCostMeter();
    const reg = new HandlerResolverRegistry();
    reg.register(createNoopResolver());
    const engine = new DefaultWorkflowEngine({ resolverRegistry: reg, costMeter: meter });
    await engine.createDefinition(basicDef());
    const r = await engine.startRun('wf-test', {});
    meter.record(r.id, { costUsd: 999 });
    expect(r.status).toBe('completed');
  });

  it('records final costTotal on completion', async () => {
    const meter = new InMemoryCostMeter();
    const repo = new RunIdCapturingRepo();
    const reg = new HandlerResolverRegistry();
    reg.register({
      kind: 'noop',
      resolve: async () => async () => {
        if (repo.firstId) meter.record(repo.firstId, { costUsd: 0.1 });
        return {};
      },
    });
    const engine = new DefaultWorkflowEngine({
      resolverRegistry: reg,
      costMeter: meter,
      runRepository: repo,
    });
    await engine.createDefinition(basicDef());
    const run = await engine.startRun('wf-test', {});
    expect(run.status).toBe('completed');
    expect(run.costTotal).toBeCloseTo(0.2, 5);
  });
});

describe('Phase 5A.3 — replay recorder + replay registry', () => {
  it('recorder appends ordered steps per runId', () => {
    const r = new WorkflowReplayRecorder();
    r.record('R', { stepId: 'a', handler: 'noop', kind: 'noop', config: {}, variables: {}, output: { v: 1 } });
    r.record('R', { stepId: 'b', handler: 'noop', kind: 'noop', config: {}, variables: {}, output: { v: 2 } });
    const trace = r.trace('R', 'wf');
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]?.ordinal).toBe(0);
    expect(trace.steps[1]?.ordinal).toBe(1);
    expect(trace.steps[0]?.output).toEqual({ v: 1 });
  });

  it('replay registry replays a workflow deterministically', async () => {
    const def: WorkflowDefinition = {
      id: 'wf-replay',
      name: 'Replay',
      version: '1.0.0',
      entryStepId: 's1',
      steps: [
        { id: 's1', name: 'S1', type: 'deterministic', handler: 'noop', next: 's2' },
        { id: 's2', name: 'S2', type: 'deterministic', handler: 'noop' },
      ],
    };
    const replayReg = createReplayRegistry({
      runId: 'R',
      workflowId: 'wf-replay',
      steps: [
        { ordinal: 0, stepId: 's1', handler: 'noop', kind: 'noop', config: {}, variables: {}, output: { value: 42 }, recordedAt: 0 },
        { ordinal: 1, stepId: 's2', handler: 'noop', kind: 'noop', config: {}, variables: {}, output: { done: true }, recordedAt: 0 },
      ],
    });
    const engine = new DefaultWorkflowEngine({ resolverRegistry: replayReg });
    await engine.createDefinition(def);
    const run = await engine.startRun('wf-replay', {});
    expect(run.status).toBe('completed');
    expect(run.state.history[0]?.output).toEqual({ value: 42 });
    expect(run.state.history[1]?.output).toEqual({ done: true });
  });

  it('replay registry fails workflow on trace overrun', async () => {
    const replayReg = createReplayRegistry({
      runId: 'R',
      workflowId: 'wf',
      steps: [
        // Trace has only 1 step but workflow has 2 — second invocation overruns.
        { ordinal: 0, stepId: 'a', handler: 'noop', kind: 'noop', config: {}, variables: {}, output: {}, recordedAt: 0 },
      ],
    });
    const engine = new DefaultWorkflowEngine({ resolverRegistry: replayReg });
    await engine.createDefinition({
      id: 'wf-x',
      name: 'X',
      version: '1.0.0',
      entryStepId: 'a',
      steps: [
        { id: 'a', name: 'A', type: 'deterministic', handler: 'noop', next: 'b' },
        { id: 'b', name: 'B', type: 'deterministic', handler: 'noop' },
      ],
    });
    const r = await engine.startRun('wf-x', {});
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Replay overrun/);
  });
});
