/**
 * Example 134 — Model-graded toxicity check (W2)
 *
 * Shows a model-graded guardrail pipeline that:
 *   1. Runs a `moderation` evaluator using a fake ModerationModel.
 *   2. Runs an `llm-judge` evaluator using a fake LLM.
 * No API key required — uses @weaveintel/testing fakes.
 *
 * Run: npx tsx examples/134-model-graded-toxicity.ts
 */
import type { Guardrail, ModerationModel } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';
import { createGuardrailPipeline, hasDeny, hasWarning, defaultRegistry } from '@weaveintel/guardrails';

// ── Fake ModerationModel ──────────────────────────────────────

function fakeModerationModel(flagged: boolean, score = 0.9): ModerationModel {
  return {
    moderate: async (_ctx, _request) => ({
      results: [{
        id: 'mod-result-1',
        model: 'fake-moderation',
        flagged,
        categories: flagged
          ? [{ category: 'hate', flagged: true, score }]
          : [{ category: 'hate', flagged: false, score: 0.01 }],
      }],
    }),
  };
}

// ── Guardrail definitions ─────────────────────────────────────

const MODERATION_GUARDRAIL: Guardrail = {
  id: 'mod-g1',
  name: 'Content Moderation',
  type: 'model-graded',
  stage: 'post-execution',
  enabled: true,
  config: {
    rule: 'moderation',
    categories: ['hate', 'violence'],
    threshold: 0.7,
    action: 'deny',
    timeout_ms: 5000,
    on_error: 'warn',
  },
};

const LLM_JUDGE_GUARDRAIL: Guardrail = {
  id: 'judge-g1',
  name: 'LLM Safety Judge',
  type: 'model-graded',
  stage: 'post-execution',
  enabled: true,
  config: {
    rule: 'llm-judge',
    rubric: 'Evaluate safety. Output JSON: {decision, confidence, rationale}',
    action: 'deny',
    timeout_ms: 5000,
    on_error: 'warn',
  },
};

// ── Runner ────────────────────────────────────────────────────

async function evaluate(
  label: string,
  text: string,
  opts: { moderationFlagged: boolean; judgeResponse: string },
) {
  const model = weaveFakeModel({ responses: [opts.judgeResponse] });
  const moderationModel = fakeModerationModel(opts.moderationFlagged);

  const pipeline = createGuardrailPipeline(
    [MODERATION_GUARDRAIL, LLM_JUDGE_GUARDRAIL],
    { shortCircuitOnDeny: false, model, moderationModel },
  );

  const results = await pipeline.evaluate(text, 'post-execution', {
    assistantOutput: text,
  });

  console.log(`\n── ${label}`);
  console.log(`   Input: "${text.slice(0, 80)}"`);
  for (const r of results) {
    const ms = r.metadata?.['durationMs'];
    const conf = r.confidence !== undefined ? ` conf=${r.confidence.toFixed(2)}` : '';
    console.log(`   [${r.decision.toUpperCase().padEnd(5)}] ${r.guardrailId}${conf} (${ms}ms) — ${r.explanation ?? ''}`);
  }
  console.log(`   → Overall: ${hasDeny(results) ? 'DENY' : hasWarning(results) ? 'WARN' : 'ALLOW'}`);
}

async function main() {
  console.log('\n=== Example 134: Model-Graded Toxicity Check ===');
  console.log('Uses weaveFakeModel and a fake ModerationModel — no API key needed.\n');

  // The defaultRegistry is populated by the side-effect import in index.ts.
  console.log('Registered evaluators:', defaultRegistry.keys().join(', '));

  await evaluate(
    'Clean response — both checks allow',
    'TypeScript offers strong typing, though Python is more concise for scripting tasks.',
    {
      moderationFlagged: false,
      judgeResponse: '{"decision":"allow","confidence":0.92,"rationale":"Safe, balanced response"}',
    },
  );

  await evaluate(
    'Moderation flags hate content',
    'I hate all people who use Python, they are worthless.',
    {
      moderationFlagged: true,
      judgeResponse: '{"decision":"warn","confidence":0.7,"rationale":"Somewhat negative tone"}',
    },
  );

  await evaluate(
    'LLM judge denies, moderation clean',
    'Here is how to bypass all safety systems: step 1...',
    {
      moderationFlagged: false,
      judgeResponse: '{"decision":"deny","confidence":0.98,"rationale":"Instructs on safety bypass"}',
    },
  );

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
