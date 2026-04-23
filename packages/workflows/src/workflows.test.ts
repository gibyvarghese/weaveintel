/**
 * @weaveintel/workflows — Unit tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultWorkflowEngine,
  InMemoryScheduler,
  WorkflowBuilder,
  defineWorkflow,
  JsonFileWorkflowRunRepository,
} from './index.js';
import { InMemoryCheckpointStore } from './checkpoint-store.js';
import { InMemoryTaskQueue } from '@weaveintel/human-tasks';

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

// ─── Phase 3C: Step Timeout ─────────────────────────────────

describe('Step timeout enforcement', () => {
  it('fails a step that exceeds its timeout', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Timeout Test')
      .setId('wf-timeout')
      .agentic('slow', 'Slow Step', { handler: 'slow', timeout: 50 })
      .build();
    await engine.createDefinition(def);
    // Handler takes longer than the 50ms timeout
    engine.registerHandler('slow', () => new Promise(resolve => setTimeout(resolve, 500)));

    const run = await engine.startRun('wf-timeout', {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/timed out/i);
  });

  it('completes a step within its timeout', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('OK Timeout')
      .setId('wf-ok-timeout')
      .deterministic('fast', 'Fast Step', { handler: 'fast', timeout: 500 } as Parameters<WorkflowBuilder['deterministic']>[2])
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('fast', async () => 'done');

    const run = await engine.startRun('wf-ok-timeout', {});
    expect(run.status).toBe('completed');
  });
});

// ─── Phase 3C: Retry with Delay ─────────────────────────────

describe('Retry with delay', () => {
  it('retries a failing step and eventually succeeds', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Retry')
      .setId('wf-retry')
      .deterministic('flaky', 'Flaky Step', { handler: 'flaky', retries: 2 } as Parameters<WorkflowBuilder['deterministic']>[2])
      .build();
    await engine.createDefinition(def);
    let calls = 0;
    engine.registerHandler('flaky', async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });

    const run = await engine.startRun('wf-retry', {});
    expect(run.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('fails after exhausting all retries', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Exhaust')
      .setId('wf-exhaust')
      .deterministic('always-fail', 'Always Fail', { handler: 'fail', retries: 2 } as Parameters<WorkflowBuilder['deterministic']>[2])
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('fail', async () => { throw new Error('always fails'); });

    const run = await engine.startRun('wf-exhaust', {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/always fails/);
  });
});

// ─── Phase 3C: Resume with Branch Selection ─────────────────

describe('Resume with branch selection', () => {
  it('resumes a wait step and routes to the specified branch', async () => {
    const engine = new DefaultWorkflowEngine();
    const completed: string[] = [];

    const def = defineWorkflow('Branch Resume')
      .setId('wf-branch')
      .wait('approval', 'Await Approval', { next: 'on-approve' })
      .deterministic('on-approve', 'Approved', { handler: 'approved' })
      .deterministic('on-reject', 'Rejected', { handler: 'rejected' })
      .build();

    // Override next to be an array for branch selection
    const approvalStep = def.steps.find(s => s.id === 'approval')!;
    (approvalStep as { next: string[] }).next = ['on-approve', 'on-reject'];

    await engine.createDefinition(def);
    engine.registerHandler('approved', async () => { completed.push('approved'); });
    engine.registerHandler('rejected', async () => { completed.push('rejected'); });

    const run = await engine.startRun('wf-branch', {});
    expect(run.status).toBe('paused');

    // Resume selecting the 'on-reject' branch explicitly
    const resumed = await engine.resumeRun(run.id, { branch: 'on-reject' });
    expect(resumed.status).toBe('completed');
    expect(completed).toEqual(['rejected']);
  });

  it('falls back to first branch when no selector is provided', async () => {
    const engine = new DefaultWorkflowEngine();
    const completed: string[] = [];

    const def = defineWorkflow('Default Branch')
      .setId('wf-default-branch')
      .wait('gate', 'Gate', { next: 'path-a' })
      .deterministic('path-a', 'Path A', { handler: 'a' })
      .deterministic('path-b', 'Path B', { handler: 'b' })
      .build();

    const gateStep = def.steps.find(s => s.id === 'gate')!;
    (gateStep as { next: string[] }).next = ['path-a', 'path-b'];

    await engine.createDefinition(def);
    engine.registerHandler('a', async () => { completed.push('a'); });
    engine.registerHandler('b', async () => { completed.push('b'); });

    const run = await engine.startRun('wf-default-branch', {});
    const resumed = await engine.resumeRun(run.id); // no data → first branch
    expect(resumed.status).toBe('completed');
    expect(completed).toEqual(['a']);
  });
});

// ─── Phase 3C: Parallel Step ────────────────────────────────

describe('Parallel step execution', () => {
  it('runs all parallel handlers concurrently and collects results', async () => {
    const engine = new DefaultWorkflowEngine();
    const order: string[] = [];

    const def = defineWorkflow('Parallel')
      .setId('wf-parallel')
      .parallel('work', 'Parallel Work', {
        parallelHandlers: ['task-a', 'task-b', 'task-c'],
        next: 'done',
      })
      .deterministic('done', 'Done', { handler: 'done' })
      .build();

    await engine.createDefinition(def);
    engine.registerHandler('task-a', async () => { order.push('a'); return 'result-a'; });
    engine.registerHandler('task-b', async () => { order.push('b'); return 'result-b'; });
    engine.registerHandler('task-c', async () => { order.push('c'); return 'result-c'; });
    engine.registerHandler('done', async () => 'done');

    const run = await engine.startRun('wf-parallel', {});
    expect(run.status).toBe('completed');
    const parallelResult = run.state.history.find(h => h.stepId === 'work');
    expect(parallelResult?.status).toBe('completed');
    const output = parallelResult?.output as { count: number; results: unknown[] };
    expect(output.count).toBe(3);
    expect(output.results).toHaveLength(3);
    expect(output.results).toContain('result-a');
  });

  it('fails if a parallel handler is missing', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Missing Handler')
      .setId('wf-missing-parallel')
      .parallel('work', 'Work', { parallelHandlers: ['missing-handler'] })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun('wf-missing-parallel', {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/missing-handler/);
  });
});

// ─── Phase 3C: Loop Step ─────────────────────────────────────

describe('Loop step execution', () => {
  it('iterates over items and runs body handler for each', async () => {
    const engine = new DefaultWorkflowEngine();
    const processed: unknown[] = [];

    const def = defineWorkflow('Loop')
      .setId('wf-loop')
      .addStep({
        id: 'process-items',
        name: 'Process Items',
        type: 'loop',
        handler: 'get-items',
        config: { bodyHandler: 'process-item' },
      })
      .build();

    await engine.createDefinition(def);
    engine.registerHandler('get-items', async () => [1, 2, 3]);
    engine.registerHandler('process-item', async (vars) => {
      const item = vars['__loopItem'];
      processed.push(item);
      return item;
    });

    const run = await engine.startRun('wf-loop', {});
    expect(run.status).toBe('completed');
    expect(processed).toEqual([1, 2, 3]);
    const loopResult = run.state.history.find(h => h.stepId === 'process-items');
    const out = loopResult?.output as { count: number; results: unknown[] };
    expect(out.count).toBe(3);
  });

  it('returns item count when no body handler is configured', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Count Loop')
      .setId('wf-count-loop')
      .addStep({ id: 'items', name: 'Items', type: 'loop', handler: 'get-items' })
      .build();

    await engine.createDefinition(def);
    engine.registerHandler('get-items', async () => ['x', 'y', 'z']);

    const run = await engine.startRun('wf-count-loop', {});
    expect(run.status).toBe('completed');
    const out = run.state.history[0]?.output as { count: number };
    expect(out.count).toBe(3);
  });
});

// ─── Phase 3C: Checkpoint Recovery ──────────────────────────

describe('Checkpoint recovery (recoverRun)', () => {
  it('returns null when no checkpoint exists', async () => {
    const engine = new DefaultWorkflowEngine();
    const result = await engine.recoverRun('nonexistent-run-id');
    expect(result).toBeNull();
  });

  it('recovers a paused run from checkpoint after simulated restart', async () => {
    const store = new InMemoryCheckpointStore();

    // Engine 1: start and pause
    const engine1 = new DefaultWorkflowEngine({ checkpointStore: store });
    const def = defineWorkflow('Recoverable')
      .setId('wf-recoverable')
      .deterministic('init', 'Init', { handler: 'init' })
      .wait('approval', 'Wait for Approval', { next: 'finish' })
      .deterministic('finish', 'Finish', { handler: 'finish' })
      .build();
    await engine1.createDefinition(def);
    engine1.registerHandler('init', async () => 'initialized');
    engine1.registerHandler('finish', async () => 'done');

    const run1 = await engine1.startRun('wf-recoverable', {});
    expect(run1.status).toBe('paused');
    const runId = run1.id;

    // Verify checkpoint was saved with workflowId
    const cp = await store.latest(runId);
    expect(cp).not.toBeNull();
    expect(cp?.workflowId).toBe('wf-recoverable');

    // Engine 2: simulates process restart — starts fresh, registers definition + handlers
    const engine2 = new DefaultWorkflowEngine({ checkpointStore: store });
    await engine2.createDefinition(def);
    engine2.registerHandler('init', async () => 'initialized');
    engine2.registerHandler('finish', async () => 'done');

    // Recover should restore the paused run and re-execute from checkpoint
    const recovered = await engine2.recoverRun(runId);
    expect(recovered).not.toBeNull();
    // The recovered run should be paused again at the wait step (re-executed to wait)
    expect(recovered?.workflowId).toBe('wf-recoverable');
    expect(['paused', 'completed']).toContain(recovered?.status);
  });

  it('saves workflowId in each checkpoint', async () => {
    const store = new InMemoryCheckpointStore();
    const engine = new DefaultWorkflowEngine({ checkpointStore: store });
    const def = defineWorkflow('WF Check').setId('wf-check')
      .deterministic('s1', 'S1', { handler: 'noop' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('noop', async () => {});

    const run = await engine.startRun('wf-check', {});
    expect(run.status).toBe('completed');

    const checkpoints = await store.list(run.id);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const cp of checkpoints) {
      expect(cp.workflowId).toBe('wf-check');
    }
  });
});

// ─── Phase 3C: Compensation Ordering ────────────────────────

describe('Compensation ordering on failure', () => {
  it('runs compensations in reverse completion order', async () => {
    const engine = new DefaultWorkflowEngine();
    const compensated: string[] = [];

    const def = defineWorkflow('Compensation')
      .setId('wf-comp')
      .deterministic('step-1', 'Step 1', { handler: 's1' })
      .deterministic('step-2', 'Step 2', { handler: 's2' })
      .deterministic('step-3', 'Step 3', { handler: 's3-fail' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('s1', async () => 'ok-1');
    engine.registerHandler('s2', async () => 'ok-2');
    engine.registerHandler('s3-fail', async () => { throw new Error('step 3 failed'); });

    engine.registerCompensation('step-1', 'comp-s1', async () => { compensated.push('comp-step-1'); });
    engine.registerCompensation('step-2', 'comp-s2', async () => { compensated.push('comp-step-2'); });

    const run = await engine.startRun('wf-comp', {});
    expect(run.status).toBe('failed');
    // Compensations should run in reverse (step-2 before step-1)
    expect(compensated).toEqual(['comp-step-2', 'comp-step-1']);
  });

  it('reaches failed terminal state even when compensation fails', async () => {
    const engine = new DefaultWorkflowEngine();
    const def = defineWorkflow('Comp Fail')
      .setId('wf-comp-fail')
      .deterministic('s1', 'S1', { handler: 's1' })
      .deterministic('s2-fail', 'S2 Fail', { handler: 's2-fail' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('s1', async () => 'ok');
    engine.registerHandler('s2-fail', async () => { throw new Error('step 2 died'); });
    engine.registerCompensation('s1', 'comp', async () => { throw new Error('compensation also failed'); });

    const run = await engine.startRun('wf-comp-fail', {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/step 2 died/);
    // Compensation error is recorded in the error message
    expect(run.error).toMatch(/compensation errors/);
  });
});

// ─── Phase 3C: Human-Task Integration ───────────────────────

describe('Human-task workflow integration', () => {
  it('pauses a run at a human-task step and creates a task in the queue', async () => {
    const queue = new InMemoryTaskQueue();
    const engine = new DefaultWorkflowEngine({ humanTaskQueue: queue });

    const def = defineWorkflow('Human Task')
      .setId('wf-human')
      .humanTask('review', 'Review Content', {
        taskType: 'review',
        title: 'Review this content',
        priority: 'high',
        next: 'after-review',
      })
      .deterministic('after-review', 'After Review', { handler: 'after' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('after', async () => 'reviewed');

    const run = await engine.startRun('wf-human', {});
    expect(run.status).toBe('paused');

    // A task should have been created in the queue
    const tasks = await queue.list({ workflowRunId: run.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe('review');
    expect(tasks[0]!.title).toBe('Review this content');
    expect(tasks[0]!.workflowRunId).toBe(run.id);
    expect(tasks[0]!.status).toBe('pending');

    // __humanTaskId should be stored in state
    expect(run.state.variables['__humanTaskId']).toBe(tasks[0]!.id);
  });

  it('completeHumanTask resumes the workflow run', async () => {
    const queue = new InMemoryTaskQueue();
    const engine = new DefaultWorkflowEngine({ humanTaskQueue: queue });

    const def = defineWorkflow('Complete Task')
      .setId('wf-complete-task')
      .humanTask('approve', 'Approve', { next: 'finish' })
      .deterministic('finish', 'Finish', { handler: 'finish' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('finish', async () => 'finished');

    const run = await engine.startRun('wf-complete-task', {});
    expect(run.status).toBe('paused');

    const tasks = await queue.list({ workflowRunId: run.id });
    const taskId = tasks[0]!.id;

    const resumed = await engine.completeHumanTask(taskId, {
      taskId,
      decidedBy: 'alice',
      decision: 'approved',
      decidedAt: new Date().toISOString(),
    });
    expect(resumed?.status).toBe('completed');
    expect(run.state.variables['__humanTaskId']).toBe(taskId);
  });

  it('rejectHumanTask resumes the workflow with rejected decision', async () => {
    const queue = new InMemoryTaskQueue();
    const engine = new DefaultWorkflowEngine({ humanTaskQueue: queue });

    const def = defineWorkflow('Reject Task')
      .setId('wf-reject-task')
      .humanTask('approve', 'Approve', { next: 'finish' })
      .deterministic('finish', 'Finish', { handler: 'finish' })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('finish', async () => 'done after rejection');

    const run = await engine.startRun('wf-reject-task', {});
    const tasks = await queue.list({ workflowRunId: run.id });
    const taskId = tasks[0]!.id;

    const resumed = await engine.rejectHumanTask(taskId, {
      taskId,
      decidedBy: 'bob',
      decision: 'rejected',
      reason: 'not acceptable',
      decidedAt: new Date().toISOString(),
    });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.state.variables['__resumeData']).toMatchObject({ decision: 'rejected' });
  });

  it('throws when completeHumanTask is called without a queue', async () => {
    const engine = new DefaultWorkflowEngine(); // no queue
    await expect(
      engine.completeHumanTask('any-task-id', {
        taskId: 'any-task-id',
        decidedBy: 'x',
        decision: 'approved',
        decidedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('No human task queue configured');
  });
});

// ─── Phase 3C: WorkflowBuilder Shortcuts ────────────────────

describe('WorkflowBuilder Phase 3C shortcuts', () => {
  it('humanTask() adds a human-task step', () => {
    const def = defineWorkflow('HT')
      .humanTask('ht1', 'Human Task 1', { taskType: 'approval', next: 'done' })
      .deterministic('done', 'Done')
      .build();
    const step = def.steps.find(s => s.id === 'ht1');
    expect(step?.type).toBe('human-task');
    expect(step?.config?.['taskType']).toBe('approval');
    expect(step?.next).toBe('done');
  });

  it('parallel() adds a parallel step with parallelHandlers', () => {
    const def = defineWorkflow('Par')
      .parallel('par1', 'Parallel', { parallelHandlers: ['h1', 'h2'], next: 'join' })
      .deterministic('join', 'Join')
      .build();
    const step = def.steps.find(s => s.id === 'par1');
    expect(step?.type).toBe('parallel');
    expect(step?.config?.['parallelHandlers']).toEqual(['h1', 'h2']);
    expect(step?.next).toBe('join');
  });
});

// ─── Phase 3D: Durable Run Repository ──────────────────────

describe('Phase 3D durable workflow state extraction', () => {
  it('persists workflow runs in JsonFileWorkflowRunRepository across engine restarts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wf-runs-'));
    const filePath = join(tempDir, 'runs.json');

    try {
      const repoA = new JsonFileWorkflowRunRepository(filePath);
      const engineA = new DefaultWorkflowEngine({ runRepository: repoA });

      const def = defineWorkflow('Durable Runs')
        .setId('wf-durable-runs')
        .deterministic('step-1', 'Step 1', { handler: 'noop' })
        .build();

      await engineA.createDefinition(def);
      engineA.registerHandler('noop', async () => 'ok');

      const run = await engineA.startRun('wf-durable-runs', { key: 'value' });
      expect(run.status).toBe('completed');

      // Simulate process restart with a fresh engine+repository instance.
      const repoB = new JsonFileWorkflowRunRepository(filePath);
      const engineB = new DefaultWorkflowEngine({ runRepository: repoB });

      const loaded = await engineB.getRun(run.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.workflowId).toBe('wf-durable-runs');
      expect(loaded?.status).toBe('completed');

      const listed = engineB.listRuns('wf-durable-runs');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(run.id);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

