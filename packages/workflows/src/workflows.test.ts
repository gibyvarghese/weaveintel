/**
 * @weaveintel/workflows — Unit tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultWorkflowEngine,
  InMemoryScheduler,
  WorkflowBuilder,
  defineWorkflow,
} from './index.js';
import { InMemoryCheckpointStore } from './checkpoint-store.js';

// ─── WorkflowBuilder ────────────────────────────────────────

describe('WorkflowBuilder', () => {
  it('builds a simple workflow definition', () => {
    const def = defineWorkflow('Test Workflow')
      .setId('test-wf')
      .deterministic('step-1', 'Validate', { handler: 'validate' })
      .agentic('step-2', 'Summarize', { handler: 'summarize' })
      .build();

    expect(def.id).toBe('test-wf');
    expect(def.name).toBe('Test Workflow');
    expect(def.steps).toHaveLength(2);
    expect(def.steps[0]!.id).toBe('step-1');
    expect(def.steps[0]!.type).toBe('deterministic');
    expect(def.steps[1]!.id).toBe('step-2');
    expect(def.steps[1]!.type).toBe('agentic');
    expect(def.entryStepId).toBe('step-1');
  });

  it('supports condition and branch steps', () => {
    const def = defineWorkflow('Branching Flow')
      .deterministic('init', 'Init')
      .condition('check', 'Check', { trueBranch: 'pass', falseBranch: 'fail' })
      .deterministic('pass', 'Pass')
      .deterministic('fail', 'Fail')
      .build();

    expect(def.steps).toHaveLength(4);
    const condStep = def.steps.find(s => s.id === 'check');
    expect(condStep?.type).toBe('condition');
  });

  it('uses first step as entry by default', () => {
    const def = defineWorkflow('Auto')
      .deterministic('first', 'First')
      .deterministic('second', 'Second')
      .build();

    expect(def.entryStepId).toBe('first');
  });
});

// ─── InMemoryCheckpointStore ────────────────────────────────

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('saves and loads checkpoints', async () => {
    const state = { currentStepId: 'step-1', variables: {}, history: [] };
    const cp = await store.save('run-1', 'step-1', state);
    const loaded = await store.load(cp.id);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe('run-1');
    expect(loaded!.stepId).toBe('step-1');
  });

  it('returns latest checkpoint for a run', async () => {
    await store.save('run-1', 'a', { currentStepId: 'a', variables: {}, history: [] });
    // Small delay to ensure different createdAt timestamps
    await new Promise(r => setTimeout(r, 5));
    await store.save('run-1', 'b', { currentStepId: 'b', variables: {}, history: [] });

    const latest = await store.latest('run-1');
    expect(latest).toBeDefined();
    expect(latest!.stepId).toBe('b');
  });

  it('lists checkpoints for a run', async () => {
    await store.save('run-1', 'a', { currentStepId: 'a', variables: {}, history: [] });
    await store.save('run-2', 'b', { currentStepId: 'b', variables: {}, history: [] });
    await store.save('run-1', 'c', { currentStepId: 'c', variables: {}, history: [] });

    const list = await store.list('run-1');
    expect(list).toHaveLength(2);
  });

  it('deletes checkpoints for a run', async () => {
    await store.save('run-1', 'a', { currentStepId: 'a', variables: {}, history: [] });
    await store.delete('run-1');
    const list = await store.list('run-1');
    expect(list).toHaveLength(0);
  });
});

// ─── InMemoryScheduler ──────────────────────────────────────

describe('InMemoryScheduler', () => {
  it('creates and disposes without error', () => {
    const scheduler = new InMemoryScheduler(async () => {});
    scheduler.dispose();
  });

  it('schedules and ticks', async () => {
    let called = false;
    const scheduler = new InMemoryScheduler(async () => { called = true; });
    await scheduler.schedule({ id: 't1', workflowId: 'wf-1', type: 'cron', enabled: true, config: { intervalMs: 60000 } });
    await scheduler.tick();
    expect(called).toBe(true);
    scheduler.dispose();
  });

  it('cancel removes the trigger', async () => {
    let count = 0;
    const scheduler = new InMemoryScheduler(async () => { count++; });
    await scheduler.schedule({ id: 't1', workflowId: 'wf-1', type: 'cron', enabled: true, config: { intervalMs: 60000 } });
    await scheduler.cancel('t1');
    await scheduler.tick();
    expect(count).toBe(0);
    scheduler.dispose();
  });
});

// ─── DefaultWorkflowEngine ──────────────────────────────────

describe('DefaultWorkflowEngine', () => {
  it('creates and retrieves definitions', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('WF1')
      .setId('wf-1')
      .deterministic('s1', 'Step 1')
      .build();
    await engine.createDefinition(def);

    const retrieved = await engine.getDefinition('wf-1');
    expect(retrieved?.id).toBe('wf-1');
  });

  it('lists definitions', async () => {
    const engine = new DefaultWorkflowEngine();
    await engine.createDefinition(defineWorkflow('A').deterministic('s', 'S').build());
    await engine.createDefinition(defineWorkflow('B').deterministic('s', 'S').build());
    const defs = await engine.listDefinitions();
    expect(defs).toHaveLength(2);
  });

  it('starts a run and completes it', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('WF1')
      .setId('wf-1')
      .deterministic('s1', 'Step 1', { handler: 'echo' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('echo', async (variables) => variables);

    const run = await engine.startRun('wf-1', { message: 'hello' });
    expect(run.id).toBeDefined();
    expect(run.workflowId).toBe('wf-1');
    expect(run.status).toBe('completed');
  });

  it('throws for nonexistent definition', async () => {
    const engine = new DefaultWorkflowEngine();
    await expect(engine.startRun('nonexistent', {})).rejects.toThrow();
  });

  it('cancels a run', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Cancel')
      .setId('wf-c')
      .wait('s1', 'Wait')
      .deterministic('s2', 'Done')
      .build();
    await engine.createDefinition(def);

    const run = await engine.startRun('wf-c', {});
    expect(run.status).toBe('paused'); // wait step pauses the run
    await engine.cancelRun(run.id);
    const cancelled = await engine.getRun(run.id);
    expect(cancelled?.status).toBe('cancelled');
  });
});
