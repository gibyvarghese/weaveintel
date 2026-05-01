/**
 * Example 37 — Skills runtime end-to-end with a REAL LLM agent.
 *
 * Wires the skills runtime to an actual model + tool-calling agent.
 * No GeneWeave / DB / server — just packages.
 *
 * Flow:
 *   1. Build a SkillDefinition with a completionContract requiring evidence.
 *   2. Activate the skill against the user query (semantic match).
 *   3. Compose system prompt via applySkillsToPrompt().
 *   4. Build a tool-calling agent with the calculator tool the skill names.
 *   5. Run the agent against a real OpenAI model.
 *   6. Validate:
 *        - the agent actually called the calculator tool (skill→tool wiring),
 *        - the model output satisfies the completion contract,
 *        - lifecycle hooks fired during activation.
 *
 * Requires: OPENAI_API_KEY in .env (Anthropic fallback if you swap providers).
 * Run: `npx tsx examples/37-skills-with-real-llm.ts`
 */

import 'dotenv/config';
import assert from 'node:assert/strict';

import {
  weaveContext,
  weaveEventBus,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';
import {
  activateSkills,
  applySkillsToPrompt,
  collectSkillTools,
  evaluateSkillCompletion,
  type SkillActivationResult,
  type SkillDefinition,
  type SkillLifecycleHooks,
} from '@weaveintel/skills';

const PASS = '\u001b[32m✓\u001b[0m';
const FAIL = '\u001b[31m✗\u001b[0m';
const INFO = '\u001b[36mℹ\u001b[0m';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}
function ok(label: string): void {
  console.log(`  ${PASS} ${label}`);
}
function info(label: string): void {
  console.log(`  ${INFO} ${label}`);
}

const mathSkill: SkillDefinition = {
  id: 'math-canary',
  name: 'Arithmetic Verifier',
  category: 'analysis',
  summary:
    'Performs deterministic arithmetic verification by calling the calculator tool and reporting the numeric result.',
  whenToUse:
    'Use when the user asks for arithmetic, sums, products, or numeric verification of an expression.',
  executionGuidance:
    'You MUST call the `calculator` tool with the normalized expression. Do not compute mentally. After the tool returns, state the answer in the form: "The result is <number>."',
  toolNames: ['calculator'],
  triggerPatterns: ['arithmetic', 'calculate', 'compute', 'multiply', 'product'],
  completionContract: {
    narrative: 'Final answer must include the literal token "result" and the numeric value.',
    requiredEvidence: ['result'],
  },
  policy: {
    allowedTools: ['calculator'],
    disallowedTools: ['shell'],
  },
  priority: 100,
};

async function main(): Promise<void> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error(`${FAIL} OPENAI_API_KEY not set — cannot run real LLM example.`);
    process.exit(1);
  }

  console.log('Skills + REAL LLM end-to-end\n');
  const userQuery = 'Please compute 17 * 23 using arithmetic verification.';

  // ── 1. Skill activation ──────────────────────────────────────────────────
  section('1. Activate skill against user query');
  let activationHookCalls = 0;
  const hooks: SkillLifecycleHooks = {
    onActivation: () => {
      activationHookCalls += 1;
    },
  };
  const activation: SkillActivationResult = await activateSkills(
    userQuery,
    [mathSkill],
    { mode: 'tool_assisted', hooks },
  );
  assert.equal(activation.selected.length, 1, 'one skill selected');
  assert.equal(activation.selected[0]?.skill.id, 'math-canary');
  assert.equal(activationHookCalls, 1, 'onActivation hook fired');
  ok(`activation.selected[0].skill.id = "${activation.selected[0]?.skill.id}"`);
  ok(`semantic score = ${activation.selected[0]?.score.toFixed(3)}, mode = ${activation.mode}`);

  // ── 2. Compose system prompt with skill block ────────────────────────────
  section('2. Compose system prompt via applySkillsToPrompt');
  const baseSystem = 'You are a precise assistant. Follow attached skill guidance exactly.';
  const composedSystem = applySkillsToPrompt(
    baseSystem,
    [...activation.selected],
    activation.mode,
    userQuery,
  );
  assert.ok(composedSystem, 'composedSystem is defined');
  assert.match(composedSystem!, /Arithmetic Verifier/i, 'skill name present');
  assert.match(composedSystem!, /calculator/i, 'tool name present');
  ok(`composed system prompt length = ${composedSystem!.length} chars`);

  // ── 3. Build tool registry with the skill's allowed tools ────────────────
  section('3. Wire tools the skill is allowed to call');
  const allowedToolNames = collectSkillTools([...activation.selected]);
  assert.ok(allowedToolNames.includes('calculator'), 'calculator in allowed tool set');
  ok(`allowedTools = ${JSON.stringify(allowedToolNames)}`);

  let calculatorCalls = 0;
  let lastExpression = '';
  let lastResult = '';
  const tools = weaveToolRegistry();
  tools.register(
    weaveTool({
      name: 'calculator',
      description: 'Evaluate an arithmetic expression and return the numeric result.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Arithmetic expression, e.g. "17 * 23"' },
        },
        required: ['expression'],
      },
      execute: async (args) => {
        const expr = (args as { expression: string }).expression;
        calculatorCalls += 1;
        lastExpression = expr;
        // Safe-ish arithmetic eval for demo; production: use a math parser.
        if (!/^[\d+\-*/.()\s]+$/.test(expr)) {
          throw new Error(`Refusing to evaluate non-arithmetic expression: ${expr}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const value = Function(`"use strict"; return (${expr})`)();
        lastResult = String(value);
        return lastResult;
      },
    }),
  );

  // ── 4. Build the agent with composed system prompt ───────────────────────
  section('4. Build weaveAgent with real OpenAI model');
  const model = weaveOpenAIModel('gpt-4o-mini', { apiKey });
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'skills-real-llm-demo' });
  const agent = weaveAgent({
    name: 'arithmetic-verifier-agent',
    model,
    tools,
    bus,
    systemPrompt: composedSystem!,
    maxSteps: 4,
  });
  ok('agent built (model=gpt-4o-mini, tools=[calculator])');

  // ── 5. Run the agent ─────────────────────────────────────────────────────
  section('5. Run agent.run() with real LLM call');
  const startedAt = Date.now();
  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: userQuery }],
  });
  const elapsedMs = Date.now() - startedAt;
  info(`agent run completed in ${elapsedMs} ms, ${result.steps.length} step(s)`);
  for (const step of result.steps) {
    const label = step.type === 'tool'
      ? `tool→${step.toolCall?.name ?? '?'}(${JSON.stringify(step.toolCall?.arguments ?? {})})`
      : `model→${(step.content ?? '').slice(0, 80).replace(/\s+/g, ' ')}`;
    info(`step[${step.type}]: ${label}`);
  }
  console.log(`\n  Agent output:\n    ${result.output.replace(/\n/g, '\n    ')}\n`);

  // ── 6. Validate skill→tool wiring + completion contract ──────────────────
  section('6. Validate wiring + completion contract');
  assert.ok(calculatorCalls >= 1, `calculator tool was invoked (${calculatorCalls} time(s))`);
  ok(`calculator invoked ${calculatorCalls}× with expression "${lastExpression}" → ${lastResult}`);

  // Sanity: 17 * 23 == 391
  assert.equal(eval(lastExpression || '0'), 391, 'sanity: 17 * 23 === 391');

  const contract = evaluateSkillCompletion(mathSkill, result.output);
  console.log(`\n  Completion contract evaluation:`);
  console.log(`    state            = ${contract.state}`);
  console.log(`    missingEvidence  = ${JSON.stringify(contract.missingEvidence)}`);
  console.log(`    needsHumanReview = ${contract.needsHumanReview}`);
  console.log(`    reasons          = ${JSON.stringify(contract.reasons)}`);

  assert.ok(
    contract.state === 'complete' || contract.state === 'complete_with_warnings',
    `completion state should be complete*, got "${contract.state}"`,
  );
  assert.deepEqual(contract.missingEvidence, [], 'no missing required evidence');
  ok(`completion contract satisfied (state="${contract.state}")`);

  assert.match(result.output, /391/, 'final answer contains the numeric result 391');
  ok('final answer contains "391"');

  console.log(`\n${PASS} Real-LLM skills E2E passed.`);
}

main().catch((err) => {
  console.error(`\n${FAIL} example failed:`, err);
  process.exit(1);
});
