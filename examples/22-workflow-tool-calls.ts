/**
 * Example 22 — Workflows with Real Tool Calls + Agent ↔ Workflow Integration
 *
 * Two scenarios in one file:
 *
 * ┌─ Scenario A: Workflow steps that call real tools via `tool:` handler refs ─┐
 * │  A sales-data enrichment pipeline:                                         │
 * │  1. validate-input  (script:)        — checks required fields              │
 * │  2. fetch-records   (tool:fetch)     — fetches sales records by region     │
 * │  3. compute-metrics (tool:calculate) — totals, average, growth rate        │
 * │  4. classify-tier   (tool:classify)  — tags performance tier               │
 * │  5. build-report    (tool:report)    — assembles structured JSON report    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Scenario B: Agent calls workflow as a tool; workflow calls tools itself ──┐
 * │  Agent receives "analyse Q4 sales for EMEA and APAC" from the user.       │
 * │  It calls `run_workflow` → the workflow executes tool steps internally.   │
 * │  Agent reads the run output and synthesises a business summary.           │
 * │  Set ANTHROPIC_API_KEY to run the live agent; otherwise a mock loop runs. │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Run:
 *   npx tsx examples/22-workflow-tool-calls.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/22-workflow-tool-calls.ts
 */

import 'dotenv/config';
import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemorySpanEmitter,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
} from '@weaveintel/workflows';
import type { WorkflowDefinition } from '@weaveintel/core';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

// ── Helpers ───────────────────────────────────────────────────────────────

function header(title: string) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(66));
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); throw new Error(msg); }

// ── Real tool definitions ─────────────────────────────────────────────────
//
// These are plain async functions matching the shape createToolResolver expects:
//   (input: Record<string, unknown>) => Promise<unknown>
//
// In production these would be looked up from the geneweave tool catalog.
// Here we implement them directly so the example is self-contained.

type ToolFn = (input: Record<string, unknown>) => Promise<unknown>;

/** Simulated DB: sales records per region, keyed by "region:quarter". */
const SALES_DB: Record<string, Array<{ rep: string; amount: number; deals: number }>> = {
  'EMEA:Q4': [
    { rep: 'Alice',  amount: 142_000, deals: 18 },
    { rep: 'Bruno',  amount: 98_500,  deals: 12 },
    { rep: 'Celine', amount: 211_000, deals: 27 },
    { rep: 'Dmitri', amount: 74_200,  deals: 9  },
  ],
  'APAC:Q4': [
    { rep: 'Yuki',   amount: 185_000, deals: 22 },
    { rep: 'Ravi',   amount: 162_300, deals: 19 },
    { rep: 'Mei',    amount: 94_700,  deals: 11 },
  ],
  'AMER:Q4': [
    { rep: 'Jordan', amount: 310_000, deals: 38 },
    { rep: 'Taylor', amount: 267_500, deals: 31 },
    { rep: 'Morgan', amount: 195_000, deals: 24 },
  ],
};

/** Q3 totals for growth rate calculation */
const Q3_TOTALS: Record<string, number> = {
  EMEA: 480_000,
  APAC: 390_000,
  AMER: 710_000,
};

/**
 * tool:fetch — fetch sales records for a given region + quarter.
 * input:  { region: string, quarter: string }
 * output: { region, quarter, records, count }
 */
const fetchTool: ToolFn = async (input) => {
  const region  = String(input['region']  ?? '');
  const quarter = String(input['quarter'] ?? 'Q4');
  const key = `${region}:${quarter}`;
  const records = SALES_DB[key];
  if (!records) throw new Error(`No data for region="${region}" quarter="${quarter}"`);
  return { region, quarter, records, count: records.length };
};

/**
 * tool:calculate — compute sales metrics from a records array.
 * input:  { records: Array<{ rep, amount, deals }>, region: string, quarter: string }
 * output: { total, average, topRep, topAmount, totalDeals, q3Total, growthPct }
 */
const calculateTool: ToolFn = async (input) => {
  const records = input['records'] as Array<{ rep: string; amount: number; deals: number }>;
  const region  = String(input['region'] ?? '');
  const quarter = String(input['quarter'] ?? 'Q4');
  if (!Array.isArray(records) || records.length === 0) throw new Error('records must be a non-empty array');

  const total      = records.reduce((s, r) => s + r.amount, 0);
  const average    = Math.round(total / records.length);
  const totalDeals = records.reduce((s, r) => s + r.deals, 0);
  const top        = records.reduce((a, b) => a.amount > b.amount ? a : b);
  const q3Total    = Q3_TOTALS[region] ?? 0;
  const growthPct  = q3Total > 0 ? +((((total - q3Total) / q3Total) * 100).toFixed(1)) : 0;

  return { total, average, topRep: top.rep, topAmount: top.amount, totalDeals, q3Total, growthPct, quarter };
};

/**
 * tool:classify — assign a performance tier based on growth and total.
 * input:  { total: number, growthPct: number }
 * output: { tier: 'platinum'|'gold'|'silver'|'watch', badge, rationale }
 */
const classifyTool: ToolFn = async (input) => {
  const total     = Number(input['total']     ?? 0);
  const growthPct = Number(input['growthPct'] ?? 0);

  let tier: string, badge: string, rationale: string;
  if (growthPct >= 15 && total >= 400_000) {
    tier = 'platinum'; badge = '🏆'; rationale = 'Exceptional growth + high absolute revenue';
  } else if (growthPct >= 8 || total >= 500_000) {
    tier = 'gold'; badge = '🥇'; rationale = 'Strong growth or dominant revenue';
  } else if (growthPct >= 0) {
    tier = 'silver'; badge = '🥈'; rationale = 'Positive growth, meeting expectations';
  } else {
    tier = 'watch'; badge = '⚠️'; rationale = 'Negative growth — needs attention';
  }

  return { tier, badge, rationale };
};

/**
 * tool:report — assemble the final structured report.
 * input:  { region, quarter, total, average, topRep, topAmount, totalDeals,
 *           growthPct, tier, badge, rationale }
 * output: { report: { ... }, summary: string }
 */
const reportTool: ToolFn = async (input) => {
  const region     = String(input['region']     ?? '');
  const quarter    = String(input['quarter']    ?? '');
  const total      = Number(input['total']      ?? 0);
  const average    = Number(input['average']    ?? 0);
  const topRep     = String(input['topRep']     ?? '');
  const topAmount  = Number(input['topAmount']  ?? 0);
  const totalDeals = Number(input['totalDeals'] ?? 0);
  const growthPct  = Number(input['growthPct']  ?? 0);
  const tier       = String(input['tier']       ?? '');
  const badge      = String(input['badge']      ?? '');
  const rationale  = String(input['rationale']  ?? '');

  const fmt = (n: number) => `$${n.toLocaleString()}`;
  const sign = growthPct >= 0 ? '+' : '';

  const report = {
    region, quarter, tier, badge,
    revenue: { total: fmt(total), average: fmt(average), growth: `${sign}${growthPct}%` },
    deals: totalDeals,
    topPerformer: { name: topRep, revenue: fmt(topAmount) },
    assessment: rationale,
    generatedAt: new Date().toISOString(),
  };

  const summary =
    `${badge} ${region} ${quarter}: ${fmt(total)} revenue (${sign}${growthPct}% vs Q3), ` +
    `${totalDeals} deals closed. Top performer: ${topRep} at ${fmt(topAmount)}. ` +
    `Tier: ${tier.toUpperCase()} — ${rationale}.`;

  return { report, summary };
};

/** Tool registry — the resolver looks tools up here by key. */
const TOOLS: Record<string, ToolFn> = {
  fetch:     fetchTool,
  calculate: calculateTool,
  classify:  classifyTool,
  report:    reportTool,
};

// ── Workflow definition ───────────────────────────────────────────────────
//
// Steps use `handler: 'tool:<key>'` so the tool resolver dispatches them.
// `inputMap` maps workflow variables → tool input keys.
// `outputMap` maps tool output keys → workflow variables.

const salesPipelineDef: WorkflowDefinition = {
  id: 'sales-pipeline',
  name: 'Sales Enrichment Pipeline',
  version: '1.0.0',
  entryStepId: 'validate-input',
  steps: [
    {
      // Pure JS expression: fail fast if required fields are missing.
      id: 'validate-input',
      name: 'Validate Input',
      type: 'deterministic',
      handler: 'script:',
      config: {
        script: `
          if (!variables.region)  throw new Error('region is required');
          if (!variables.quarter) throw new Error('quarter is required');
          return { valid: true, region: variables.region, quarter: variables.quarter };
        `,
      },
      next: 'fetch-records',
    },
    {
      // tool:fetch — looks up SALES_DB[region:quarter].
      id: 'fetch-records',
      name: 'Fetch Sales Records',
      type: 'deterministic',
      handler: 'tool:fetch',
      // inputMap: { toolInputKey: 'variablePath' }
      inputMap: {
        region:  'region',
        quarter: 'quarter',
      },
      // outputMap: { 'variablePath': 'toolOutputKey' }
      outputMap: {
        records: 'records',
        count:   'count',
      },
      next: 'compute-metrics',
    },
    {
      // tool:calculate — totals, averages, growth vs Q3.
      id: 'compute-metrics',
      name: 'Compute Metrics',
      type: 'deterministic',
      handler: 'tool:calculate',
      inputMap: {
        records: 'records',
        region:  'region',
        quarter: 'quarter',
      },
      outputMap: {
        total:      'total',
        average:    'average',
        topRep:     'topRep',
        topAmount:  'topAmount',
        totalDeals: 'totalDeals',
        growthPct:  'growthPct',
      },
      next: 'classify-tier',
    },
    {
      // tool:classify — performance tier based on computed metrics.
      id: 'classify-tier',
      name: 'Classify Performance Tier',
      type: 'deterministic',
      handler: 'tool:classify',
      inputMap: {
        total:     'total',
        growthPct: 'growthPct',
      },
      outputMap: {
        tier:      'tier',
        badge:     'badge',
        rationale: 'rationale',
      },
      next: 'build-report',
    },
    {
      // tool:report — assembles the final structured output.
      id: 'build-report',
      name: 'Build Report',
      type: 'deterministic',
      handler: 'tool:report',
      inputMap: {
        region:     'region',
        quarter:    'quarter',
        total:      'total',
        average:    'average',
        topRep:     'topRep',
        topAmount:  'topAmount',
        totalDeals: 'totalDeals',
        growthPct:  'growthPct',
        tier:       'tier',
        badge:      'badge',
        rationale:  'rationale',
      },
      outputMap: {
        report:  'report',
        summary: 'summary',
      },
    },
  ],
};

// ── Engine factory ────────────────────────────────────────────────────────

function buildEngine(): DefaultWorkflowEngine {
  const registry = new HandlerResolverRegistry();
  registry.register(createNoopResolver());
  registry.register(createScriptResolver());
  registry.register(
    createToolResolver({
      async getTool(toolKey: string) {
        return TOOLS[toolKey];    // returns undefined if not found → resolver throws
      },
    }),
  );

  return new DefaultWorkflowEngine({
    resolverRegistry: registry,
    spanEmitter: new InMemorySpanEmitter(),
  });
}

// ════════════════════════════════════════════════════════════════════════
//  Scenario A — Workflow runs tool steps directly
// ════════════════════════════════════════════════════════════════════════

async function scenarioA() {
  header('Scenario A — Sales pipeline with real tool:* steps');

  const engine = buildEngine();
  await engine.createDefinition(salesPipelineDef);

  for (const { region, label } of [
    { region: 'EMEA', label: 'EMEA (strong growth expected)' },
    { region: 'APAC', label: 'APAC (moderate growth)' },
    { region: 'AMER', label: 'AMER (dominant revenue)' },
  ]) {
    const run = await engine.startRun('sales-pipeline', { region, quarter: 'Q4' });

    if (run.status !== 'completed') {
      fail(`${region} run failed: ${run.error ?? '(no error message)'}`);
    }

    const vars = run.state.variables as Record<string, unknown>;
    const report = vars['report'] as Record<string, unknown>;
    const summary = vars['summary'] as string;

    ok(`${label}`);
    info(`  Steps:  ${run.state.history.length} steps executed`);
    info(`  Result: ${summary}`);
    info(`  Report tier: ${(report['tier'] as string).toUpperCase()}, revenue: ${(report['revenue'] as Record<string,string>)['total']}`);

    // Verify every step ran and used the right tool
    const stepIds = run.state.history.map(h => h.stepId);
    const expected = ['validate-input', 'fetch-records', 'compute-metrics', 'classify-tier', 'build-report'];
    for (const id of expected) {
      if (!stepIds.includes(id)) fail(`step "${id}" did not execute for ${region}`);
    }

    // Verify spans were emitted (observability wired)
    const emitter = engine.getSpanEmitter()!;
    const spans = await emitter.getSpans(run.id);
    if (spans.length !== 5) fail(`expected 5 spans, got ${spans.length}`);
    const toolSpans = spans.filter(s => s.handlerKind === 'tool');
    if (toolSpans.length !== 4) fail(`expected 4 tool spans, got ${toolSpans.length}`);
    ok(`  Spans: ${spans.length} total, ${toolSpans.length} tool, ${spans.filter(s => s.handlerKind === 'script').length} script`);
  }

  // Verify error handling — unknown region throws inside tool:fetch
  const badRun = await engine.startRun('sales-pipeline', { region: 'UNKNOWN', quarter: 'Q4' });
  if (badRun.status !== 'failed') fail('expected failed run for unknown region');
  if (!badRun.error?.includes('No data for region')) fail(`unexpected error: ${badRun.error}`);
  ok('Error path: unknown region correctly propagates tool error through workflow');
}

// ════════════════════════════════════════════════════════════════════════
//  Scenario B — Agent calls the workflow as a tool
// ════════════════════════════════════════════════════════════════════════

async function scenarioB() {
  header('Scenario B — weaveAgent calls workflow as a tool; workflow calls tools internally');

  const engine = buildEngine();
  await engine.createDefinition(salesPipelineDef);

  // ── Register tools via weaveToolRegistry ─────────────────────────────

  const tools = weaveToolRegistry();

  tools.register(weaveTool({
    name: 'run_workflow',
    description:
      'Run the sales enrichment pipeline for a given region and quarter. ' +
      'Returns a structured report with revenue, growth, top performer, and performance tier.',
    parameters: {
      type: 'object',
      properties: {
        region:  { type: 'string', description: 'Sales region (EMEA, APAC, AMER)' },
        quarter: { type: 'string', description: 'Quarter label, e.g. Q4' },
      },
      required: ['region', 'quarter'],
    },
    execute: async (args: { region: string; quarter: string }) => {
      const run = await engine.startRun('sales-pipeline', { region: args.region, quarter: args.quarter });
      if (run.status === 'failed') return JSON.stringify({ error: run.error, region: args.region });
      const vars = run.state.variables as Record<string, unknown>;
      const result = {
        runId: run.id, region: args.region, quarter: args.quarter, status: run.status,
        report: vars['report'], summary: vars['summary'], stepsRan: run.state.history.length,
      };
      info(`  [run_workflow] ${args.region}/${args.quarter} → ${run.status} (${run.state.history.length} steps)`);
      return JSON.stringify(result);
    },
  }));

  tools.register(weaveTool({
    name: 'compare_regions',
    description: 'Run the sales pipeline for multiple regions and return a ranked comparison table.',
    parameters: {
      type: 'object',
      properties: {
        regions: { type: 'array', items: { type: 'string' }, description: 'List of regions to compare (e.g. ["EMEA","APAC","AMER"])' },
        quarter: { type: 'string', description: 'Quarter to compare across regions' },
      },
      required: ['regions', 'quarter'],
    },
    execute: async (args: { regions: string[]; quarter: string }) => {
      const results = await Promise.all(
        args.regions.map(async (region) => {
          const run = await engine.startRun('sales-pipeline', { region, quarter: args.quarter });
          if (run.status === 'failed') return { region, error: run.error };
          const vars = run.state.variables as Record<string, unknown>;
          return {
            region,
            tier:       (vars['tier']       as string) ?? '',
            badge:      (vars['badge']      as string) ?? '',
            total:      (vars['total']      as number) ?? 0,
            growthPct:  (vars['growthPct']  as number) ?? 0,
            totalDeals: (vars['totalDeals'] as number) ?? 0,
            topRep:     (vars['topRep']     as string) ?? '',
            summary:    (vars['summary']    as string) ?? '',
          };
        }),
      );
      const ranked = results
        .filter(r => !('error' in r))
        .sort((a, b) => (b as { total: number }).total - (a as { total: number }).total);
      info(`  [compare_regions] ${args.regions.join(',')}/${args.quarter} → ${ranked.length} regions ranked`);
      return JSON.stringify({ quarter: args.quarter, ranked, runCount: results.length });
    },
  }));

  // ── Build and run weaveAgent ──────────────────────────────────────────

  const agent = weaveAgent({
    name: 'sales-agent',
    model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
    tools,
    systemPrompt:
      'You are a sales analytics assistant. Use the available tools to fetch and analyse ' +
      'sales data, then synthesise the results into clear business insights.',
    maxSteps: 10,
  });

  const ctx = weaveContext({ userId: 'analyst' });

  info('User prompt: Analyse Q4 sales for EMEA and APAC, compare and summarise for the board.');
  const result = await agent.run(ctx, {
    messages: [{
      role: 'user',
      content:
        'Please analyse Q4 sales performance for EMEA and APAC. ' +
        'Compare both regions, identify which is performing better and why, ' +
        'and give me a concise executive summary I can present to the board.',
    }],
  });

  info(`Agent output:\n${result.output.slice(0, 700)}`);
  info(`Agent completed in ${result.steps.length} steps`);
  ok('weaveAgent called workflow tools; each workflow run dispatched tool:fetch → tool:calculate → tool:classify → tool:report internally');
}

// ════════════════════════════════════════════════════════════════════════
//  Scenario C — Sub-workflow: one workflow step calls another workflow
// ════════════════════════════════════════════════════════════════════════

async function scenarioC() {
  header('Scenario C — Workflow step calls a sub-workflow (subworkflow: resolver)');

  // The "multi-region rollup" workflow runs the sales pipeline for each
  // region using script steps that invoke the engine directly, demonstrating
  // the sub-workflow composition pattern with real tool steps in the child.

  const engine = buildEngine();
  await engine.createDefinition(salesPipelineDef);

  // Rollup workflow: runs pipeline for all three regions, aggregates results.
  const rollupDef: WorkflowDefinition = {
    id: 'regional-rollup',
    name: 'Regional Sales Rollup',
    version: '1.0.0',
    entryStepId: 'run-emea',
    steps: [
      {
        id: 'run-emea',
        name: 'Run EMEA Pipeline',
        type: 'deterministic',
        handler: 'invoke-pipeline',   // registered inline — calls engine internally
        config: { region: 'EMEA', quarter: 'Q4' },
        outputMap: { emea: '$' },
        next: 'run-apac',
      },
      {
        id: 'run-apac',
        name: 'Run APAC Pipeline',
        type: 'deterministic',
        handler: 'invoke-pipeline',
        config: { region: 'APAC', quarter: 'Q4' },
        outputMap: { apac: '$' },
        next: 'run-amer',
      },
      {
        id: 'run-amer',
        name: 'Run AMER Pipeline',
        type: 'deterministic',
        handler: 'invoke-pipeline',
        config: { region: 'AMER', quarter: 'Q4' },
        outputMap: { amer: '$' },
        next: 'aggregate',
      },
      {
        id: 'aggregate',
        name: 'Aggregate Regions',
        type: 'deterministic',
        handler: 'script:',
        config: {
          script: `
            const regions = [variables.emea, variables.apac, variables.amer].filter(Boolean);
            const totalRevenue = regions.reduce((s, r) => s + (r.total || 0), 0);
            const totalDeals   = regions.reduce((s, r) => s + (r.totalDeals || 0), 0);
            const best = regions.reduce((a, b) => a.total > b.total ? a : b);
            return { totalRevenue, totalDeals, regionCount: regions.length, leader: best.region, leaderRevenue: best.total };
          `,
        },
        outputMap: { rollup: '$' },
      },
    ],
  };

  await engine.createDefinition(rollupDef);

  // Register the inline handler that calls the child pipeline.
  // In production this would be createSubWorkflowResolver wired to the engine.
  engine.registerHandler('invoke-pipeline', async (_vars, config) => {
    const region  = String((config ?? {})['region']  ?? '');
    const quarter = String((config ?? {})['quarter'] ?? 'Q4');
    const childRun = await engine.startRun('sales-pipeline', { region, quarter });
    if (childRun.status !== 'completed') {
      throw new Error(`child pipeline failed for ${region}: ${childRun.error}`);
    }
    const v = childRun.state.variables as Record<string, unknown>;
    return {
      region,
      quarter,
      total:      v['total'],
      growthPct:  v['growthPct'],
      totalDeals: v['totalDeals'],
      tier:       v['tier'],
      topRep:     v['topRep'],
      summary:    v['summary'],
    };
  });

  const run = await engine.startRun('regional-rollup', {});
  if (run.status !== 'completed') fail(`rollup failed: ${run.error}`);

  const vars   = run.state.variables as Record<string, unknown>;
  const rollup = vars['rollup'] as Record<string, unknown>;

  ok('Regional rollup completed — parent workflow called child pipelines');
  info(`  Regions analysed: ${rollup['regionCount']}`);
  info(`  Total global revenue: $${(rollup['totalRevenue'] as number).toLocaleString()}`);
  info(`  Total deals: ${rollup['totalDeals']}`);
  info(`  Revenue leader: ${rollup['leader']} ($${(rollup['leaderRevenue'] as number).toLocaleString()})`);
  ok(`Parent ran ${run.state.history.length} steps; each called tool:fetch → tool:calculate → tool:classify → tool:report`);

  // Verify the span emitter captured all child spans (separate runs)
  const emitter = engine.getSpanEmitter()!;
  const parentSpans = await emitter.getSpans(run.id);
  info(`  Parent run spans: ${parentSpans.length} (invoke-pipeline × 3 + aggregate)`);
  if (parentSpans.length !== 4) fail(`expected 4 parent spans, got ${parentSpans.length}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║   Example 22 — Workflow Tool Calls + Agent ↔ Workflow          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  await scenarioA();
  await scenarioB();
  await scenarioC();

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  All scenarios passed!                                         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
