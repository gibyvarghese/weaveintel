/**
 * Example 2Y — Supervisor Agent Spawning a Dynamic Workflow (Phase W7)
 *
 * Demonstrates a WeaveAgent supervisor driving a Phase W7 dynamic workflow:
 *
 *  1. list_handlers tool       — agent discovers available handler names + resolver kinds
 *  2. plan_expansion tool      — agent submits a DynamicExpansion using real handler names
 *  3. createPlannerResolver    — bridges agent ↔ engine: plan() runs the agent inline,
 *                                retrieves the stored expansion, returns it to the engine
 *  4. Governance validation    — validateExpansion blocks bad-handler and script: injection
 *  5. Real-LLM path (opt-in)  — ANTHROPIC_API_KEY: Claude generates the plan live
 *
 * Critical property: the supervisor calls list_handlers FIRST, then uses only those
 * handler names in plan_expansion. The engine's validateExpansion runs before any step
 * executes. Two safety layers: the tool validates domain names, the engine blocks
 * disallowed resolver kinds (script:, subworkflow:).
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
  type WorkflowEngineOptions,
} from '@weaveintel/workflows';
import type { DynamicExpansion } from '@weaveintel/core';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent, type ToolCallingAgentOptions } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

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
   Domain handler names — the catalogue the agent sees via list_handlers
   ═══════════════════════════════════════════════════════════════════════════ */

const DOMAIN_HANDLERS = [
  { name: 'fetch-market-data',  description: 'Fetch live or simulated prices for a list of tickers' },
  { name: 'compute-risk-score', description: 'Compute a portfolio risk score from market prices (0–1)' },
  { name: 'generate-report',    description: 'Produce a human-readable risk summary report' },
  { name: 'send-alert',         description: 'Dispatch a slack/email alert when risk is HIGH' },
] as const;

const DOMAIN_HANDLER_NAMES = new Set(DOMAIN_HANDLERS.map(h => h.name));

/* ═══════════════════════════════════════════════════════════════════════════
   Shared engine setup
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Register domain step handlers on an engine.
 * Handlers look for data across ALL step-output variables so they are
 * position-independent (step IDs are chosen by the agent at runtime).
 */
function registerDomainHandlers(engine: DefaultWorkflowEngine) {
  engine.registerHandler('gather-context', async (vars) => {
    info('    gather-context: preparing run context');
    return {
      tickers: (vars['tickers'] as string[] | undefined) ?? ['AAPL', 'MSFT', 'GOOGL'],
      goal: (vars['goal'] as string | undefined) ?? 'assess portfolio risk',
    };
  });

  engine.registerHandler('fetch-market-data', async (vars) => {
    // Find tickers from the gather-context step output (or run variables directly)
    const ctxStep = Object.values(vars).find(
      (v): v is { tickers: string[] } => !!v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)['tickers']),
    );
    const tickers = ctxStep?.tickers ?? (vars['tickers'] as string[] | undefined) ?? ['AAPL', 'MSFT'];
    info(`    fetch-market-data: prices for ${tickers.join(', ')}`);
    return {
      prices: Object.fromEntries(tickers.map(t => [t, +(Math.random() * 200 + 50).toFixed(2)])),
      fetchedAt: new Date().toISOString(),
    };
  });

  engine.registerHandler('compute-risk-score', async (vars) => {
    // Find market data by scanning step outputs for a `prices` object
    const marketData = Object.values(vars).find(
      (v): v is { prices: Record<string, number> } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['prices'] === 'object',
    );
    const prices = Object.values(marketData?.prices ?? {});
    const mean = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    const risk = +(Math.random() * 0.3 + 0.1).toFixed(3);
    info(`    compute-risk-score: mean=${mean.toFixed(2)}, risk=${risk}`);
    return { riskScore: risk, meanPrice: +mean.toFixed(2), classification: risk > 0.25 ? 'HIGH' : 'MODERATE' };
  });

  engine.registerHandler('generate-report', async (vars) => {
    // Find risk data by scanning step outputs for a `riskScore`
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

  engine.registerHandler('send-alert', async (vars) => {
    const riskData = Object.values(vars).find(
      (v): v is { classification: string } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['classification'] === 'string',
    );
    info(`    send-alert: dispatching ${riskData?.classification ?? 'UNKNOWN'} alert`);
    return { alertSent: true, channel: 'slack', severity: riskData?.classification };
  });

  engine.registerHandler('finalize', async (vars) => {
    // Find the most recent report-shaped output
    const reportData = Object.values(vars).find(
      (v): v is { summary: string; title?: string } =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['summary'] === 'string',
    );
    return { status: 'done', summary: reportData?.summary ?? '(no report generated)' };
  });
}

/** Static workflow: gather-context → [dynamic: supervisor plans] → finalize */
function buildWorkflowDef() {
  return defineWorkflow('Supervisor-Planned Analysis')
    .setId('supervisor-dynamic-analysis')
    .setPolicy({
      maxExpansionDepth: 3,
      maxGeneratedSteps: 10,
      // Only allow safe resolver kinds in generated steps
      dynamicHandlerKinds: ['noop', 'tool', 'prompt', 'agent', 'mcp'],
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
   Agent tool builders — reused across demos
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Build the two agent tools:
 *   list_handlers  — returns domain handlers + resolver kinds
 *   plan_expansion — validates handler names, stores the DynamicExpansion
 *
 * @param reg             Resolver registry (for describeHandlerKinds)
 * @param onExpansion     Called when agent submits a valid plan
 */
function buildAgentTools(
  reg: HandlerResolverRegistry,
  onExpansion: (exp: DynamicExpansion) => void,
) {
  const tools = weaveToolRegistry();

  tools.register(weaveTool({
    name: 'list_handlers',
    description:
      'List all available workflow step handlers. ' +
      'Call this FIRST before planning so you use only valid handler names.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const resolverKinds = describeHandlerKinds(reg);
      const payload = {
        domainHandlers: [...DOMAIN_HANDLERS],
        resolverKinds: resolverKinds.map(k => ({ kind: k.kind, description: k.description })),
        note: 'Use domainHandlers[].name as the "handler" field in plan_expansion steps.',
      };
      step(`Agent called list_handlers → ${payload.domainHandlers.length} domain handlers, ${payload.resolverKinds.length} resolver kinds`);
      return JSON.stringify(payload);
    },
  }));

  tools.register(weaveTool({
    name: 'plan_expansion',
    description:
      'Submit a DynamicExpansion plan to the workflow engine. ' +
      'Each step\'s "handler" MUST be a name returned by list_handlers. ' +
      '"entry" is the first step id. "rejoin" should be "finalize".',
    parameters: {
      type: 'object',
      required: ['steps', 'entry'],
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered list of steps. Use handler names from list_handlers.',
          items: {
            type: 'object',
            required: ['id', 'name', 'type', 'handler'],
            properties: {
              id:      { type: 'string', description: 'Unique step id (e.g. "step-1-fetch")' },
              name:    { type: 'string', description: 'Human-readable step name' },
              type:    { type: 'string', enum: ['deterministic', 'agentic'] },
              handler: { type: 'string', description: 'Handler name — must be from list_handlers' },
              next:    { type: 'string', description: 'Next step id (omit for last step)' },
            },
          },
        },
        entry:  { type: 'string', description: 'ID of the first step to execute' },
        rejoin: { type: 'string', description: 'Step to route to when sub-graph ends (use "finalize")' },
      },
    },
    execute: async (args: {
      steps: Array<{ id: string; name: string; type: string; handler: string; next?: string }>;
      entry: string;
      rejoin?: string;
    }) => {
      // Validate: each handler must be a known domain name OR a colon-prefixed resolver ref
      const unknown = args.steps.filter(s => {
        if (s.handler.includes(':')) return false; // resolver-kind ref (governance validates kind)
        return !DOMAIN_HANDLER_NAMES.has(s.handler as typeof DOMAIN_HANDLERS[number]['name']);
      });
      if (unknown.length > 0) {
        const msg = `Unknown handler(s): ${unknown.map(s => `"${s.handler}"`).join(', ')}. Call list_handlers first.`;
        warn(`    plan_expansion rejected → ${msg}`);
        return JSON.stringify({ error: msg });
      }

      const expansion: DynamicExpansion = {
        steps: args.steps.map(s => ({
          id: s.id,
          name: s.name,
          type: s.type as 'deterministic' | 'agentic',
          handler: s.handler,
          ...(s.next ? { next: s.next } : {}),
        })),
        entry: args.entry,
        rejoin: args.rejoin ?? 'finalize',
      };

      step(`Agent submitted plan: ${args.steps.map(s => `${s.id}(${s.handler})`).join(' → ')}`);
      onExpansion(expansion);
      return JSON.stringify({ accepted: true, stepCount: args.steps.length });
    },
  }));

  return tools;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. Show what list_handlers returns
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoListHandlers() {
  header('1. list_handlers — what the agent discovers');

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: async () => ({ steps: [], entry: '' }) }));

  const resolverKinds = describeHandlerKinds(reg);
  ok(`Resolver kinds: ${resolverKinds.map(k => k.kind).join(', ')}`);
  info(`  "noop" → "${resolverKinds.find(k => k.kind === 'noop')?.description?.slice(0, 55)}..."`);
  info(`  "plan" → "${resolverKinds.find(k => k.kind === 'plan')?.description?.slice(0, 55)}..."`);

  ok(`Domain handlers: ${DOMAIN_HANDLERS.map(h => h.name).join(', ')}`);
  for (const h of DOMAIN_HANDLERS) {
    info(`  "${h.name}" — ${h.description}`);
  }
  info('The supervisor calls list_handlers once per plan request, then picks names from the result.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Fake-model demo — supervisor plans the workflow (no API key needed)
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoFakeAgent() {
  header('2. Fake-Model Supervisor — Discovers Handlers → Plans → Executes');

  // capturedExpansion is written by plan_expansion tool, read by plannerFn
  let capturedExpansion: DynamicExpansion | null = null;

  // supervisor is assigned after the tools are built (forward reference via let)
  let supervisor!: ReturnType<typeof weaveAgent>;

  // plannerFn is invoked BY THE ENGINE when the dynamic step executes.
  // It runs the supervisor agent inline and returns the plan the agent submits.
  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    info(`\n    plannerFn: engine requests a plan for "${goal}"`);
    const agentCtx = weaveContext({ userId: 'planner-session' });
    await supervisor.run(agentCtx, {
      messages: [{
        role: 'user',
        content: `Plan a market analysis workflow for: ${goal}. Call list_handlers first to see available handlers, then call plan_expansion with your plan.`,
      }],
    });
    if (!capturedExpansion) throw new Error('Supervisor did not submit a plan');
    const result = capturedExpansion;
    capturedExpansion = null;
    return result;
  };

  // Build registry with the planner wired in
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg } satisfies WorkflowEngineOptions);
  registerDomainHandlers(engine);

  // Build agent tools — plan_expansion calls onExpansion to store the plan
  const agentTools = buildAgentTools(reg, exp => { capturedExpansion = exp; });

  // Fake model: scripted 3-turn sequence
  //  Turn 1 → call list_handlers
  //  Turn 2 → parse response, call plan_expansion with handler names from the list
  //  Turn 3 → final text summary
  const fakeModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'tc-list',
          function: { name: 'list_handlers', arguments: JSON.stringify({}) },
        }],
      },
      {
        content: '',
        toolCalls: [{
          id: 'tc-plan',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [
                { id: 'step-1-fetch',  name: 'Fetch Market Data',  type: 'deterministic', handler: 'fetch-market-data' },
                { id: 'step-2-risk',   name: 'Compute Risk Score', type: 'deterministic', handler: 'compute-risk-score' },
                { id: 'step-3-report', name: 'Generate Report',    type: 'deterministic', handler: 'generate-report' },
              ],
              entry: 'step-1-fetch',
              rejoin: 'finalize',
            }),
          },
        }],
      },
      {
        content:
          'I called list_handlers and found four domain handlers. ' +
          'I submitted a 3-step plan: fetch-market-data → compute-risk-score → generate-report, ' +
          'using only the valid handler names I discovered.',
        toolCalls: [],
      },
    ],
  });

  // Assign supervisor AFTER tools and model are ready
  supervisor = weaveAgent({
    name: 'workflow-supervisor',
    model: fakeModel,
    tools: agentTools,
    systemPrompt:
      'You are a workflow planning supervisor.\n' +
      '1. ALWAYS call list_handlers first to discover valid handler names.\n' +
      '2. Call plan_expansion using ONLY names from list_handlers.\n' +
      '3. Set rejoin to "finalize".\n' +
      '4. Summarise the plan you submitted.',
    maxSteps: 8,
  } satisfies ToolCallingAgentOptions);

  // Run the workflow — the engine will call plannerFn when it hits the dynamic step
  const def = buildWorkflowDef();
  await engine.createDefinition(def);

  info('\nStarting workflow — engine will invoke the supervisor when it hits the dynamic step...');
  const run = await engine.startRun(def.id, {
    tickers: ['AAPL', 'MSFT', 'GOOGL'],
    goal: 'analyze portfolio risk and generate a report',
  });

  console.log('');
  ok(`Run status: ${run.status}`);
  if (run.error) warn(`Run error: ${run.error}`);
  ok(`Dynamic steps spliced: ${run.dynamicSteps?.length} (${run.dynamicSteps?.map(s => `${s.id}(${s.handler})`).join(' → ')})`);
  ok(`Expansion depth: ${run.expansionDepth}`);

  const final = run.state.variables['__step_finalize'] as { summary?: string } | undefined;
  ok(`Final summary: "${final?.summary ?? '(none)'}"`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. Bad handler name — rejected by plan_expansion tool before engine runs
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoBadHandlerRejection() {
  header('3. Safety — Bad Handler Name Caught by plan_expansion Tool');

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    const agentCtx = weaveContext({ userId: 'bad-agent-session' });
    await supervisor.run(agentCtx, {
      messages: [{ role: 'user', content: `Plan something for: ${goal}` }],
    });
    if (!capturedExpansion) throw new Error('No plan submitted');
    const result = capturedExpansion;
    capturedExpansion = null;
    return result;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });
  registerDomainHandlers(engine);

  const agentTools = buildAgentTools(reg, exp => { capturedExpansion = exp; });

  // This agent skips list_handlers and uses a made-up handler name
  const badModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'tc-bad',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [{ id: 's1', name: 'Mystery Step', type: 'deterministic', handler: 'made-up-handler' }],
              entry: 's1',
              rejoin: 'finalize',
            }),
          },
        }],
      },
      { content: 'I submitted a plan with made-up-handler.', toolCalls: [] },
    ],
  });

  supervisor = weaveAgent({
    name: 'bad-supervisor',
    model: badModel,
    tools: agentTools,
    systemPrompt: 'Submit workflow plans.',
    maxSteps: 4,
  } satisfies ToolCallingAgentOptions);

  const def = buildWorkflowDef();
  await engine.createDefinition(def);

  // The engine will invoke the supervisor via plannerFn.
  // The supervisor calls plan_expansion with a bad name → tool rejects it → no plan stored.
  // plannerFn throws "No plan submitted" → failRun.
  const run = await engine.startRun(def.id, { tickers: ['AAPL'] });

  ok(`Run status: ${run.status} (expected: failed)`);
  ok(`Error: "${run.error?.slice(0, 80)}"`);
  ok('Bad handler name was caught by the tool before the engine ever saw the plan');
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. Script injection — engine's validateExpansion blocks it
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoScriptInjection() {
  header('4. Safety — script: Injection Blocked by Engine Governance');

  // Here the tool is permissive (no pre-check on handler names).
  // The engine's validateExpansion is the last line of defence.
  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    const agentCtx = weaveContext({ userId: 'injector-session' });
    await supervisor.run(agentCtx, {
      messages: [{ role: 'user', content: `Plan something for: ${goal}` }],
    });
    if (!capturedExpansion) throw new Error('No plan submitted');
    const result = capturedExpansion;
    capturedExpansion = null;
    return result;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  // Policy: script: is NOT in the dynamic handler-kind allowlist
  const engine = new DefaultWorkflowEngine({
    resolverRegistry: reg,
    defaultPolicy: { dynamicHandlerKinds: ['noop', 'tool', 'prompt', 'agent', 'mcp'] },
  });
  registerDomainHandlers(engine);

  // Permissive tool — accepts anything, stores it for the engine to validate
  const tools = weaveToolRegistry();
  tools.register(weaveTool({
    name: 'plan_expansion',
    description: 'Submit a plan (permissive — engine validates it).',
    parameters: {
      type: 'object', required: ['steps', 'entry'],
      properties: {
        steps: { type: 'array', items: { type: 'object' } },
        entry: { type: 'string' }, rejoin: { type: 'string' },
      },
    },
    execute: async (args: { steps: Array<{ id: string; name: string; type: string; handler: string }>; entry: string; rejoin?: string }) => {
      capturedExpansion = {
        steps: args.steps.map(s => ({ id: s.id, name: s.name, type: 'deterministic' as const, handler: s.handler })),
        entry: args.entry,
        rejoin: args.rejoin ?? 'finalize',
      };
      warn(`    plan_expansion (permissive): accepted step with handler="${args.steps[0]?.handler}"`);
      return JSON.stringify({ accepted: true });
    },
  }));

  const injectorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{
          id: 'tc-inject',
          function: {
            name: 'plan_expansion',
            arguments: JSON.stringify({
              steps: [{ id: 'evil', name: 'Evil Step', type: 'deterministic', handler: 'script:return process.env.SECRET' }],
              entry: 'evil',
              rejoin: 'finalize',
            }),
          },
        }],
      },
      { content: 'Plan submitted with script injection.', toolCalls: [] },
    ],
  });

  supervisor = weaveAgent({
    name: 'injector',
    model: injectorModel,
    tools,
    systemPrompt: 'Submit plans.',
    maxSteps: 4,
  } satisfies ToolCallingAgentOptions);

  const def = buildWorkflowDef();
  await engine.createDefinition(def);
  const run = await engine.startRun(def.id, { tickers: ['AAPL'] });

  if (run.status === 'failed' && run.error?.includes('DISALLOWED_HANDLER_KIND')) {
    ok(`Engine blocked script: injection — code: DISALLOWED_HANDLER_KIND`);
    ok(`Error: "${run.error.slice(0, 80)}..."`);
  } else {
    warn(`Unexpected: status=${run.status} error=${run.error}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. Real LLM — Claude generates the plan live
   ═══════════════════════════════════════════════════════════════════════════ */

async function demoRealAgent() {
  header('5. Real Claude Supervisor (ANTHROPIC_API_KEY required)');

  if (!process.env['ANTHROPIC_API_KEY']) {
    info('Skipped — set ANTHROPIC_API_KEY to run this section.');
    return;
  }

  let capturedExpansion: DynamicExpansion | null = null;
  let supervisor!: ReturnType<typeof weaveAgent>;

  const plannerFn = async (goal: string): Promise<DynamicExpansion> => {
    info(`\n    plannerFn: invoking real Claude supervisor for goal="${goal}"`);
    const agentCtx = weaveContext({ userId: 'real-planner-session' });
    const agentResult = await supervisor.run(agentCtx, {
      messages: [{
        role: 'user',
        content:
          `You are planning a workflow. Goal: "${goal}".\n` +
          `1. Call list_handlers to see available step handlers.\n` +
          `2. Call plan_expansion with 2–4 steps using only handler names from list_handlers.\n` +
          `3. Set rejoin to "finalize" in plan_expansion.\n` +
          `4. Confirm what you submitted.`,
      }],
    });

    info(`    Agent completed in ${agentResult.steps.length} turns:`);
    for (const s of agentResult.steps) {
      if (s.toolCall) {
        const args = JSON.stringify(s.toolCall.arguments).slice(0, 100);
        info(`      [tool] ${s.toolCall.name}(${args}${args.length >= 100 ? '...' : ''})`);
      }
    }
    info(`    Agent output: "${agentResult.output.slice(0, 160)}"`);

    if (!capturedExpansion) throw new Error('Claude did not submit a plan');
    const result = capturedExpansion;
    capturedExpansion = null;
    return result;
  };

  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createPlannerResolver({ plan: plannerFn }));

  const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });
  registerDomainHandlers(engine);

  const agentTools = buildAgentTools(reg, exp => { capturedExpansion = exp; });

  try {
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    const model = weaveAnthropicModel('claude-haiku-4-5-20251001');

    supervisor = weaveAgent({
      name: 'real-workflow-supervisor',
      model,
      tools: agentTools,
      systemPrompt:
        'You are a workflow planning supervisor.\n' +
        '1. ALWAYS call list_handlers first.\n' +
        '2. Call plan_expansion using ONLY names from list_handlers.\n' +
        '3. Set rejoin to "finalize".\n' +
        '4. Confirm what you submitted.',
      maxSteps: 8,
    } satisfies ToolCallingAgentOptions);

    const def = buildWorkflowDef();
    await engine.createDefinition(def);

    info('Starting workflow — engine will invoke real Claude when it hits the dynamic step...');
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
  } catch (e) {
    warn(`Real agent error: ${(e as Error).message}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   main
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('\n@weaveintel/workflows — Phase W7: Supervisor Agent + Dynamic Workflow');
  console.log('Sections 1–4: no API key needed. Section 5: needs ANTHROPIC_API_KEY.\n');

  await demoListHandlers();
  await demoFakeAgent();
  await demoBadHandlerRejection();
  await demoScriptInjection();
  await demoRealAgent();

  console.log('\n' + '═'.repeat(64));
  console.log('  All demos complete.');
  console.log('═'.repeat(64) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
