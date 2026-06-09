/**
 * Example 138 — Guardrail Conditional Triggers (Phase 1 + 2)
 *
 * Demonstrates the conditional trigger system that lets each guardrail
 * declare WHEN it should fire. Cheap deterministic checks always run;
 * expensive LLM calls only fire when the context actually justifies them.
 *
 * Key API:
 *   buildInputSignals(text)          → extract cheap regex signals from input
 *   buildOutputSignals(text, bool)   → extract cheap regex signals from output
 *   GuardrailConditionContext        → full context snapshot built once per turn
 *   createGuardrailPipeline(gs, { conditionContext }) → evaluates conditions before each guardrail
 *
 * ConditionNode examples used here:
 *   { any: [...] }                   → fires if ANY child is true
 *   { all: [...] }                   → fires if ALL children are true
 *   { chat_mode: ['agent','supervisor'] }
 *   { persona: ['anonymous'] }
 *   { input_has_urls: true }
 *   { input_length_gt: 300 }
 *   { input_has_validation_seeking: true }
 *   { output_has_factual_claims: true }
 *   { output_has_tool_evidence: false }
 *
 * Scenarios:
 *   A) "what day is it today?" — direct mode, platform_admin → only cheap checks run
 *   B) same message — agent mode, anonymous, URL in input   → full stack fires
 *   C) post-execution: factual output, no tool evidence     → semantic grounding fires
 *   D) post-execution: factual output WITH tool evidence    → semantic grounding skips
 *
 * No API keys needed. Guardrail evaluators are faked via a mock registry.
 *
 * Run: npx tsx examples/138-guardrail-conditional-triggers.ts
 */
import type { Guardrail } from '@weaveintel/core';
import {
  createGuardrailPipeline,
  buildInputSignals,
  buildOutputSignals,
  type GuardrailConditionContext,
} from '@weaveintel/guardrails';
import { AsyncEvaluatorRegistry } from '@weaveintel/guardrails';

// ── Mock registry (stands in for real LLM evaluators) ─────────────────────

const mockRegistry = new AsyncEvaluatorRegistry();

mockRegistry.register('injection-classifier', async (_g, input) => ({
  decision: 'allow' as const,
  guardrailId: _g.id,
  explanation: `Injection classifier ran on: "${input.slice(0, 40)}…"`,
  confidence: 0.12,
}));

mockRegistry.register('llm-safety-judge', async (_g, output) => ({
  decision: 'allow' as const,
  guardrailId: _g.id,
  explanation: `Safety judge ran on: "${output.slice(0, 40)}…"`,
  confidence: 0.05,
}));

mockRegistry.register('sycophancy-judge', async (_g, input) => ({
  decision: 'warn' as const,
  guardrailId: _g.id,
  explanation: `Sycophancy pattern detected in: "${input.slice(0, 40)}…"`,
  confidence: 0.71,
}));

mockRegistry.register('semantic-grounding', async (_g, output) => ({
  decision: 'warn' as const,
  guardrailId: _g.id,
  explanation: `Low grounding score — output may not be evidence-backed`,
  confidence: 0.38,
}));

// ── Guardrail definitions with triggerConditions ───────────────────────────

const PRE_GUARDRAILS: Guardrail[] = [
  {
    // Always-run: zero-cost blocklist, never skip.
    id: 'injection-blocklist',
    name: 'Injection Blocklists',
    type: 'blocklist',
    stage: 'pre-execution',
    enabled: true,
    priority: 10,
    config: { words: ['ignore previous instructions', 'pretend you are'] },
    triggerConditions: null, // explicit null = always run
    triggerDescription: 'Always — zero cost, jailbreak risk',
  },
  {
    // Always-run: cheap PII regex.
    id: 'pii-input',
    name: 'PII Input Check',
    type: 'regex',
    stage: 'pre-execution',
    enabled: true,
    priority: 20,
    config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
    // absent triggerConditions = always run (backward-compatible default)
    triggerDescription: 'Always — cheap regex, high consequence if missed',
  },
  {
    // Conditional: expensive injection classifier — only fires when input has
    // structural complexity that makes injection plausible.
    id: 'injection-classifier',
    name: 'Prompt Injection Classifier',
    type: 'model-graded',
    stage: 'pre-execution',
    enabled: true,
    priority: 30,
    config: { rule: 'injection-classifier', timeout_ms: 15000, on_error: 'deny' },
    triggerConditions: {
      any: [
        { input_has_code: true },
        { input_has_base64: true },
        { input_has_structured_data: true },
        { input_has_urls: true },
        { input_has_instruction_override: true },
        { persona: ['anonymous'] },
        { prior_has_injection_warn: true },
        { input_length_gt: 300 },
      ],
    },
    triggerDescription: 'Code/base64/URLs/override phrase/anonymous/long input',
  },
  {
    // Conditional: sycophancy judge — only fires when user seeks validation.
    id: 'sycophancy-judge',
    name: 'Sycophancy Judge',
    type: 'model-graded',
    stage: 'pre-execution',
    enabled: true,
    priority: 40,
    config: { rule: 'sycophancy-judge', timeout_ms: 8000, on_error: 'warn' },
    triggerConditions: {
      any: [
        { input_has_validation_seeking: true },
        { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] },
      ],
    },
    triggerDescription: 'Validation-seeking phrasing, or long session with prior cognitive warn',
  },
];

const POST_GUARDRAILS: Guardrail[] = [
  {
    // Always-run: cheap output PII regex.
    id: 'pii-output',
    name: 'PII Output Check',
    type: 'regex',
    stage: 'post-execution',
    enabled: true,
    priority: 10,
    config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
    triggerDescription: 'Always — cheap regex, prevents accidental leakage',
  },
  {
    // Conditional: semantic grounding — only when output makes factual claims
    // that aren't backed by tool evidence.
    id: 'semantic-grounding',
    name: 'Semantic Grounding',
    type: 'model-graded',
    stage: 'post-execution',
    enabled: true,
    priority: 20,
    config: { rule: 'semantic-grounding', timeout_ms: 6000, on_error: 'allow' },
    triggerConditions: {
      all: [
        { output_has_factual_claims: true },
        { output_has_tool_evidence: false },
      ],
    },
    triggerDescription: 'Factual claims in output AND no tool evidence',
  },
  {
    // Conditional: full LLM safety judge — only in elevated situations.
    id: 'llm-safety-judge',
    name: 'LLM Safety Judge',
    type: 'model-graded',
    stage: 'post-execution',
    enabled: true,
    priority: 30,
    config: { rule: 'llm-safety-judge', timeout_ms: 15000, on_error: 'deny' },
    triggerConditions: {
      any: [
        { chat_mode: ['agent', 'supervisor'] },
        { turn_has_tool_calls: true },
        { risk_level: ['high', 'critical'] },
        { output_length_gt: 500 },
        { prior_has_warn: true },
        { persona: ['anonymous'] },
      ],
    },
    triggerDescription: 'Agent/supervisor, tool calls, high risk, long output, prior warn, or anonymous',
  },
];

// ── Context builder helpers ────────────────────────────────────────────────

function makePreCtx(overrides: {
  persona?: string;
  mode?: string;
  turnNumber?: number;
  hasToolCalls?: boolean;
  riskLevel?: string;
  priorHasWarn?: boolean;
  input: string;
}): GuardrailConditionContext {
  const inputSignals = buildInputSignals(overrides.input);
  return {
    user: { persona: overrides.persona ?? 'platform_admin', isNew: false },
    chat: { mode: overrides.mode ?? 'direct' },
    turn: {
      number: overrides.turnNumber ?? 1,
      hasToolCalls: overrides.hasToolCalls ?? false,
      toolCategories: [],
    },
    risk: { level: overrides.riskLevel ?? 'low', verb: 'read' },
    prior: { hasWarn: overrides.priorHasWarn ?? false, hasCognitiveWarn: false, hasInjectionWarn: false },
    input: inputSignals,
    output: null,
  };
}

// ── Print helpers ──────────────────────────────────────────────────────────

function printResult(r: { guardrailId: string; decision: string; explanation?: string; metadata?: Record<string, unknown> }) {
  const skipped = r.metadata?.['skipped'];
  if (skipped === 'condition_not_met') {
    console.log(`    ○ ${r.guardrailId.padEnd(26)} skipped  (condition not met)`);
  } else if (skipped === 'budget_exceeded') {
    console.log(`    ○ ${r.guardrailId.padEnd(26)} skipped  (budget exceeded)`);
  } else {
    const icon = r.decision === 'allow' ? '✓' : r.decision === 'warn' ? '⚠' : '✗';
    console.log(`    ${icon} ${r.guardrailId.padEnd(26)} ${r.decision.toUpperCase().padEnd(6)}  ${r.explanation?.slice(0, 70) ?? ''}`);
  }
}

function printScenario(label: string, signals: Record<string, unknown>) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Scenario: ${label}`);
  const trueSigs = Object.entries(signals)
    .filter(([, v]) => v === true || (typeof v === 'number' && v > 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (trueSigs) console.log(`  Signals: ${trueSigs}`);
}

// ── Scenario A: cheap query, privileged user, direct mode ─────────────────

async function scenarioA() {
  const input = 'What day is it today?';
  const ctx = makePreCtx({ input, persona: 'platform_admin', mode: 'direct' });

  printScenario(
    '"What day is it today?" — direct mode, platform_admin',
    { persona: ctx.user.persona, mode: ctx.chat.mode, input_length: ctx.input.length },
  );
  console.log(`  Input: "${input}"`);
  console.log('  Expected: blocklist + PII run always; injection-classifier and sycophancy-judge skip.\n');

  const pipeline = createGuardrailPipeline(PRE_GUARDRAILS, {
    registry: mockRegistry,
    conditionContext: ctx,
  });
  const results = await pipeline.evaluate(input, 'pre-execution');
  for (const r of results) printResult(r);

  const ran = results.filter(r => r.metadata?.['skipped'] !== 'condition_not_met').length;
  const skipped = results.filter(r => r.metadata?.['skipped'] === 'condition_not_met').length;
  console.log(`\n  → ${ran} guardrail(s) evaluated, ${skipped} skipped (conditions not met)`);
}

// ── Scenario B: same input, agent mode, anonymous user with URL ───────────

async function scenarioB() {
  const input = 'Summarise https://example.com/api/data and tell me what day it is.';
  const ctx = makePreCtx({
    input,
    persona: 'anonymous',
    mode: 'agent',
    hasToolCalls: true,
  });

  printScenario(
    '"Summarise https://..." — agent mode, anonymous, has URL',
    {
      persona: ctx.user.persona,
      mode: ctx.chat.mode,
      input_has_urls: ctx.input.hasUrls,
      has_tool_calls: ctx.turn.hasToolCalls,
    },
  );
  console.log(`  Input: "${input}"`);
  console.log('  Expected: blocklist, PII, and injection-classifier fire; sycophancy-judge skips (no validation-seeking).\n');

  const pipeline = createGuardrailPipeline(PRE_GUARDRAILS, {
    registry: mockRegistry,
    conditionContext: ctx,
  });
  const results = await pipeline.evaluate(input, 'pre-execution');
  for (const r of results) printResult(r);

  const ran = results.filter(r => r.metadata?.['skipped'] !== 'condition_not_met').length;
  const skipped = results.filter(r => r.metadata?.['skipped'] === 'condition_not_met').length;
  console.log(`\n  → ${ran} guardrail(s) evaluated, ${skipped} skipped`);
}

// ── Scenario C: post-execution — factual output, no tool evidence ──────────

async function scenarioC() {
  const input = 'What was global GDP in 2023?';
  const output = 'Global GDP in 2023 was approximately $105 trillion according to World Bank data.';

  // No tool evidence — semantic grounding condition IS met
  const outputSignals = buildOutputSignals(output, false /* toolEvidence */);
  const ctx: GuardrailConditionContext = {
    user: { persona: 'tenant_user', isNew: false },
    chat: { mode: 'direct' },
    turn: { number: 2, hasToolCalls: false, toolCategories: [] },
    risk: { level: 'low', verb: 'read' },
    prior: { hasWarn: false, hasCognitiveWarn: false, hasInjectionWarn: false },
    input: buildInputSignals(input),
    output: outputSignals,
  };

  printScenario(
    'Post-execution — factual output, NO tool evidence',
    {
      output_has_factual_claims: outputSignals.hasFactualClaims,
      output_has_tool_evidence: outputSignals.hasToolEvidence,
      persona: ctx.user.persona,
      mode: ctx.chat.mode,
    },
  );
  console.log(`  Output: "${output}"`);
  console.log('  Expected: PII always runs; semantic-grounding fires (factual, no evidence); LLM judge skips.\n');

  const pipeline = createGuardrailPipeline(POST_GUARDRAILS, {
    registry: mockRegistry,
    conditionContext: ctx,
  });
  const results = await pipeline.evaluate(output, 'post-execution');
  for (const r of results) printResult(r);

  const ran = results.filter(r => r.metadata?.['skipped'] !== 'condition_not_met').length;
  const skipped = results.filter(r => r.metadata?.['skipped'] === 'condition_not_met').length;
  console.log(`\n  → ${ran} guardrail(s) evaluated, ${skipped} skipped`);
}

// ── Scenario D: post-execution — same output but WITH tool evidence ─────────

async function scenarioD() {
  const input = 'What was global GDP in 2023?';
  const output = 'Global GDP in 2023 was approximately $105 trillion according to World Bank data.';

  // Tool evidence present — semantic grounding condition is NOT met (skips)
  const outputSignals = buildOutputSignals(output, true /* toolEvidence */);
  const ctx: GuardrailConditionContext = {
    user: { persona: 'tenant_user', isNew: false },
    chat: { mode: 'direct' },
    turn: { number: 2, hasToolCalls: true, toolCategories: ['api'] },
    risk: { level: 'low', verb: 'read' },
    prior: { hasWarn: false, hasCognitiveWarn: false, hasInjectionWarn: false },
    input: buildInputSignals(input),
    output: outputSignals,
  };

  printScenario(
    'Post-execution — same output, WITH tool evidence',
    {
      output_has_factual_claims: outputSignals.hasFactualClaims,
      output_has_tool_evidence: outputSignals.hasToolEvidence,
      has_tool_calls: ctx.turn.hasToolCalls,
    },
  );
  console.log(`  Output: "${output}"`);
  console.log('  Expected: PII always runs; semantic-grounding SKIPS (tool evidence grounds it); LLM judge skips.\n');

  const pipeline = createGuardrailPipeline(POST_GUARDRAILS, {
    registry: mockRegistry,
    conditionContext: ctx,
  });
  const results = await pipeline.evaluate(output, 'post-execution');
  for (const r of results) printResult(r);

  const ran = results.filter(r => r.metadata?.['skipped'] !== 'condition_not_met').length;
  const skipped = results.filter(r => r.metadata?.['skipped'] === 'condition_not_met').length;
  console.log(`\n  → ${ran} guardrail(s) evaluated, ${skipped} skipped`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Example 138: Guardrail Conditional Triggers ===');
  console.log('Cheap checks always run. Expensive LLM calls only fire when context justifies them.\n');

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();

  console.log(`\n${'─'.repeat(70)}`);
  console.log('Done.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
