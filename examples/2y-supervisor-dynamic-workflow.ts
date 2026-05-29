/**
 * Example 2Y — Supervisor Agent Spawning a Dynamic Workflow (Phase W7)
 *
 * Architecture:
 *   ┌─ Supervisor (weaveAgent with workers) ─────────────────────────┐
 *   │  Auto-gets: think, plan, delegate_to_worker                     │
 *   │                                                                  │
 *   │  delegate_to_worker ──► Planner Worker                          │
 *   │                           list_handlers  → discovers handler names│
 *   │                           plan_expansion → stores DynamicExpansion│
 *   └──────────────────────────────────────────────────────────────────┘
 *                    ▼ plannerFn (called by engine at step-exec time)
 *   ┌─ WorkflowEngine ────────────────────────────────────────────────┐
 *   │  gather-context → [dynamic: supervisor-plan] → finalize          │
 *   │                           ↓                                      │
 *   │               DynamicExpansion spliced + validated               │
 *   │  fetch-market-data → compute-risk-score → generate-report       │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Sections 1–4: fake models (no API key). Section 5: real Claude.
 *
 * Run:
 *   npx tsx examples/2y-supervisor-dynamic-workflow.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/2y-supervisor-dynamic-workflow.ts
 */

import 'dotenv/config';
import {
  DefaultWorkflowEngine,
  defineWorkflow,
  HandlerResolverRegistry,
  createNoopResolver,
  createPlannerResolver,
  describeHandlerKinds,
} from '@weaveintel/workflows';
import type { DynamicExpansion } from '@weaveintel/core';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import type { WorkerDefinition } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';
import type { Model } from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function step(msg: string) { console.log(`\n  [step] ${msg}`); }

/* ═══════════════════════════════════════════════════════════════════════════
   Domain handler catalogue
   ═══════════════════════════════════════════════════════════════════════════ */

const DOMAIN_HANDLERS = [
  { name: 'fetch-market-data',  description: 'Fetch live or simulated prices for a list of tickers' },
  { name: 'compute-risk-score', description: 'Compute a portfolio risk score from market prices (0–1)' },
  { name: 'generate-report',    description: 'Produce a human-readable risk summary report' },
  { name: 'send-alert',         description: 'Dispatch a Slack/email alert when risk is HIGH' },
] as const;
type DomainHandlerName = typeof DOMAIN_HANDLERS[number]['name'];
const DOMAIN_HANDLER_NAMES = new Set<string>(DOMAIN_HANDLERS.map(h => h.name));

/* ═══════════════════════════════════════════════════════════════════════════
   Engine setup — handlers + workflow definition
   ═══════════════════════════════════════════════════════════════════════════ */

function registerDomainHandlers(engine: DefaultWorkflowEngine) {
  engine.registerHandler('gather-context', async (vars) => {
    info('    gather-context: preparing run context');
    return {
      tickers: (vars['tickers'] as string[] | undefined) ?? ['AAPL', 'MSFT', 'GOOGL'],
      goal:    (vars['goal']    as string   | undefined) ?? 'assess portfolio risk',
    };
  });

  engine.registerHandler('fetch-market-data', async (vars) => {
    const ctxStep = Object.values(vars).find(
      (v): v is { tickers: string[] } =>
        !!v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)['tickers']),
    );
    const tickers = ctxStep?.tickers ?? (vars['tickers'] as string[] | undefined) ?? ['AAPL', 'MSFT'];
    info(`    fetch-market-data: loading prices for ${tickers.join(', ')}`);
    return {
      prices: Object.fromEntries(tickers.map(t => [t, +(Math.random() * 200 + 50).toFixed(2)])),
      fetchedAt: new Date().toISOString(),
    };
  });

  engine.registerHandler('compute-risk-score', async (vars) => {
    const market = Object.values(vars).find(
      (v): v is { prices: Record<string, number> } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['prices'] === 'object',
    );
    const prices = Object.values(market?.prices ?? {});
    const mean   = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    const risk   = +(Math.random() * 0.3 + 0.1).toFixed(3);
    info(`    compute-risk-score: mean=${mean.toFixed(2)}, risk=${risk}`);
    return { riskScore: risk, meanPrice: +mean.toFixed(2), classification: risk > 0.25 ? 'HIGH' : 'MODERATE' };
  });

  engine.registerHandler('generate-report', async (vars) => {
    const riskData = Object.values(vars).find(
      (v): v is { riskScore: number; classification: string } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['riskScore'] === 'number',
    );
    info(`    generate-report: risk=${riskData?.riskScore ?? 'n/a'} (${riskData?.classification ?? 'n/a'})`);
    return {
      title: 'Portfolio Risk Report',
      riskScore: riskData?.riskScore,
      classification: riskData?.classification ?? 'UNKNOWN',
      summary: `Portfolio risk is ${riskData?.classification ?? 'UNKNOWN'}. Score: ${(riskData?.riskScore ?? 0).toFixed(3)}.`,
    };
  });

  engine.registerHandler('finalize', async (vars) => {
    const report = Object.values(vars).find(
      (v): v is { summary: string } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['summary'] === 'string',
    );
    return { status: 'done', summary: report?.summary ?? '(no report generated)' };
  });
}

/** The static workflow definition used by every demo section. */
function buildWorkflowDef() {
  return defineWorkflow('Supervisor-Planned Analysis')
    .setId('supervisor-dynamic-analysis')
    .setPolicy({
      maxExpansionDepth: 3,
      maxGeneratedSteps: 10,
      dynamicHandlerKinds: ['noop', 'tool', 'prompt', 'agent', 'mcp'], // script: blocked
    })
    .addStep({ id: 'gather-context', name: 'Gather Context', type: 'deterministic', handler: 'gather-context', next: 'supervisor-plan' })
    .dynamic('supervisor-plan', 'Supervisor Plans Analysis', {
      handler: 'plan:analyze portfolio risk and generate a report',
      next: 'finalize',
    })
    .addStep({ id: 'finalize', name: 'Finalize', type: 'deterministic', handler: 'finalize' })
    .build();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Planner worker tools — used by both fake and real worker agents
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Build the planner worker's two tools.
 * plan_expansion writes to `onExpansion`; list_handlers reads the registry.
 */
function buildPlannerWorkerTools(
  reg: HandlerResolverRegistry,
  onExpansion: (exp: DynamicExpansion) => void,
) {
  const tools = weaveToolRegistry();

  tools.register(weaveTool({
    name: 'list_handlers',
    description:
      'List all available workflow step handlers and resolver kinds. ' +
      'Call this FIRST so you only use valid handler names in plan_expansion.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const resolverKinds = describeHandlerKinds(reg);
      const payload = {
        domainHandlers: [...DOMAIN_HANDLERS],
        resolverKinds:  resolverKinds.map(k => ({ kind: k.kind, description: k.description })),
        note: 'Use domainHandlers[].name as the "handler" field in plan_expansion steps.',
      };
      step(`Planner worker: list_handlers → ${payload.domainHandlers.length} domain handlers, ${payload.resolverKinds.length} resolver kinds`);
      return JSON.stringify(payload);
    },
  }));

  tools.register(weaveTool({
    name: 'plan_expansion',
    description:
      'Submit a DynamicExpansion plan. ' +
      'Each step\'s "handler" must be a name from list_handlers. ' +
      'Set "rejoin" to "finalize".',
    parameters: {
      type: 'object',
      required: ['steps', 'entry'],
      properties: {
        steps: {
          type: 'array',
          description: 'Steps for the sub-graph. Use only handler names from list_handlers.',
          items: {
            type: 'object',
            required: ['id', 'name', 'type', 'handler'],
            properties: {
              id:      { type: 'string', description: 'Unique step id, e.g. "step-1-fetch"' },
              name:    { type: 'string' },
              type:    { type: 'string', enum: ['deterministic', 'agentic'] },
              handler: { type: 'string', description: 'Handler name from list_handlers' },
            },
          },
        },
        entry:  { type: 'string', description: 'First step id' },
        rejoin: { type: 'string', description: 'Step to route to after sub-graph ends (use "finalize")' },
      },
    },
    execute: async (args: {
      steps: Array<{ id: string; name: string; type: string; handler: string }>;
      entry: string;
      rejoin?: string;
    }) => {
      // Validate handler names (colon-prefixed resolver refs pass through to engine governance)
      const unknown = args.steps.filter(s => !s.handler.includes(':') && !DOMAIN_HANDLER_NAMES.has(s.handler));
      if (unknown.length > 0) {
        const msg = `Unknown handler(s): ${unknown.map(s => `"${s.handler}"`).join(', ')}. Call list_handlers first.`;
        warn(`    plan_expansion rejected → ${msg}`);
        return JSON.stringify({ error: msg });
      }
      const expansion: DynamicExpansion = {
        steps: args.steps.map(s => ({
          id: s.id, name: s.name,
          type: s.type as 'deterministic' | 'agentic',
          handler: s.handler,
        })),
        entry:  args.entry,
        rejoin: args.rejoin ?? 'finalize',
      };
      step(`Planner worker: plan submitted → ${args.steps.map(s => `${s.id}(${s.handler})`).join(' → ')}`);
      onExpansion(expansion);
      return JSON.stringify({ accepted: true, stepCount: args.steps.length });
    },
  }));

  return tools;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Supervisor builder — weaveAgent in supervisor mode (workers: [...])
   ═══════════════════════════════════════════════════════════════════════════ */

function buildSupervisor(supervisorModel: Model, plannerWorkerModel: Model, plannerTools: ReturnType<typeof weaveToolRegistry>) {
  const plannerWorker: WorkerDefinition = {
    name: 'planner',
    description:
      'Specialist workflow planner. Has list_handlers to discover valid step handler names ' +
      'and plan_expansion to submit a DynamicExpansion to the engine. ' +
      'Always calls list_handlers BEFORE plan_expansion.',
    model: plannerWorkerModel,
    tools: plannerTools,
  };

  return weaveAgent({
    name: 'workflow-supervisor',
    model: supervisorModel,
    workers: [plannerWorker],          // ← supervisor mode: auto-adds delegate_to_worker
    systemPrompt:
      'You are a workflow orchestration supervisor.\n' +
      'When asked to plan an analysis workflow, delegate to the "planner" worker ' +
      'with a clear goal. The planner will discover available handlers and submit the plan. ' +
      'Report the result back to the user.',
    maxSteps: 6,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Show what list_handlers returns
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoListHandlers() {
  header('1. list_handlers — what the planner worker discovers');

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: async () => ({ steps: [], entry: '' }) }));

  const resolverKinds = describeHandlerKinds(reg);
  ok(`Resolver kinds registered: ${resolverKinds.map(k => k.kind).join(', ')}`);
  info(`  "noop" → "${resolverKinds.find(k => k.kind === 'noop')?.description?.slice(0, 55)}..."`);
  info(`  "plan" → "${resolverKinds.find(k => k.kind === 'plan')?.description?.slice(0, 55)}..."`);

  ok(`Domain handlers: ${DOMAIN_HANDLERS.map(h => h.name).join(', ')}`);
  for (const h of DOMAIN_HANDLERS) info(`  "${h.name}" — ${h.description}`);
  info('Supervisor delegates to "planner" worker → worker calls list_handlers → plan_expansion.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Fake-model supervisor (no API key needed)
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoFakeSupervisor() {
  header('2. Fake-Model Supervisor → Planner Worker → Dynamic Workflow');

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  // plannerFn is called by the engine at dynamic-step execution time.
  // It runs the supervisor, which delegates to the planner worker.
  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    info(`\n    [engine→planner] requesting plan for: "${goal}"`);
    const ctx = weaveContext({ userId: 'fake-supervisor-session' });
    await supervisor.run(ctx, {
      messages: [{
        role: 'user',
        content: `Plan a portfolio analysis workflow. Goal: "${goal}". Delegate to the planner worker.`,
      }],
    });
    if (!capturedExpansion) throw new Error('No plan was submitted by the planner worker');
    const result = capturedExpansion;
    capturedExpansion = null;
    return result;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });
  registerDomainHandlers(engine);

  // Planner worker tools
  const plannerTools = buildPlannerWorkerTools(reg, exp => { capturedExpansion = exp; });

  // ── Scripted fake models ──────────────────────────────────────────────────
  //
  // Supervisor (2 turns):
  //   Turn 1 → delegate_to_worker("planner", goal)
  //   Turn 2 → summarise
  //
  // Planner worker (3 turns):
  //   Turn 1 → list_handlers()
  //   Turn 2 → plan_expansion(steps with real handler names)
  //   Turn 3 → "Plan submitted."

  const supervisorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'sv-tc-1',
          function: {
            name: 'delegate_to_worker',
            arguments: JSON.stringify({
              worker: 'planner',
              goal: 'Build a 3-step portfolio risk analysis: fetch market data, compute risk score, then generate a report.',
            }),
          },
        }],
      },
      {
        content:
          'The planner worker has submitted a 3-step workflow: ' +
          'fetch-market-data → compute-risk-score → generate-report. The engine will validate and execute it.',
        toolCalls: [],
      },
    ],
  });

  const plannerWorkerModel = weaveFakeModel({
    responses: [
      // Turn 1: discover handlers
      {
        content: '',
        toolCalls: [{
          id: 'pw-tc-1',
          function: { name: 'list_handlers', arguments: JSON.stringify({}) },
        }],
      },
      // Turn 2: submit plan using names from the list
      {
        content: '',
        toolCalls: [{
          id: 'pw-tc-2',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [
                { id: 'step-1-fetch',  name: 'Fetch Market Data',  type: 'deterministic', handler: 'fetch-market-data'  },
                { id: 'step-2-risk',   name: 'Compute Risk Score', type: 'deterministic', handler: 'compute-risk-score' },
                { id: 'step-3-report', name: 'Generate Report',    type: 'deterministic', handler: 'generate-report'    },
              ],
              entry: 'step-1-fetch',
              rejoin: 'finalize',
            }),
          },
        }],
      },
      // Turn 3: done
      { content: 'Plan submitted with 3 steps using validated handler names.', toolCalls: [] },
    ],
  });

  supervisor = buildSupervisor(supervisorModel, plannerWorkerModel, plannerTools);

  // ── Run the workflow ───────────────────────────────────────────────────────
  const def = buildWorkflowDef();
  await engine.createDefinition(def);

  info('\nStarting workflow — engine will call plannerFn → supervisor → planner worker...');
  const run = await engine.startRun(def.id, {
    tickers: ['AAPL', 'MSFT', 'GOOGL'],
    goal: 'analyze portfolio risk and generate a report',
  });

  console.log('');
  ok(`Run status: ${run.status}`);
  if (run.error) warn(`Error: ${run.error}`);
  ok(`Dynamic steps: ${run.dynamicSteps?.map(s => `${s.id}(${s.handler})`).join(' → ')}`);
  ok(`Expansion depth: ${run.expansionDepth}`);
  const final = run.state.variables['__step_finalize'] as { summary?: string } | undefined;
  ok(`Final: "${final?.summary ?? '(none)'}"`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. Safety — bad handler name caught by plan_expansion before engine sees it
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoBadHandler() {
  header('3. Safety — Bad Handler Name Caught by plan_expansion Tool');

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    const ctx = weaveContext({ userId: 'bad-session' });
    await supervisor.run(ctx, { messages: [{ role: 'user', content: `Plan for: ${goal}` }] });
    if (!capturedExpansion) throw new Error('No plan submitted');
    const r = capturedExpansion; capturedExpansion = null; return r;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });
  registerDomainHandlers(engine);

  const plannerTools = buildPlannerWorkerTools(reg, exp => { capturedExpansion = exp; });

  // Planner worker uses a made-up handler (skips list_handlers)
  const badPlannerModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'bad-tc',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [{ id: 's1', name: 'Mystery Step', type: 'deterministic', handler: 'made-up-handler' }],
              entry: 's1', rejoin: 'finalize',
            }),
          },
        }],
      },
      { content: 'Submitted plan with made-up-handler.', toolCalls: [] },
    ],
  });

  const supervisorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{ id: 'sv-tc', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'planner', goal: 'Plan something.' }) } }],
      },
      { content: 'Planner returned an error — bad handler name.', toolCalls: [] },
    ],
  });

  supervisor = buildSupervisor(supervisorModel, badPlannerModel, plannerTools);

  const def = buildWorkflowDef();
  await engine.createDefinition(def);
  const run = await engine.startRun(def.id, { tickers: ['AAPL'] });

  ok(`Run status: ${run.status} (expected: failed)`);
  ok(`Error: "${run.error?.slice(0, 70)}"`);
  ok('Engine never saw the plan — rejected at the tool layer');
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. Safety — script: injection blocked by engine governance
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoScriptInjection() {
  header('4. Safety — script: Injection Blocked by Engine Governance');

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    const ctx = weaveContext({ userId: 'inject-session' });
    await supervisor.run(ctx, { messages: [{ role: 'user', content: `Plan for: ${goal}` }] });
    if (!capturedExpansion) throw new Error('No plan');
    const r = capturedExpansion; capturedExpansion = null; return r;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({
    resolverRegistry: reg,
    defaultPolicy: { dynamicHandlerKinds: ['noop', 'tool', 'prompt', 'agent', 'mcp'] }, // script: NOT allowed
  });
  registerDomainHandlers(engine);

  // Permissive tool — accepts anything; engine governance is the safety net
  const permissiveTools = weaveToolRegistry();
  permissiveTools.register(weaveTool({
    name: 'plan_expansion',
    description: 'Submit a plan (permissive — engine will validate it).',
    parameters: {
      type: 'object', required: ['steps', 'entry'],
      properties: { steps: { type: 'array', items: { type: 'object' } }, entry: { type: 'string' }, rejoin: { type: 'string' } },
    },
    execute: async (args: { steps: Array<{ id: string; name: string; type: string; handler: string }>; entry: string; rejoin?: string }) => {
      capturedExpansion = {
        steps: args.steps.map(s => ({ id: s.id, name: s.name, type: 'deterministic' as const, handler: s.handler })),
        entry: args.entry, rejoin: args.rejoin ?? 'finalize',
      };
      warn(`    plan_expansion (permissive): accepted handler="${args.steps[0]?.handler}"`);
      return JSON.stringify({ accepted: true });
    },
  }));

  const injectorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'inj-tc',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [{ id: 'evil', name: 'Evil', type: 'deterministic', handler: 'script:return process.env.SECRET' }],
              entry: 'evil', rejoin: 'finalize',
            }),
          },
        }],
      },
      { content: 'Injected script handler.', toolCalls: [] },
    ],
  });

  const supervisorModel = weaveFakeModel({
    responses: [
      { content: '', toolCalls: [{ id: 'sv-tc', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'planner', goal: 'Do something.' }) } }] },
      { content: 'Done.', toolCalls: [] },
    ],
  });

  supervisor = buildSupervisor(supervisorModel, injectorModel, permissiveTools);

  const def = buildWorkflowDef();
  await engine.createDefinition(def);
  const run = await engine.startRun(def.id, { tickers: ['AAPL'] });

  if (run.status === 'failed' && run.error?.includes('DISALLOWED_HANDLER_KIND')) {
    ok(`Engine blocked script: injection — DISALLOWED_HANDLER_KIND`);
    ok(`Error: "${run.error.slice(0, 80)}..."`);
  } else {
    warn(`Unexpected: status=${run.status} error=${run.error}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. Real Claude — supervisor in supervisor mode, planner worker with real LLM
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoRealSupervisor() {
  header('5. Real Claude — Supervisor Mode with Planner Worker');

  if (!process.env['ANTHROPIC_API_KEY']) {
    info('Skipped — set ANTHROPIC_API_KEY to run this section.');
    return;
  }

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    info(`\n    [engine→supervisor] requesting plan for: "${goal}"`);
    const ctx = weaveContext({ userId: 'real-supervisor-session' });

    const result = await supervisor.run(ctx, {
      messages: [{
        role: 'user',
        content:
          `You are orchestrating a portfolio analysis workflow.\n` +
          `Goal: "${goal}".\n\n` +
          `Delegate to the "planner" worker with this instruction:\n` +
          `"Call list_handlers to discover available step handlers, then call plan_expansion ` +
          `with a 3-step plan using ONLY handler names from list_handlers. Set rejoin to 'finalize'."`,
      }],
    });

    info(`\n    Supervisor completed in ${result.steps.length} turns:`);
    for (const s of result.steps) {
      if (s.toolCall) {
        const preview = JSON.stringify(s.toolCall.arguments).slice(0, 120);
        info(`      [tool] ${s.toolCall.name}(${preview}${preview.length >= 120 ? '...' : ''})`);
      } else if (s.content) {
        info(`      [text] ${s.content.slice(0, 100)}${s.content.length > 100 ? '...' : ''}`);
      }
    }

    if (!capturedExpansion) throw new Error('Planner worker did not submit a plan');
    const plan = capturedExpansion;
    capturedExpansion = null;
    return plan;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });
  registerDomainHandlers(engine);

  const plannerTools = buildPlannerWorkerTools(reg, exp => { capturedExpansion = exp; });

  try {
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');

    // Both supervisor and planner worker use real Claude
    const supervisorModel = weaveAnthropicModel('claude-haiku-4-5-20251001');
    const plannerModel    = weaveAnthropicModel('claude-haiku-4-5-20251001');

    supervisor = buildSupervisor(supervisorModel, plannerModel, plannerTools);

    const def = buildWorkflowDef();
    await engine.createDefinition(def);

    info('Starting workflow — engine will call plannerFn → real Claude supervisor → real Claude planner worker...');
    const run = await engine.startRun(def.id, {
      tickers: ['AAPL', 'MSFT', 'GOOGL'],
      goal: 'analyze portfolio risk and generate a report',
    });

    console.log('');
    ok(`Run status: ${run.status}`);
    if (run.error) warn(`Error: ${run.error}`);
    ok(`Dynamic steps generated: ${run.dynamicSteps?.length}`);
    ok(`  ${run.dynamicSteps?.map(s => `${s.id}(${s.handler})`).join(' → ')}`);
    ok(`Expansion depth: ${run.expansionDepth}`);
    const final = run.state.variables['__step_finalize'] as { summary?: string } | undefined;
    ok(`Final summary: "${final?.summary ?? '(none)'}"`);
  } catch (e) {
    warn(`Real supervisor error: ${(e as Error).message}`);
    if ((e as Error).stack) info((e as Error).stack!.split('\n').slice(0, 4).join('\n'));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   main
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('\n@weaveintel/workflows — Phase W7: Supervisor Agent + Dynamic Workflow');
  console.log('Sections 1–4: no API key. Section 5: real Claude via ANTHROPIC_API_KEY.\n');

  await demoListHandlers();
  await demoFakeSupervisor();
  await demoBadHandler();
  await demoScriptInjection();
  await demoRealSupervisor();

  console.log('\n' + '═'.repeat(64));
  console.log('  All demos complete.');
  console.log('═'.repeat(64) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
