/**
 * Example 15 — Workflow Control Flow (Phase W1)
 *
 * Demonstrates all Phase W1 control-flow features:
 *  • switch       — multi-case routing by string key (config.cases)
 *  • forEach      — iterate with max-concurrency + early break via { __break: true }
 *  • parallelLanes — named concurrent handlers → Record<name, output> results
 *  • fork / join  — fire independent paths concurrently, aggregate at join
 *  • onError      — per-step error boundary: redirects to handler step on failure
 *  • skipIf       — skip a step when a JSONLogic expression is truthy
 *  • JsonFileCheckpointStore / JsonFileWorkflowDefinitionStore — file-backed persistence
 *
 * Also shows an agent using a "run_workflow" tool to trigger a workflow run,
 * demonstrating end-to-end integration between the agents and workflow packages.
 * The agent section falls back to a direct tool invocation when no API key is set.
 *
 * Run:
 *   npx tsx examples/15-workflow-control-flow.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/15-workflow-control-flow.ts
 *
 * WeaveIntel packages used:
 *   @weaveintel/workflows — DefaultWorkflowEngine, defineWorkflow, JsonFileCheckpointStore,
 *                           JsonFileWorkflowRunRepository, JsonFileWorkflowDefinitionStore
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  JsonFileCheckpointStore,
  JsonFileWorkflowRunRepository,
  JsonFileWorkflowDefinitionStore,
} from '@weaveintel/workflows';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }

/* ── File persistence paths (temp dir, cleaned up at end) ─ */

const WORK_DIR = join(tmpdir(), `weaveintel-w1-${Date.now()}`);
const DEFS_FILE = join(WORK_DIR, 'workflow-defs.json');
const RUNS_FILE = join(WORK_DIR, 'workflow-runs.json');
const CHECKPOINTS_FILE = join(WORK_DIR, 'workflow-checkpoints.json');

async function main() {

/* ─────────────────────────────────────────────────────────
   1. Build the order-processing workflow (all W1 features)
   ───────────────────────────────────────────────────────── */

header('1. Order Processing Workflow — definition (all W1 step types)');

const def = defineWorkflow('Order Processing')
  .setId('order-processing-v1')
  .setDescription('Demonstrates Phase W1 control flow: switch, forEach, parallelLanes, fork/join, onError, skipIf')
  .setPolicy({ maxSteps: 40, costCeiling: 5 })

  // ── Entry: validate order ──────────────────────────────
  .addStep({
    id: 'validate-order',
    name: 'Validate Order',
    type: 'deterministic',
    handler: 'validate-order',
    next: 'classify-order',
    onError: 'handle-validation-error',  // Phase W1: jump here on failure
  })

  // ── SWITCH: route by order type ────────────────────────
  .switch('classify-order', 'Classify Order Type', {
    handler: 'classify-order',
    cases: {
      digital:      'fulfill-digital',
      physical:     'fulfill-physical',
      subscription: 'setup-subscription',
      default:      'flag-unknown-type',
    },
  })

  // ── Switch branches (all converge to quality-checks) ──
  .addStep({ id: 'fulfill-digital',    name: 'Fulfill Digital Order',       type: 'deterministic', handler: 'fulfill-digital',    next: 'quality-checks' })
  .addStep({ id: 'fulfill-physical',   name: 'Fulfill Physical Order',      type: 'deterministic', handler: 'fulfill-physical',   next: 'quality-checks' })
  .addStep({ id: 'setup-subscription', name: 'Setup Subscription',          type: 'deterministic', handler: 'setup-subscription', next: 'quality-checks' })
  .addStep({ id: 'flag-unknown-type',  name: 'Flag Unknown Order Type',     type: 'deterministic', handler: 'flag-unknown-type',  next: 'quality-checks' })

  // ── PARALLEL LANES: run three checks concurrently ─────
  .parallelLanes('quality-checks', 'Quality Checks', {
    lanes: {
      fraud:     'check-fraud',
      inventory: 'check-inventory',
      credit:    'check-credit',
    },
    next: 'fork-analysis',
  })

  // ── FORK: fire two analysis paths concurrently ─────────
  .fork('fork-analysis', 'Fork: Price + Shipping Analysis', {
    branches: {
      pricing:  'analyze-pricing',
      shipping: 'calculate-shipping',
    },
    next: 'join-analysis',
  })

  // ── JOIN: aggregate fork results ───────────────────────
  .join('join-analysis', 'Join Analysis Results', {
    forkStepId: 'fork-analysis',
    next: 'process-items',
  })

  // ── FOREACH: process order items with max-concurrency ─
  .forEach('process-items', 'Process Order Items', {
    handler: 'get-order-items',
    bodyHandler: 'process-item',
    maxConcurrency: 2,
    next: 'send-confirmation',
  })

  // ── SKIPIF: skip notification when suppressed ──────────
  .addStep({
    id: 'send-confirmation',
    name: 'Send Confirmation Email',
    type: 'deterministic',
    handler: 'send-confirmation',
    next: 'complete-order',
    skipIf: { '==': [{ var: 'order.suppressEmail' }, true] },  // Phase W1
  })

  // ── Terminal step ─────────────────────────────────────
  .addStep({ id: 'complete-order', name: 'Complete Order', type: 'deterministic', handler: 'complete-order' })

  // ── OnError target (reached when validate-order fails) ─
  .addStep({ id: 'handle-validation-error', name: 'Handle Validation Error', type: 'deterministic', handler: 'handle-validation-error' })

  .build();

info(`Workflow ID: ${def.id}`);
info(`Steps: ${def.steps.map(s => s.id).join(', ')}`);

/* ─────────────────────────────────────────────────────────
   2. Engine setup with file-backed persistence
   ───────────────────────────────────────────────────────── */

header('2. Engine Setup — file-backed stores (JsonFile)');

const checkpointStore  = new JsonFileCheckpointStore(CHECKPOINTS_FILE);
const runRepository    = new JsonFileWorkflowRunRepository(RUNS_FILE);
const definitionStore  = new JsonFileWorkflowDefinitionStore(DEFS_FILE);

// Persist the definition to file so it survives restarts
await definitionStore.save(def);
ok(`Definition saved to ${DEFS_FILE}`);

const engine = new DefaultWorkflowEngine({ checkpointStore, runRepository, definitionStore });
await engine.createDefinition(def);

// Register all step handlers
const handlers: Record<string, (vars: Record<string, unknown>) => Promise<unknown>> = {
  'validate-order': async (vars) => {
    const order = vars['order'] as Record<string, unknown> | undefined;
    if (!order) throw new Error('Missing order in input');
    if (!order['id']) throw new Error('Order must have an id');
    return { valid: true, orderId: order['id'] };
  },

  'classify-order': async (vars) => {
    const order = vars['order'] as Record<string, unknown>;
    return (order['type'] as string) ?? 'unknown';
  },

  'fulfill-digital':    async () => ({ status: 'digital license issued' }),
  'fulfill-physical':   async () => ({ status: 'warehouse pick queued' }),
  'setup-subscription': async () => ({ status: 'subscription activated' }),
  'flag-unknown-type':  async (vars) => {
    const order = vars['order'] as Record<string, unknown>;
    return { warning: `Unknown order type: ${order['type']}` };
  },

  // Parallel lane handlers
  'check-fraud':     async () => ({ fraudScore: 0.02, passed: true }),
  'check-inventory': async () => ({ available: true, reservedQty: 1 }),
  'check-credit':    async () => ({ creditScore: 780, approved: true }),

  // Fork branch handlers
  'analyze-pricing':    async () => ({ basePrice: 49.99, discount: 5.00, finalPrice: 44.99 }),
  'calculate-shipping': async () => ({ carrier: 'FedEx', estimatedDays: 2, cost: 7.99 }),

  // forEach handlers
  'get-order-items': async (vars) => {
    const order = vars['order'] as Record<string, unknown>;
    return (order['items'] as unknown[]) ?? ['item-A', 'item-B', 'item-C'];
  },
  'process-item': async (vars) => {
    const item = vars['__forEachItem'];
    const idx  = vars['__forEachIndex'] as number;
    // Break early on item-C to demo { __break: true }
    if (item === 'item-C') return { __break: true };
    return { item, index: idx, processed: true };
  },

  'send-confirmation':       async () => ({ emailSent: true, timestamp: new Date().toISOString() }),
  'complete-order':          async (vars) => ({ orderId: (vars['order'] as Record<string, unknown>)?.['id'], completedAt: new Date().toISOString() }),
  'handle-validation-error': async (vars) => {
    const err = vars['__error'] as Record<string, unknown> | undefined;
    return { handled: true, originalError: err?.['message'], recoveredAt: new Date().toISOString() };
  },
};

for (const [name, fn] of Object.entries(handlers)) {
  engine.registerHandler(name, fn as Parameters<typeof engine.registerHandler>[1]);
}

ok('All handlers registered');
ok(`File stores: checkpoints=${CHECKPOINTS_FILE}`);

/* ─────────────────────────────────────────────────────────
   3. Run 1 — Digital order: switch + parallel + fork/join + forEach + skipIf(false)
   ───────────────────────────────────────────────────────── */

header('3. Run 1 — Digital order (switch → digital branch, all lanes, fork/join, forEach with break)');

const run1 = await engine.startRun('order-processing-v1', {
  order: { id: 'ORD-001', type: 'digital', items: ['item-A', 'item-B', 'item-C'], suppressEmail: false },
});

console.log(`  Status: ${run1.status}`);
if (run1.status !== 'completed') {
  console.error('  ERROR:', run1.error);
  process.exit(1);
}

const v1 = run1.state.variables;

// Verify switch routed correctly
const fulfillResult = v1['__step_fulfill-digital'] as Record<string, unknown>;
ok(`switch routed to fulfill-digital: "${fulfillResult?.['status']}"`);

// Verify named parallel lanes returned Record<name, result>
const checksResult = v1['__step_quality-checks'] as Record<string, unknown>;
ok(`parallelLanes fraud.passed=${(checksResult?.['fraud'] as Record<string, unknown>)?.['passed']}, inventory.available=${(checksResult?.['inventory'] as Record<string, unknown>)?.['available']}, credit.approved=${(checksResult?.['credit'] as Record<string, unknown>)?.['approved']}`);

// Verify fork/join
const joinResult = v1['__step_join-analysis'] as Record<string, unknown>;
const pricing  = joinResult?.['pricing']  as Record<string, unknown>;
const shipping = joinResult?.['shipping'] as Record<string, unknown>;
ok(`fork/join: pricing.finalPrice=${pricing?.['finalPrice']}, shipping.carrier=${shipping?.['carrier']}`);

// Verify forEach break
const forEachResult = v1['__step_process-items'] as Record<string, unknown>;
ok(`forEach processed ${forEachResult?.['count']} of 3 items (broke=${forEachResult?.['broke']}) — item-C triggered { __break: true }`);

// Verify skipIf=false → step ran
const emailResult = v1['__step_send-confirmation'] as Record<string, unknown>;
ok(`skipIf(false) → send-confirmation ran: emailSent=${emailResult?.['emailSent']}`);

ok(`Run 1 completed — ${run1.state.history.length} steps executed`);

/* ─────────────────────────────────────────────────────────
   4. Run 2 — Physical order with suppressEmail=true: skipIf demo
   ───────────────────────────────────────────────────────── */

header('4. Run 2 — Physical order with suppressEmail=true (skipIf demo)');

const run2 = await engine.startRun('order-processing-v1', {
  order: { id: 'ORD-002', type: 'physical', items: ['item-X'], suppressEmail: true },
});

console.log(`  Status: ${run2.status}`);
const v2 = run2.state.variables;

ok(`switch routed to fulfill-physical: "${(v2['__step_fulfill-physical'] as Record<string, unknown>)?.['status']}"`);

// Confirm skipIf=true → step was skipped (status: 'skipped' in history)
const skipResult = run2.state.history.find(h => h.stepId === 'send-confirmation');
ok(`skipIf(true) → send-confirmation status="${skipResult?.status ?? 'not in history'}" (step was skipped)`);

/* ─────────────────────────────────────────────────────────
   5. Run 3 — onError boundary: validate-order fails, jumps to handler
   ───────────────────────────────────────────────────────── */

header('5. Run 3 — onError boundary (validate-order throws → handle-validation-error)');

// Missing 'id' in order triggers throw in validate-order handler
const run3 = await engine.startRun('order-processing-v1', {
  order: { type: 'digital' },  // id is missing → validate-order throws
});

console.log(`  Status: ${run3.status}`);
const v3 = run3.state.variables;

const errorVar = v3['__error'] as Record<string, unknown> | undefined;
ok(`__error captured: "${errorVar?.['message']}"`);

const errorHandlerResult = v3['__step_handle-validation-error'] as Record<string, unknown> | undefined;
ok(`onError redirected to handle-validation-error: handled=${errorHandlerResult?.['handled']}, originalError="${errorHandlerResult?.['originalError']}"`);

// Run ends as 'completed' because the error handler ran to completion
ok(`Run status after onError boundary: ${run3.status}`);

/* ─────────────────────────────────────────────────────────
   6. Persistence verification — reload definitions from file
   ───────────────────────────────────────────────────────── */

header('6. File-backed persistence — reload definition store from disk');

const freshStore = new JsonFileWorkflowDefinitionStore(DEFS_FILE);
const loaded = await freshStore.get('order-processing-v1');
ok(`Loaded definition: "${loaded?.name}" with ${loaded?.steps.length} steps`);

const freshRunRepo = new JsonFileWorkflowRunRepository(RUNS_FILE);
const allRuns = await freshRunRepo.list();
ok(`Persisted ${allRuns.length} runs across 3 executions`);

const freshCheckpoints = new JsonFileCheckpointStore(CHECKPOINTS_FILE);
const cpForRun1 = await freshCheckpoints.list(run1.id);
ok(`Run 1 has ${cpForRun1.length} checkpoints on disk`);

/* ─────────────────────────────────────────────────────────
   7. Workflow tool — agents can call this to start a run
   ───────────────────────────────────────────────────────── */

header('7. Workflow Tool — wiring for agent-driven execution');

/**
 * This is the tool definition an agent would call. In a real agent setup,
 * you register this with the ToolRegistry from @weaveintel/core and inject
 * it into the agent's resolver deps so agentic workflow steps can invoke
 * other workflows.
 *
 * The tool schema follows the @weaveintel/core Tool contract:
 *   { name, description, parameters (JSON Schema), execute }
 */
const runWorkflowTool = {
  name: 'run_workflow',
  description: 'Start a workflow run and return the completed run state. Use this to execute a named workflow with a given input.',
  parameters: {
    type: 'object' as const,
    required: ['workflowId', 'input'],
    properties: {
      workflowId: { type: 'string', description: 'The workflow definition ID to run' },
      input: { type: 'object', description: 'Input variables for the workflow run' },
    },
  },
  execute: async (args: { workflowId: string; input: Record<string, unknown> }) => {
    const run = await engine.startRun(args.workflowId, args.input);
    return {
      runId: run.id,
      status: run.status,
      stepsExecuted: run.state.history.length,
      error: run.error ?? null,
      output: run.state.variables,
    };
  },
};

// Demonstrate tool invocation — exactly what an agent's ReAct loop does
const toolResult = await runWorkflowTool.execute({
  workflowId: 'order-processing-v1',
  input: { order: { id: 'ORD-AGENT-001', type: 'subscription', items: ['plan-pro'], suppressEmail: false } },
});

ok(`Tool executed: workflowId=order-processing-v1`);
ok(`Tool result: status=${toolResult.status}, steps=${toolResult.stepsExecuted}, runId=${toolResult.runId}`);
const agentJoinResult = (toolResult.output['__step_join-analysis'] as Record<string, unknown>);
ok(`Fork/Join via tool: pricing=${JSON.stringify(agentJoinResult?.['pricing'])}`);

// ── Agent integration (real LLM call if API key is present) ────────────────

if (process.env['ANTHROPIC_API_KEY']) {
  header('7b. Agent Integration — agent calls run_workflow tool via ReAct loop');

  try {
    // Dynamically import to avoid failing when package unavailable
    const { weaveAgent } = await import('@weaveintel/agents');
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    const { weaveToolRegistry, weaveTool, weaveContext } = await import('@weaveintel/core');

    const model = weaveAnthropicModel('claude-haiku-4-5-20251001', {
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });
    const tools = weaveToolRegistry();
    tools.register(weaveTool({
      name: runWorkflowTool.name,
      description: runWorkflowTool.description,
      parameters: runWorkflowTool.parameters,
      execute: async (args) => {
        const out = await runWorkflowTool.execute(args as { workflowId: string; input: Record<string, unknown> });
        return { content: JSON.stringify(out), metadata: out };
      },
    }));

    const agent = weaveAgent({
      name: 'order-processor',
      model,
      tools,
      systemPrompt: 'You are an order processing assistant. Use the run_workflow tool to process orders.',
    });

    const response = await agent.run(weaveContext({}), {
      goal: 'Process order ORD-LLM-001',
      messages: [{ role: 'user', content: 'Process order ORD-LLM-001: type=digital, items=[ebook-js], suppressEmail=false' }],
    });
    ok(`Agent completed: ${response.output?.slice(0, 100)}...`);
  } catch (e) {
    info(`Agent demo skipped: ${(e as Error).message}`);
  }
} else {
  info('ANTHROPIC_API_KEY not set — agent LLM demo skipped (tool invocation shown above in section 7)');
}

/* ─────────────────────────────────────────────────────────
   8. forEach with maxConcurrency demo (separate workflow)
   ───────────────────────────────────────────────────────── */

header('8. forEach maxConcurrency=3 — batch parallel processing');

const batchDef = defineWorkflow('Batch Processor')
  .setId('batch-processor-v1')
  .forEach('batch-process', 'Batch Process Items', {
    handler: 'list-batch-items',
    bodyHandler: 'process-batch-item',
    maxConcurrency: 3,
  })
  .build();

const batchEngine = new DefaultWorkflowEngine();
await batchEngine.createDefinition(batchDef);

const processedBatches: string[] = [];

batchEngine.registerHandler('list-batch-items', async () =>
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
);

batchEngine.registerHandler('process-batch-item', async (vars) => {
  const item = vars['__forEachItem'] as string;
  const idx  = vars['__forEachIndex'] as number;
  processedBatches.push(`${item}@${idx}`);
  return { item, processed: true };
});

const batchRun = await batchEngine.startRun('batch-processor-v1', {});

const batchResult = batchRun.state.variables['__step_batch-process'] as Record<string, unknown>;
ok(`forEach maxConcurrency=3: processed ${batchResult?.['count']} items`);
ok(`Items: ${processedBatches.join(', ')}`);
ok(`broke=${batchResult?.['broke']}`);

/* ─────────────────────────────────────────────────────────
   Summary
   ───────────────────────────────────────────────────────── */

header('Summary');
ok('switch step — multi-case routing by string key (digital/physical/subscription/default)');
ok('parallelLanes — named concurrent handlers returned as Record<name, output>');
ok('fork / join  — two concurrent analysis paths aggregated at join');
ok('forEach      — serial + batched parallel with { __break: true } early exit');
ok('onError      — error boundary redirected failed step to handle-validation-error');
ok('skipIf       — send-confirmation skipped when order.suppressEmail = true');
ok('JsonFileCheckpointStore + JsonFileWorkflowDefinitionStore — file-backed persistence');
ok('Workflow tool wiring — agent-callable execute() wrapping engine.startRun()');

/* Cleanup temp files */
await rm(WORK_DIR, { recursive: true, force: true });
}

main().catch(console.error);
