/**
 * Example 30 — Prompt Evaluation and Optimization (Phase 7)
 *
 * Demonstrates shared package runtime APIs for:
 *  1) Dataset-driven prompt evaluation
 *  2) Prompt optimization with deterministic diff metadata
 *  3) Baseline vs candidate comparison on the same dataset
 *  4) Phase 8 shared observability for prompt execution summaries
 *
 * Run:
 *   npx tsx examples/30-prompt-eval-optimization.ts
 */

import {
  evaluatePromptDatasetForRecord,
  comparePromptDatasetResults,
  createConstraintAppenderOptimizer,
  runPromptOptimization,
  createPromptCapabilityTelemetry,
} from '@weaveintel/prompts';
import { annotateSpanWithCapabilityTelemetry, weaveInMemoryTracer } from '@weaveintel/observability';
import { weaveContext } from '@weaveintel/core';

async function main() {
  const basePromptRecord = {
    id: 'support.reply',
    key: 'support.reply',
    name: 'Support Reply Prompt',
    description: 'Generate support replies with concise troubleshooting steps and clear customer guidance.',
    prompt_type: 'template',
    template: [
      'Draft a support reply for {{customerName}} about {{issueSummary}}.',
      'Include one immediate action and one follow-up action.',
    ].join('\n'),
    variables: JSON.stringify([
      { name: 'customerName', type: 'string', required: true },
      { name: 'issueSummary', type: 'string', required: true },
    ]),
    version: '1.0',
    status: 'published',
    execution_defaults: JSON.stringify({ strategy: 'quality-first' }),
  };

  const dataset = {
    id: 'ds-support-001',
    name: 'Support Reply Baseline',
    description: 'Checks for expected safety and action-oriented wording in support replies.',
    promptId: basePromptRecord.id,
    promptVersion: '1.0',
    cases: [
      {
        id: 'case-1',
        description: 'Connection timeout issue',
        variables: {
          customerName: 'Alex',
          issueSummary: 'Connection timeout while syncing files',
        },
        expectedContains: ['Alex', 'immediate action', 'follow-up'],
      },
      {
        id: 'case-2',
        description: 'Billing mismatch issue',
        variables: {
          customerName: 'Jordan',
          issueSummary: 'Billing total does not match invoice breakdown',
        },
        expectedContains: ['Jordan', 'immediate action', 'follow-up'],
      },
    ],
  };

  const baseline = await evaluatePromptDatasetForRecord(basePromptRecord, dataset, {
    passThreshold: 0.6,
  });

  const optimizer = createConstraintAppenderOptimizer({
    key: 'constraintAppender',
    name: 'Constraint Appender',
    description: 'Deterministic optimizer that appends explicit output constraints.',
    suffix: 'Use the exact phrases "immediate action" and "follow-up" in the final answer.',
  });

  const optimization = await runPromptOptimization({
    prompt: basePromptRecord,
    optimizer,
    objective: 'Increase dataset pass rate for action-language compliance.',
    constraints: [
      'Mention customer name in first sentence.',
      'Return exactly two bullet points for actions.',
    ],
    targetVersion: '1.1',
  });

  const candidatePromptRecord = {
    ...basePromptRecord,
    version: optimization.candidate.version,
    template: optimization.candidate.template,
  };

  const comparison = await comparePromptDatasetResults({
    baselineRecord: basePromptRecord,
    candidateRecord: candidatePromptRecord,
    dataset,
    options: { passThreshold: 0.6 },
  });

  console.log('\nPhase 7 Prompt Evaluation + Optimization');
  console.log('--------------------------------------');
  console.log(`Baseline avg score: ${baseline.averageScore.toFixed(3)}`);
  console.log(`Candidate avg score: ${comparison.candidate.averageScore.toFixed(3)}`);
  console.log(`Average score delta: ${comparison.delta.averageScoreDelta.toFixed(3)}`);
  console.log(`Passed case delta: ${comparison.delta.passedCasesDelta}`);
  console.log(`Improved: ${comparison.delta.improved ? 'yes' : 'no'}`);
  console.log(`Changed lines: ${optimization.diff.changedLineCount}`);

  // Phase 8 uses a shared telemetry envelope so the same trace viewer can show
  // prompts, skills, agents, and tools without app-specific event schemas.
  const tracer = weaveInMemoryTracer();
  await tracer.withSpan(
    weaveContext({ userId: 'example-user', deadline: Date.now() + 5_000 }),
    'example.prompt.optimization',
    async (span) => {
      annotateSpanWithCapabilityTelemetry(span, {
        kind: 'prompt',
        key: basePromptRecord.key,
        name: basePromptRecord.name,
        description: basePromptRecord.description,
        version: comparison.candidate.promptVersion,
        source: 'runtime',
        renderedCharacters: comparison.candidate.results[0]?.render.content.length,
        evaluations: comparison.candidate.results.map((result) => ({
          id: result.caseId,
          description: result.description,
          passed: result.passed,
          score: result.score,
        })),
        metadata: {
          baselineAverageScore: baseline.averageScore,
          candidateAverageScore: comparison.candidate.averageScore,
          optimizationDiff: optimization.diff,
        },
      });
    },
  );

  const tracedSummary = tracer.spans[0]?.attributes['capability.summary'] as { kind?: string; key?: string } | undefined;
  console.log(`Telemetry span captured: ${tracedSummary?.kind ?? 'unknown'} / ${tracedSummary?.key ?? 'unknown'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
