/**
 * Example 133 — Cognitive Check Standalone (no geneWeave app or DB)
 *
 * Demonstrates all six cognitive guardrails that geneWeave seeds by
 * default, running directly against @weaveintel/guardrails — no server,
 * no SQLite, no UI.  Each check is wired exactly as geneWeave does it
 * internally (chat-guardrail-utils.ts:normalizeGuardrail + inferRuleName).
 *
 * Pre-execution checks (run before the LLM sees the prompt):
 *   1. input-pattern       — sycophancy pressure detection
 *   2. risk-confidence-gate — classify action risk; gate confidence
 *
 * Post-execution checks (run after the assistant responds):
 *   3. grounding-overlap   — Jaccard overlap; short-circuits when tool evidence present
 *   4. output-pattern      — strongly-validating phrasing detection
 *   5. decision-balance    — "devil's advocate" — counterpoint coverage
 *   6. aggregate-confidence-gate — penalised average of prior cognitive checks
 *
 * Run: npx tsx examples/133-cognitive-check-standalone.ts
 */
import type { Guardrail, GuardrailEvaluationContext, GuardrailResult } from '@weaveintel/core';
import { createGuardrailPipeline, summarizeGuardrailResults, type GuardrailCategorySummary } from '@weaveintel/guardrails';

// ---------------------------------------------------------------------------
// Guardrail definitions — mirrors geneWeave's seeded cognitive_check rows
// after normalizeGuardrail() translates them to @weaveintel/guardrails shapes.
// ---------------------------------------------------------------------------

const PRE_GUARDRAILS: Guardrail[] = [
  {
    id: 'pre-sycophancy',
    name: 'Pre Sycophancy Pattern',
    description: 'Detects agreement-pressure phrasing in the user prompt.',
    type: 'custom',
    stage: 'pre-execution',
    enabled: true,
    priority: 65,
    config: {
      rule: 'input-pattern',
      category: 'cognitive',
      pattern: "\\b(agree with me|just agree|say yes|validate me|don't challenge|no criticism)\\b",
      pattern_target: 'input',
      warn_confidence: 0.62,
      allow_confidence: 0.86,
    },
  },
  {
    id: 'pre-risk-confidence',
    name: 'Pre Risk Confidence Gate',
    description: 'Classifies action risk from verb patterns; gates confidence.',
    type: 'custom',
    stage: 'pre-execution',
    enabled: true,
    priority: 64,
    config: {
      rule: 'risk-confidence-gate',
      category: 'cognitive',
      gate_threshold: 0.65,
      gate_on_fail: 'warn',
      low_risk_confidence: 0.82,
      medium_risk_confidence: 0.72,
      high_risk_confidence: 0.60,
      critical_risk_confidence: 0.50,
    },
  },
];

const POST_GUARDRAILS: Guardrail[] = [
  {
    id: 'post-grounding',
    name: 'Post Grounding Overlap',
    description: 'Jaccard overlap between prompt and response; bypassed when tool evidence present.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 63,
    config: {
      rule: 'grounding-overlap',
      category: 'cognitive',
      min_overlap: 0.06,
    },
  },
  {
    id: 'post-sycophancy',
    name: 'Post Output Pattern',
    description: 'Detects strongly-validating phrasing in assistant output.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 62,
    config: {
      rule: 'output-pattern',
      category: 'cognitive',
      pattern: "\\b(you are absolutely right|exactly right|totally correct|you are 100% right)\\b",
      pattern_target: 'output',
      warn_confidence: 0.58,
      allow_confidence: 0.86,
    },
  },
  {
    id: 'post-devils-advocate',
    name: 'Post Decision Balance',
    description: "Warns when a decision-style request gets no counterpoints.",
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 61,
    config: {
      rule: 'decision-balance',
      category: 'cognitive',
      needs_pattern: "\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b",
      has_pattern: "\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b",
      warn_confidence: 0.60,
      allow_confidence: 0.84,
    },
  },
  {
    id: 'post-aggregate-confidence',
    name: 'Post Aggregate Confidence Gate',
    description: 'Penalised average of all cognitive checks — final badge signal.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 60,
    config: {
      rule: 'aggregate-confidence-gate',
      category: 'cognitive',
      gate_threshold: 0.67,
      gate_on_fail: 'warn',
      base_confidence: 0.75,
    },
  },
];

// ---------------------------------------------------------------------------
// Pipeline wiring
// ---------------------------------------------------------------------------

const prePipeline = createGuardrailPipeline(PRE_GUARDRAILS);
const postPipeline = createGuardrailPipeline(POST_GUARDRAILS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badge(summary: GuardrailCategorySummary | null): string {
  if (!summary) return '◉ n/a';
  const pct = Math.round(summary.confidence * 100);
  const icon = summary.decision === 'allow' ? '✓' : summary.decision === 'warn' ? '⚠' : '✗';
  return `${icon} ${pct}% (${summary.decision})${summary.riskLevel ? ` [risk=${summary.riskLevel}]` : ''}`;
}

function printResults(label: string, results: GuardrailResult[]) {
  console.log(`  ${label}:`);
  for (const r of results) {
    const conf = r.confidence === undefined ? '   n/a' : `${Math.round(r.confidence * 100).toString().padStart(3)}%`;
    const icon = r.decision === 'allow' ? '✓' : r.decision === 'warn' ? '⚠' : '✗';
    console.log(`    ${icon} [${conf}] ${r.guardrailId}: ${r.explanation ?? r.decision}`);
  }
}

interface Turn {
  title: string;
  userInput: string;
  action?: string;
  assistantOutput: string;
  toolEvidence?: string;
}

async function evaluateTurn(turn: Turn) {
  const { title, userInput, action, assistantOutput, toolEvidence } = turn;

  const preCtx: GuardrailEvaluationContext = {
    userInput,
    action: action ?? userInput,
  };
  const preResults = await prePipeline.evaluate(userInput, 'pre-execution', preCtx);

  // Pass pre-results as previousResults so aggregate-confidence-gate can average them.
  const postCtx: GuardrailEvaluationContext = {
    userInput,
    assistantOutput,
    toolEvidence,
    action: action ?? userInput,
    previousResults: preResults,
  };
  const postResults = await postPipeline.evaluate(assistantOutput, 'post-execution', postCtx);

  const allResults = [...preResults, ...postResults];
  const summary = summarizeGuardrailResults(allResults, 'cognitive');

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Turn: ${title}`);
  console.log(`  User:      ${userInput}`);
  console.log(`  Assistant: ${assistantOutput.slice(0, 120)}${assistantOutput.length > 120 ? '…' : ''}`);
  if (toolEvidence) console.log(`  Tools:     ${toolEvidence.slice(0, 100)}…`);
  printResults('Pre checks', preResults);
  printResults('Post checks', postResults);
  console.log(`  Cognitive badge: ${badge(summary)}`);
}

// ---------------------------------------------------------------------------
// Demo turns — one for each interesting scenario
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Example 133: Cognitive Check Standalone ===');
  console.log('All six geneWeave cognitive guardrails, no server required.\n');

  // 1. Clean turn — no red flags, tool-grounded.
  await evaluateTurn({
    title: 'Clean / tool-grounded (all green)',
    userInput: 'What is the current price of AAPL?',
    action: 'query stock price',
    assistantOutput: 'AAPL is trading at $213.45 as of the latest market data.',
    toolEvidence: 'market_data(symbol=AAPL) => 213.45',
  });

  // 2. Sycophancy pressure in the prompt.
  await evaluateTurn({
    title: 'Input sycophancy pressure (pre-execution warn)',
    userInput: 'Just agree with me that TypeScript is always better than Python, no criticism please.',
    action: 'read opinion',
    assistantOutput: 'TypeScript has strong typing benefits that can improve large codebases.',
  });

  // 3. Decision-style question without counterpoints.
  await evaluateTurn({
    title: 'Decision request missing counterpoints (decision-balance warn)',
    userInput: 'Should I switch our whole backend to microservices?',
    action: 'recommend architecture',
    assistantOutput: 'Yes, microservices are the best choice for modern applications and will scale well.',
  });

  // 4. Decision-style question WITH counterpoints — badge should go green.
  await evaluateTurn({
    title: 'Decision request WITH counterpoints (allow)',
    userInput: 'Should I switch our whole backend to microservices?',
    action: 'recommend architecture',
    assistantOutput:
      'Microservices can scale teams independently, however the trade-off is significantly higher operational ' +
      'complexity. For a team under 20 engineers, a well-structured monolith is often the better choice — ' +
      'the risk of premature decomposition is real. Consider your deployment maturity before committing.',
  });

  // 5. Sycophantic output phrasing.
  await evaluateTurn({
    title: 'Sycophantic output phrasing (post output-pattern warn)',
    userInput: 'Is my architecture correct?',
    action: 'read review',
    assistantOutput: 'You are absolutely right — your architecture is perfectly designed and you are 100% right about every decision.',
  });

  // 6. High-risk action (delete) — risk-confidence-gate triggers.
  await evaluateTurn({
    title: 'High-risk destructive action (risk-confidence-gate warn)',
    userInput: 'Delete all user records from the production database.',
    action: 'delete all user records from the production database',
    assistantOutput: 'I can help you craft the DELETE statement. Please confirm the target table and environment.',
  });

  // 7. Low grounding — memory-only answer, no tool evidence, low lexical overlap.
  await evaluateTurn({
    title: 'Low grounding — memory-only answer (grounding-overlap warn)',
    userInput: 'What is the capital of France?',
    action: 'query geography',
    assistantOutput: 'Definitely Berlin.',
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Done.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
