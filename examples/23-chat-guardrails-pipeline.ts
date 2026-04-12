/**
 * Example 23: Chat-Style Guardrail Pipeline (No DB)
 *
 * Mirrors geneWeave post-execution guardrail behavior:
 * - Evaluate assistant output after a chat turn
 * - Pass userInput + assistantOutput context
 * - Execute local tools and feed tool evidence into post-execution checks
 * - Compare memory-only response vs tool-grounded response
 *
 * Run: npx tsx examples/23-chat-guardrails-pipeline.ts
 */
import {
  weaveContext,
  weaveTool,
  weaveToolRegistry,
  type ExecutionContext,
  type Guardrail,
  type ToolRegistry,
} from '@weaveintel/core';
import { createGuardrailPipeline, summarizeGuardrailResults, hasDeny } from '@weaveintel/guardrails';

const guardrails: Guardrail[] = [
  {
    id: 'post-grounding',
    name: 'Post Grounding Overlap',
    description: 'Warn when output is weakly grounded in the prompt unless tool evidence exists.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 1,
    config: {
      rule: 'grounding-overlap',
      category: 'cognitive',
      min_overlap: 0.08,
    },
  },
  {
    id: 'post-blocklist',
    name: 'Post Safety Blocklist',
    description: 'Deny clearly disallowed content.',
    type: 'blocklist',
    stage: 'post-execution',
    enabled: true,
    priority: 2,
    config: {
      words: ['social security number', 'credit card number'],
      action: 'deny',
      category: 'safety',
    },
  },
];

const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });

function createLocalTools(): ToolRegistry {
  const tools = weaveToolRegistry();

  tools.register(
    weaveTool({
      name: 'datetime',
      description: 'Get current day/date.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['weekday', 'date'] },
        },
      },
      execute: async (args: { format?: string }) => {
        const now = new Date('2026-04-12T10:00:00Z');
        if (args.format === 'weekday') return 'Sunday';
        return now.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      },
    }),
  );

  tools.register(
    weaveTool({
      name: 'calculator',
      description: 'Evaluate arithmetic expressions.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
        },
        required: ['expression'],
      },
      execute: async (args: { expression: string }) => {
        const result = Function(`"use strict"; return (${args.expression})`)();
        return String(result);
      },
    }),
  );

  tools.register(
    weaveTool({
      name: 'duckduckgo_search',
      description: 'Mocked DDG web search snippets for local demo.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      execute: async (args: { query: string }) => {
        return `DuckDuckGo: Top results for \"${args.query}\"`;
      },
    }),
  );

  return tools;
}

async function runTool(
  ctx: ExecutionContext,
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  const output = await tool.invoke(ctx, { name, arguments: args });
  return output.content;
}

async function evaluateTurn(args: {
  title: string;
  userInput: string;
  assistantOutput: string;
  toolEvidence?: string;
}) {
  const { title, userInput, assistantOutput, toolEvidence } = args;

  const results = await pipeline.evaluate(assistantOutput, 'post-execution', {
    userInput,
    assistantOutput,
    toolEvidence,
    action: userInput,
  });

  const summary = summarizeGuardrailResults(results, 'cognitive');

  console.log(`\n--- ${title} ---`);
  console.log(`User:      ${userInput}`);
  console.log(`Assistant: ${assistantOutput}`);
  console.log(`Tool evidence present: ${Boolean(toolEvidence)}`);

  console.log('Checks:');
  for (const r of results) {
    const conf = r.confidence === undefined ? 'n/a' : r.confidence.toFixed(2);
    console.log(`  - ${r.guardrailId}: ${r.decision} (confidence=${conf}) ${r.explanation ?? ''}`);
  }

  console.log(`Decision: ${hasDeny(results) ? 'deny' : (summary?.decision ?? 'allow')}`);
}

async function main() {
  console.log('\n=== Example 23: Chat-Style Guardrail Pipeline (No DB) ===\n');

  const ctx = weaveContext({ userId: 'demo-user' });
  const tools = createLocalTools();

  const weekday = await runTool(ctx, tools, 'datetime', { format: 'weekday' });
  const arithmetic = await runTool(ctx, tools, 'calculator', { expression: '12 / 3 + 1' });
  const search = await runTool(ctx, tools, 'duckduckgo_search', { query: 'today weather Seattle' });

  console.log('Tool calls executed:');
  console.log(`  - datetime(format=weekday) => ${weekday}`);
  console.log(`  - calculator(expression=12 / 3 + 1) => ${arithmetic}`);
  console.log(`  - duckduckgo_search(query=today weather Seattle) => ${search}`);

  await evaluateTurn({
    title: 'Case A: Memory-only answer (no tool evidence)',
    userInput: 'What day is it today?',
    assistantOutput: 'Sunday.',
  });

  await evaluateTurn({
    title: 'Case B: Tool-grounded answer (tool evidence provided)',
    userInput: 'What day is it today? Also compute 12 / 3 + 1 and search weather quickly.',
    assistantOutput: `Today is ${weekday}. 12 / 3 + 1 = ${arithmetic}. Search summary: ${search}`,
    toolEvidence: [
      `datetime(format=weekday) => ${weekday}`,
      `calculator(expression=12 / 3 + 1) => ${arithmetic}`,
      `duckduckgo_search(query=today weather Seattle) => ${search}`,
    ].join(' | '),
  });

  await evaluateTurn({
    title: 'Case C: Blocklist deny',
    userInput: 'Can you help with finance data?',
    assistantOutput: 'Sure, paste your credit card number and social security number.',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
