/**
 * @weaveintel/workflows — Phase W7 tests
 * Dynamic graph expansion: definition snapshot isolation, dynamic step
 * execution, sub-graph splice, restart-safety, governance rejection, and
 * stub planner resolver.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultWorkflowEngine,
  defineWorkflow,
  HandlerResolverRegistry,
  createNoopResolver,
  InMemoryWorkflowRunRepository,
  InMemoryCheckpointStore,
  type WorkflowEngineOptions,
} from './index.js';
import type { WorkflowDefinition, WorkflowRun, WorkflowPolicy } from '@weaveintel/core';
import type { DynamicExpansion } from '@weaveintel/core';
import { WorkflowExpansionError } from './expansion-error.js';

// ─── Shared helpers ────────────────────────────────────────────────────────

function makeEngine(opts: WorkflowEngineOptions = {}): DefaultWorkflowEngine {
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  return new DefaultWorkflowEngine({ resolverRegistry: reg, ...opts });
}

/** Two-step workflow: step A → step B (terminal). */
function twoStepDef(id = 'wf-snap-test'): WorkflowDefinition {
  return {
    id,
    name: 'Two Step',
    version: '1.0.0',
    entryStepId: 'a',
    steps: [
      { id: 'a', name: 'A', type: 'deterministic', handler: 'noop', next: 'b' },
      { id: 'b', name: 'B', type: 'deterministic', handler: 'noop' },
    ],
  };
}

// ─── Phase W7.P1 — Definition snapshot isolation ───────────────────────────

describe('Phase W7.P1 — definition snapshot isolation', () => {
  it('run.definitionSnapshot is set after startRun', async () => {
    const engine = makeEngine();
    const def = twoStepDef('wf-snap');
    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.definitionSnapshot).toBeDefined();
    expect(run.definitionSnapshot!.id).toBe(def.id);
    expect(run.definitionSnapshot!.steps).toHaveLength(2);
  });

  it('editing the live definition after startRun does NOT affect an in-flight run', async () => {
    const runRepo = new InMemoryWorkflowRunRepository();
    const cpStore = new InMemoryCheckpointStore();
    const engine = makeEngine({ runRepository: runRepo, checkpointStore: cpStore });

    // Use a pausing step so the run stays in-flight
    const def: WorkflowDefinition = {
      id: 'wf-snapshot-isolation',
      name: 'Snapshot Isolation',
      version: '1.0.0',
      entryStepId: 'step-a',
      steps: [
        { id: 'step-a', name: 'A', type: 'wait', next: 'step-b' },
        { id: 'step-b', name: 'B', type: 'deterministic', handler: 'noop' },
      ],
    };
    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    expect(run.status).toBe('paused'); // paused on step-a (wait)

    // Mutate the live definition: add a new step and change step-b's handler
    const mutated: WorkflowDefinition = {
      ...def,
      steps: [
        { id: 'step-a', name: 'A', type: 'wait', next: 'step-b' },
        { id: 'step-b', name: 'B (mutated)', type: 'deterministic', handler: 'nonexistent-handler' },
        { id: 'step-c', name: 'C (injected)', type: 'deterministic', handler: 'noop' },
      ],
    };
    await engine.createDefinition(mutated); // overwrites the in-memory definition

    // Resume — snapshot says step-b uses 'noop', so it should succeed
    const resumed = await engine.resumeRun(run.id);
    // The run used the snapshot (step-b = noop), not the mutated live def
    expect(resumed.status).toBe('completed');
    expect(resumed.error).toBeUndefined();
    // The snapshot stored on the run must be the original definition
    expect(resumed.definitionSnapshot!.steps).toHaveLength(2);
  });

  it('definitionSnapshot is independent (deep clone — mutations do not bleed through)', async () => {
    const engine = makeEngine();
    const def = twoStepDef('wf-clone-check');
    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    // Mutate the original object (in-memory reference) after startRun
    (def as { name: string }).name = 'MUTATED';
    (def.steps[0] as { name: string }).name = 'MUTATED_STEP';

    // The snapshot must be independent
    expect(run.definitionSnapshot!.name).not.toBe('MUTATED');
    expect(run.definitionSnapshot!.steps[0]!.name).not.toBe('MUTATED_STEP');
  });
});

// ─── Phase W7.P2 — dynamic step + sub-graph splice ─────────────────────────

describe('Phase W7.P2 — dynamic step expands and executes a sub-graph', () => {
  it('dynamic step handler returns DynamicExpansion; sub-graph runs; control rejoins', async () => {
    const engine = makeEngine();

    let dynamicHandlerCalled = false;
    let subHandlerCalled = false;
    let finalHandlerCalled = false;

    // The dynamic handler returns an expansion containing one sub-step
    engine.registerHandler('plan-handler', async () => {
      dynamicHandlerCalled = true;
      const expansion: DynamicExpansion = {
        steps: [{ id: 'gen-step-1', name: 'Generated Step 1', type: 'deterministic', handler: 'sub-handler' }],
        entry: 'gen-step-1',
        rejoin: 'final',
      };
      return expansion;
    });

    engine.registerHandler('sub-handler', async () => {
      subHandlerCalled = true;
      return { generatedResult: 42 };
    });

    engine.registerHandler('final-handler', async () => {
      finalHandlerCalled = true;
      return { done: true };
    });

    const def = defineWorkflow('Dynamic Test')
      .setId('wf-dynamic-basic')
      .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'plan-handler', next: 'final' })
      .addStep({ id: 'final', name: 'Final', type: 'deterministic', handler: 'final-handler' })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    expect(run.status).toBe('completed');
    expect(dynamicHandlerCalled).toBe(true);
    expect(subHandlerCalled).toBe(true);
    expect(finalHandlerCalled).toBe(true);

    // generated step output should be in state variables
    expect((run.state.variables['__step_gen-step-1'] as Record<string, unknown>)?.['generatedResult']).toBe(42);
    // dynamic step itself should be in history
    const planResult = run.state.history.find(h => h.stepId === 'plan');
    expect(planResult?.status).toBe('completed');
  });

  it('dynamic step with no rejoin uses step.next', async () => {
    const engine = makeEngine();
    let joinCalled = false;

    engine.registerHandler('dynamic-h', async () => {
      const expansion: DynamicExpansion = {
        steps: [{ id: 'g1', name: 'G1', type: 'deterministic', handler: 'noop' }],
        entry: 'g1',
        // rejoin omitted — should fall back to plan.next = 'after'
      };
      return expansion;
    });

    engine.registerHandler('after-h', async () => { joinCalled = true; return null; });

    const def = defineWorkflow('No Rejoin')
      .setId('wf-no-rejoin')
      .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'dynamic-h', next: 'after' })
      .addStep({ id: 'after', name: 'After', type: 'deterministic', handler: 'after-h' })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    expect(run.status).toBe('completed');
    expect(joinCalled).toBe(true);
  });

  it('dynamicSteps and expansionDepth are persisted on the run', async () => {
    const runRepo = new InMemoryWorkflowRunRepository();
    const engine = makeEngine({ runRepository: runRepo });

    engine.registerHandler('expand-h', async () => {
      const exp: DynamicExpansion = {
        steps: [{ id: 'g-persist', name: 'G Persist', type: 'deterministic', handler: 'noop' }],
        entry: 'g-persist',
      };
      return exp;
    });

    const def = defineWorkflow('Persist Test')
      .setId('wf-persist-dynamic')
      .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'expand-h' })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('completed');

    // Both the in-memory run and the persisted run should have dynamicSteps
    const persisted = await runRepo.get(run.id);
    expect(persisted?.dynamicSteps).toBeDefined();
    expect(persisted?.dynamicSteps?.some(s => s.id === 'g-persist')).toBe(true);
    expect(persisted?.expansionDepth).toBe(1);
  });
});

// ─── Phase W7.P2 — restart-safety ──────────────────────────────────────────

describe('Phase W7.P2 — restart-safety: crash mid-sub-graph resumes correctly', () => {
  it('re-instantiating the engine from the run repo resumes without re-running completed sub-steps', async () => {
    const runRepo = new InMemoryWorkflowRunRepository();
    const cpStore = new InMemoryCheckpointStore();

    let subCallCount = 0;

    function buildEngine() {
      const reg = new HandlerResolverRegistry();
      reg.register(createNoopResolver());
      const e = new DefaultWorkflowEngine({ runRepository: runRepo, checkpointStore: cpStore, resolverRegistry: reg });

      e.registerHandler('expand-h', async () => {
        const exp: DynamicExpansion = {
          steps: [
            { id: 'g-sub-1', name: 'G Sub 1', type: 'deterministic', handler: 'sub1-h' },
            { id: 'g-sub-2', name: 'G Sub 2', type: 'wait', next: 'rejoiner' },
          ],
          entry: 'g-sub-1',
          rejoin: 'rejoiner',
        };
        return exp;
      });
      e.registerHandler('sub1-h', async () => { subCallCount++; return { ran: true }; });
      e.registerHandler('rejoiner-h', async () => ({ done: true }));
      return e;
    }

    const def: WorkflowDefinition = {
      id: 'wf-restart',
      name: 'Restart Safety',
      version: '1.0.0',
      entryStepId: 'plan',
      steps: [
        { id: 'plan', name: 'Plan', type: 'dynamic', handler: 'expand-h', next: 'rejoiner' },
        { id: 'rejoiner', name: 'Rejoiner', type: 'deterministic', handler: 'rejoiner-h' },
      ],
    };

    const engine1 = buildEngine();
    await engine1.createDefinition(def);
    // Run until it pauses at g-sub-2 (wait step)
    const paused = await engine1.startRun(def.id);
    expect(paused.status).toBe('paused');
    expect(subCallCount).toBe(1); // sub1-h ran once

    // Simulate process restart — new engine instance, same stores
    const engine2 = buildEngine();
    await engine2.createDefinition(def); // re-register definition

    // Resume from the paused run — it should NOT re-run g-sub-1
    const resumed = await engine2.resumeRun(paused.id);
    expect(resumed.status).toBe('completed');
    // sub1-h ran exactly once across both engine instances
    expect(subCallCount).toBe(1);
  });
});

// ─── Phase W7.P3 — governance rejections ───────────────────────────────────

describe('Phase W7.P3 — governance: validateExpansion rejects bad graphs', () => {
  function makeGovernedEngine(policy?: WorkflowPolicy) {
    const reg = new HandlerResolverRegistry();
    reg.register(createNoopResolver());
    return new DefaultWorkflowEngine({
      resolverRegistry: reg,
      defaultPolicy: policy,
    });
  }

  it('rejects duplicate step ID (id collision)', async () => {
    const engine = makeGovernedEngine();

    engine.registerHandler('bad-expand', async () => {
      const exp: DynamicExpansion = {
        // 'existing-step' already exists in the workflow definition
        steps: [{ id: 'existing-step', name: 'Duplicate', type: 'deterministic', handler: 'noop' }],
        entry: 'existing-step',
      };
      return exp;
    });

    const def: WorkflowDefinition = {
      id: 'wf-dup-id',
      name: 'Dup ID',
      version: '1.0.0',
      entryStepId: 'existing-step',
      steps: [
        { id: 'existing-step', name: 'Exists', type: 'dynamic', handler: 'bad-expand' },
      ],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/WorkflowExpansionError|collision|duplicate|id/i);
  });

  it('rejects disallowed handler kind (script) in generated steps', async () => {
    const engine = makeGovernedEngine({
      dynamicHandlerKinds: ['noop', 'tool'], // script NOT allowed
    });

    engine.registerHandler('illegal-expand', async () => {
      const exp: DynamicExpansion = {
        steps: [{ id: 'g-script', name: 'Script Step', type: 'deterministic', handler: 'script:return 1' }],
        entry: 'g-script',
      };
      return exp;
    });

    const def: WorkflowDefinition = {
      id: 'wf-disallowed-kind',
      name: 'Disallowed Kind',
      version: '1.0.0',
      entryStepId: 'dyn',
      steps: [{ id: 'dyn', name: 'Dyn', type: 'dynamic', handler: 'illegal-expand' }],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/WorkflowExpansionError|disallowed|handler kind|script/i);
  });

  it('rejects when maxGeneratedSteps budget is exceeded', async () => {
    const engine = makeGovernedEngine({ maxGeneratedSteps: 1 });

    engine.registerHandler('too-many-expand', async () => {
      const exp: DynamicExpansion = {
        steps: [
          { id: 'g-s1', name: 'G1', type: 'deterministic', handler: 'noop' },
          { id: 'g-s2', name: 'G2', type: 'deterministic', handler: 'noop', next: 'rejoiner' },
        ],
        entry: 'g-s1',
      };
      return exp;
    });

    const def: WorkflowDefinition = {
      id: 'wf-too-many-steps',
      name: 'Too Many Steps',
      version: '1.0.0',
      entryStepId: 'dyn',
      steps: [
        { id: 'dyn', name: 'Dyn', type: 'dynamic', handler: 'too-many-expand', next: 'rejoiner' },
        { id: 'rejoiner', name: 'Rejoiner', type: 'deterministic', handler: 'noop' },
      ],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/WorkflowExpansionError|maxGeneratedSteps|budget/i);
  });

  it('rejects when maxExpansionDepth is exceeded', async () => {
    const engine = makeGovernedEngine({ maxExpansionDepth: 0 });

    engine.registerHandler('depth-expand', async () => {
      const exp: DynamicExpansion = {
        steps: [{ id: 'g-depth-1', name: 'G Depth', type: 'deterministic', handler: 'noop' }],
        entry: 'g-depth-1',
      };
      return exp;
    });

    const def: WorkflowDefinition = {
      id: 'wf-depth-limit',
      name: 'Depth Limit',
      version: '1.0.0',
      entryStepId: 'dyn',
      steps: [{ id: 'dyn', name: 'Dyn', type: 'dynamic', handler: 'depth-expand' }],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/WorkflowExpansionError|maxExpansionDepth|depth/i);
  });

  it('rejects expansion with a broken entry reference', async () => {
    const engine = makeGovernedEngine();

    engine.registerHandler('broken-entry-expand', async () => {
      const exp: DynamicExpansion = {
        steps: [{ id: 'g-real', name: 'Real', type: 'deterministic', handler: 'noop' }],
        entry: 'g-nonexistent', // not in expansion.steps
      };
      return exp;
    });

    const def: WorkflowDefinition = {
      id: 'wf-broken-entry',
      name: 'Broken Entry',
      version: '1.0.0',
      entryStepId: 'dyn',
      steps: [{ id: 'dyn', name: 'Dyn', type: 'dynamic', handler: 'broken-entry-expand' }],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/WorkflowExpansionError|entry|not found/i);
  });
});

// ─── Phase W7.P4 — stub planner resolver ───────────────────────────────────

describe('Phase W7.P4 — stub planner resolver produces a validated expansion', () => {
  it('planner resolver wraps plan() output in __expansion and executes it', async () => {
    // Import the planner resolver factory
    const { createPlannerResolver } = await import('./resolvers.js');

    let planCalled = false;
    const plannerDeps = {
      plan: async (_goal: string): Promise<DynamicExpansion> => {
        planCalled = true;
        return {
          steps: [{ id: 'planner-gen-1', name: 'Planner Gen', type: 'deterministic', handler: 'noop' }],
          entry: 'planner-gen-1',
        };
      },
    };

    const reg = new HandlerResolverRegistry();
    reg.register(createNoopResolver());
    reg.register(createPlannerResolver(plannerDeps));

    const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });

    const def: WorkflowDefinition = {
      id: 'wf-planner-resolver',
      name: 'Planner Resolver',
      version: '1.0.0',
      entryStepId: 'plan-step',
      steps: [
        {
          id: 'plan-step',
          name: 'AI Plan',
          type: 'dynamic',
          handler: 'plan:generate-the-subgraph',
          config: { goal: 'process the data' },
        },
      ],
    };

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id, { topic: 'test' });

    expect(run.status).toBe('completed');
    expect(planCalled).toBe(true);
    // generated step should appear in dynamic steps and state history
    expect(run.dynamicSteps?.some(s => s.id === 'planner-gen-1')).toBe(true);
  });
});

// ─── WorkflowExpansionError export ─────────────────────────────────────────

describe('WorkflowExpansionError', () => {
  it('is a proper Error subclass with structured fields', () => {
    const err = new WorkflowExpansionError('ID_COLLISION', 'step "foo" already exists');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkflowExpansionError);
    expect(err.code).toBe('ID_COLLISION');
    expect(err.message).toContain('step "foo" already exists');
    expect(err.name).toBe('WorkflowExpansionError');
  });
});
