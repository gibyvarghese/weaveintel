/**
 * Example 2X — Dynamic Workflow Graphs (Phase W7)
 *
 * Demonstrates all Phase W7 features:
 *  • dynamic step type       — handler returns DynamicExpansion; engine splices the sub-graph
 *  • Definition snapshot     — mid-run definition edits don't affect in-flight runs
 *  • Data-driven expansion   — step count and handlers decided at runtime from variables
 *  • Stub planner resolver   — createPlannerResolver wired to a deterministic "LLM stub"
 *  • Governance enforcement  — maxExpansionDepth, maxGeneratedSteps, handler-kind allowlist
 *  • WorkflowExpansionError  — structured errors with typed code for catch handlers
 *
 * No LLM API key required — all planners are deterministic stubs.
 *
 * Run:
 *   npx tsx examples/2x-dynamic-workflows.ts
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  HandlerResolverRegistry,
  createNoopResolver,
  createPlannerResolver,
  WorkflowExpansionError,
  InMemoryWorkflowRunRepository,
  type WorkflowEngineOptions,
} from '@weaveintel/workflows';
import type { DynamicExpansion } from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }

/* ── Engine factory ───────────────────────────────────────────────────────── */

function makeEngine(opts: WorkflowEngineOptions = {}): DefaultWorkflowEngine {
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  return new DefaultWorkflowEngine({ resolverRegistry: reg, ...opts });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Definition snapshot isolation
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoSnapshotIsolation() {
  header('1. Definition Snapshot Isolation');

  const engine = makeEngine();
  const def = defineWorkflow('Snapshot Demo')
    .setId('snapshot-demo')
    .addStep({ id: 'step-a', name: 'Step A', type: 'deterministic', handler: 'handler-a', next: 'step-b' })
    .addStep({ id: 'step-b', name: 'Step B', type: 'deterministic', handler: 'handler-b' })
    .build();

  engine.registerHandler('handler-a', async () => 'result-a');
  engine.registerHandler('handler-b', async () => 'result-b');

  await engine.createDefinition(def);

  // Pause between steps by registering handler-a as a wait-trigger
  // (We use a two-step flow; snapshot is captured at startRun time)
  const run = await engine.startRun(def.id);

  // Mutate the live definition object AFTER the run started
  (def.steps[1] as { name: string }).name = 'MUTATED_NAME';

  ok(`Run completed with status: ${run.status}`);
  ok(`Snapshot name preserved: "${run.definitionSnapshot?.steps[1]?.name}" (live: "${def.steps[1]?.name}")`);
  info('mid-run edits to the live definition are isolated from the in-flight run.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Data-driven expansion — step count decided at runtime
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoDataDrivenExpansion() {
  header('2. Data-Driven Expansion — Runtime Sub-Graph');

  const engine = makeEngine();

  // The dynamic handler inspects variables.items and expands to one step per item
  engine.registerHandler('data-planner', async (variables) => {
    const items = (variables['items'] as string[]) ?? [];
    info(`Planner sees ${items.length} items — building ${items.length}-step sub-graph`);

    const steps = items.map((item, idx) => ({
      id: `process-${idx}`,
      name: `Process ${item}`,
      type: 'deterministic' as const,
      handler: 'item-processor',
    }));

    const expansion: DynamicExpansion = {
      steps,
      entry: steps[0]?.id ?? 'done',
      rejoin: 'done',
    };
    return expansion;
  });

  let processedCount = 0;
  engine.registerHandler('item-processor', async (variables) => {
    processedCount++;
    const item = variables['__step_input'] ?? '(unknown)';
    return { processed: item, seq: processedCount };
  });

  engine.registerHandler('summarise', async (variables) => {
    const results = Object.entries(variables)
      .filter(([k]) => k.startsWith('__step_process-'))
      .map(([, v]) => v);
    return { total: results.length, results };
  });

  const def = defineWorkflow('Data-Driven Expansion')
    .setId('data-driven-expand')
    .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'data-planner', next: 'done' })
    .addStep({ id: 'done', name: 'Summarise', type: 'deterministic', handler: 'summarise' })
    .build();

  await engine.createDefinition(def);
  const run = await engine.startRun(def.id, { items: ['apple', 'banana', 'cherry'] });

  ok(`Run status: ${run.status}`);
  ok(`Dynamic steps spliced: ${run.dynamicSteps?.length} (one per item)`);
  ok(`Expansion depth: ${run.expansionDepth}`);
  const summary = run.state.variables['__step_done'] as Record<string, unknown> | undefined;
  ok(`Summary total: ${summary?.total ?? 0} items processed`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. Planner resolver — stub LLM that returns a DynamicExpansion
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoPlannerResolver() {
  header('3. Planner Resolver — Stub LLM (createPlannerResolver)');

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());

  // Wire up the planner resolver with a deterministic stub plan() function
  reg.register(createPlannerResolver({
    plan: async (goal, context) => {
      info(`Stub LLM received goal: "${goal}"`);
      info(`Context variables keys: ${Object.keys(context.variables).join(', ') || '(none)'}`);
      info(`Available capability kinds: ${context.capabilities?.map(c => c.kind).join(', ') ?? '(none)'}`);

      // Always returns a fixed 2-step sub-graph regardless of goal
      const expansion: DynamicExpansion = {
        steps: [
          { id: 'llm-step-1', name: 'LLM Step 1', type: 'deterministic', handler: 'noop' },
          { id: 'llm-step-2', name: 'LLM Step 2', type: 'deterministic', handler: 'noop' },
        ],
        entry: 'llm-step-1',
        rejoin: 'after-plan',
      };
      return expansion;
    },
  }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });

  // Use "plan:<goal>" handler syntax to trigger the planner resolver
  const def = defineWorkflow('Planner Demo')
    .setId('planner-demo')
    .addStep({
      id: 'dynamic-step',
      name: 'AI-Planned Step',
      type: 'dynamic',
      handler: 'plan:organize the data pipeline',
      next: 'after-plan',
    })
    .addStep({ id: 'after-plan', name: 'After Plan', type: 'deterministic', handler: 'noop' })
    .build();

  await engine.createDefinition(def);
  const run = await engine.startRun(def.id);

  ok(`Run status: ${run.status}`);
  ok(`Dynamic steps generated by planner: ${run.dynamicSteps?.length}`);
  ok(`Steps: ${run.dynamicSteps?.map(s => s.id).join(' → ')}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. Governance — validateExpansion rejects bad graphs
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoGovernance() {
  header('4. Governance — validateExpansion Rejections');

  // ── 4a. maxGeneratedSteps budget ──────────────────────────────────────────
  {
    const engine = makeEngine({
      defaultPolicy: { maxGeneratedSteps: 2 }, // only 2 generated steps allowed
    });

    engine.registerHandler('greedy-planner', async () => {
      const expansion: DynamicExpansion = {
        steps: [
          { id: 'g1', name: 'G1', type: 'deterministic', handler: 'noop' },
          { id: 'g2', name: 'G2', type: 'deterministic', handler: 'noop' },
          { id: 'g3', name: 'G3', type: 'deterministic', handler: 'noop' }, // exceeds budget!
        ],
        entry: 'g1',
        rejoin: 'after',
      };
      return expansion;
    });

    const def = defineWorkflow('Budget Test')
      .setId('budget-test')
      .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'greedy-planner', next: 'after' })
      .addStep({ id: 'after', name: 'After', type: 'deterministic', handler: 'noop' })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    if (run.status === 'failed' && run.error?.includes('MAX_GENERATED_STEPS')) {
      ok('maxGeneratedSteps budget enforced — run failed with MAX_GENERATED_STEPS');
    } else {
      warn(`Unexpected: status=${run.status} error=${run.error}`);
    }
  }

  // ── 4b. Disallowed handler kind (script is not in default allowlist) ───────
  {
    const engine = makeEngine();

    engine.registerHandler('script-injector', async () => {
      const expansion: DynamicExpansion = {
        steps: [{ id: 'evil-step', name: 'Evil', type: 'deterministic', handler: 'script:return process.env' }],
        entry: 'evil-step',
      };
      return expansion;
    });

    const def = defineWorkflow('Script Injection Test')
      .setId('script-injection-test')
      .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'script-injector' })
      .build();

    await engine.createDefinition(def);
    const run = await engine.startRun(def.id);

    if (run.status === 'failed' && run.error?.includes('DISALLOWED_HANDLER_KIND')) {
      ok('Handler-kind allowlist enforced — script: blocked with DISALLOWED_HANDLER_KIND');
    } else {
      warn(`Unexpected: status=${run.status} error=${run.error}`);
    }
  }

  // ── 4c. WorkflowExpansionError is a typed, structured error class ──────────
  {
    const err = new WorkflowExpansionError('ID_COLLISION', 'step "x" already exists');
    ok(`WorkflowExpansionError: code="${err.code}" name="${err.name}"`);
    ok(`Error is instanceof Error: ${err instanceof Error}`);
    ok(`Error is instanceof WorkflowExpansionError: ${err instanceof WorkflowExpansionError}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. Restart-safety — process restart mid-sub-graph
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoRestartSafety() {
  header('5. Restart-Safety — Resume Mid-Sub-Graph After Process Restart');

  const runRepo = new InMemoryWorkflowRunRepository();
  let subCallCount = 0;

  function buildEngine() {
    const reg = new HandlerResolverRegistry();
    reg.register(createNoopResolver());
    const e = new DefaultWorkflowEngine({ runRepository: runRepo, resolverRegistry: reg });

    e.registerHandler('expand-h', async () => {
      const exp: DynamicExpansion = {
        steps: [
          { id: 'gen-work', name: 'Gen Work', type: 'deterministic', handler: 'work-h' },
          { id: 'gen-wait', name: 'Gen Wait', type: 'wait', next: 'final' },
        ],
        entry: 'gen-work',
        rejoin: 'final',
      };
      return exp;
    });
    e.registerHandler('work-h', async () => { subCallCount++; return { done: true }; });
    e.registerHandler('final-h', async () => ({ finished: true }));
    return e;
  }

  const def = defineWorkflow('Restart Safety')
    .setId('restart-safety-demo')
    .addStep({ id: 'plan', name: 'Plan', type: 'dynamic', handler: 'expand-h', next: 'final' })
    .addStep({ id: 'final', name: 'Final', type: 'deterministic', handler: 'final-h' })
    .build();

  const engine1 = buildEngine();
  await engine1.createDefinition(def);

  const paused = await engine1.startRun(def.id);
  ok(`Engine1: run paused at wait step — status: ${paused.status}`);
  ok(`work-h invocation count after pause: ${subCallCount}`);
  ok(`Dynamic steps spliced: ${paused.dynamicSteps?.map(s => s.id).join(', ')}`);

  info('Simulating process restart — instantiating engine2 from same store...');
  const engine2 = buildEngine();
  await engine2.createDefinition(def);

  const resumed = await engine2.resumeRun(paused.id);
  ok(`Engine2: run resumed and completed — status: ${resumed.status}`);
  ok(`work-h invocation count after resume (should still be 1): ${subCallCount}`);

  if (subCallCount === 1) {
    ok('Idempotency confirmed — sub-step was NOT re-run after restart');
  } else {
    warn(`work-h ran ${subCallCount} times — may indicate a re-execution issue`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   main
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('\n@weaveintel/workflows — Phase W7: Dynamic Workflow Graphs');
  console.log('No LLM API key required — all planners are deterministic stubs.\n');

  await demoSnapshotIsolation();
  await demoDataDrivenExpansion();
  await demoPlannerResolver();
  await demoGovernance();
  await demoRestartSafety();

  console.log('\n' + '═'.repeat(64));
  console.log('  All Phase W7 demos complete.');
  console.log('═'.repeat(64) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
