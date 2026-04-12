/**
 * Example 21: Guardrails — Tool-Grounded vs Memory-Based Responses
 *
 * Demonstrates how the grounding-overlap guardrail behaves differently
 * depending on whether the agent used a tool to answer vs. guessing from memory.
 *
 * Background:
 *   Lexical (Jaccard) overlap between "what day is it today" and
 *   "Today is Sunday, April 12, 2026." is very low (~10%) — the words barely
 *   overlap. Naively this looks like a hallucinated or off-topic answer, but
 *   it is perfectly correct when the agent called the datetime tool to get it.
 *
 *   The fix: when toolEvidence is present in the GuardrailEvaluationContext,
 *   the grounding-overlap check short-circuits to ALLOW (confidence 0.95)
 *   because the answer was sourced from a real data call, not the model's memory.
 *   Without toolEvidence (agent answered from memory), the lexical check runs
 *   normally and will WARN if the answer is unrelated to the query.
 *
 * Scenarios:
 *   A) Agent WITH datetime tool → tool evidence present → guardrail: allow ✓
 *   B) Agent WITHOUT datetime tool → answers from memory → guardrail: warn ✓
 *
 * Changes reflected:
 *   • datetime tool now supports format="weekday" (returns "Sunday")
 *   • datetime tool's format="date" now includes the day name
 *     ("Sunday, April 12, 2026" instead of "4/12/2026")
 *   • GuardrailEvaluationContext has a toolEvidence field
 *   • evaluateGroundingOverlap short-circuits to allow when toolEvidence is set
 *   • chat.ts extracts tool_call / delegation results from agent steps and
 *     passes them as toolEvidence into the post-execution guardrail call
 *
 * No API keys needed — all in-memory with fake models.
 *
 * Run: npx tsx examples/21-guardrails-date-evidence.ts
 */
import {
  weaveContext,
  weaveEventBus,
  weaveTool,
  weaveToolRegistry,
  type Guardrail,
  type AgentStep,
} from '@weaveintel/core';
import { weaveSupervisor } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';
import { createGuardrailPipeline, summarizeGuardrailResults } from '@weaveintel/guardrails';

// ── Shared guardrail pipeline ─────────────────────────────────────────────────

const guardrails: Guardrail[] = [
  {
    id: 'guard-cog-post-grounding',
    name: 'Cognitive Post: Grounding',
    description: 'Check lexical grounding between prompt and response. Short-circuits to allow when toolEvidence is present.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 1,
    config: {
      rule: 'grounding-overlap',
      category: 'cognitive',
      min_overlap: 0.06,
    },
  },
  {
    id: 'guard-hallucination',
    name: 'Hallucination Check',
    description: 'Flag responses that may contain fabricated information. Also respects toolEvidence.',
    type: 'custom',
    stage: 'post-execution',
    enabled: true,
    priority: 2,
    config: {
      rule: 'grounding-overlap',
      category: 'verification',
      min_overlap: 0.06,
    },
  },
];

const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });

/** Extract tool evidence from agent steps (same logic as chat.ts) */
function extractToolEvidence(steps: readonly AgentStep[]): string | undefined {
  const evidence = steps
    .filter(s => (s.type === 'tool_call' && s.toolCall?.result) || (s.type === 'delegation' && s.delegation?.result))
    .map(s => s.toolCall?.result ?? s.delegation?.result ?? '')
    .join(' ');
  return evidence.trim() || undefined;
}

// ── Scenario A: Agent WITH datetime tool ──────────────────────────────────────

async function scenarioWithTool() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO A: Agent uses datetime tool → grounding: ALLOW');
  console.log('══════════════════════════════════════════════════\n');

  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // Analyst has the datetime tool (format="weekday" now supported)
  const analystTools = weaveToolRegistry();
  analystTools.register(
    weaveTool({
      name: 'datetime',
      description: 'Get the current date/time. Use format="weekday" to get the day name (e.g. Sunday). Use format="date" for full date including day of week.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['iso', 'unix', 'human', 'date', 'time', 'weekday'],
          },
        },
      },
      execute: async (args: { format?: string }) => {
        const now = new Date('2026-04-12T10:00:00');
        switch (args.format) {
          case 'weekday':
            // New format added to fix "what day is today" returning no response
            return now.toLocaleDateString('en-US', { weekday: 'long' }); // → "Sunday"
          case 'date':
            // Enriched to include weekday (was "4/12/2026", now "Sunday, April 12, 2026")
            return now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          default:
            return now.toISOString();
        }
      },
    }),
  );

  // Fake supervisor delegates to worker, worker calls datetime, supervisor synthesises
  const supervisorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{ id: 'c1', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'analyst', goal: 'What day is it today?' }) } }],
      },
      { content: 'Today is Sunday, April 12, 2026.', toolCalls: [] },
    ],
  });

  const workerModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [{ id: 'c2', function: { name: 'datetime', arguments: JSON.stringify({ format: 'weekday' }) } }],
      },
      { content: 'The current day is Sunday.', toolCalls: [] },
    ],
  });

  const supervisor = weaveSupervisor({
    model: supervisorModel,
    bus,
    workers: [{ name: 'analyst', description: 'Analyst with datetime tool.', model: workerModel, tools: analystTools }],
    maxSteps: 6,
  });

  const userInput = 'What day is it today?';
  const run = await supervisor.run(ctx, { messages: [{ role: 'user', content: userInput }] });
  const assistantOutput = run.output;

  console.log('Steps:');
  for (const step of run.steps) {
    const detail = step.toolCall ? `${step.toolCall.name}(${JSON.stringify(step.toolCall.arguments)}) → ${step.toolCall.result}` : (step.content ?? '');
    console.log(`  [${step.type}] ${detail}`);
  }

  // Extract tool evidence from steps — same as chat.ts does
  const toolEvidence = extractToolEvidence(run.steps);
  console.log('\ntoolEvidence present:', !!toolEvidence);

  const results = await pipeline.evaluate(assistantOutput, 'post-execution', {
    userInput,
    assistantOutput,
    toolEvidence, // ← key: tells grounding check the answer came from a tool
    action: userInput,
  });

  const summary = summarizeGuardrailResults(results, 'cognitive');
  console.log('\nGuardrail results:');
  for (const r of results) {
    console.log(`  ${r.guardrailId}: ${r.decision} (confidence: ${r.confidence}) — ${r.explanation}`);
  }
  console.log('Overall decision:', summary?.decision ?? 'allow');
  console.log('\n✓ Tool-backed answer passes grounding with no penalty to eval score.');
}

// ── Scenario B: Direct model response (no agent, no tools) ───────────────────

async function scenarioWithoutTool() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO B: Direct model response (no tools) → grounding: WARN');
  console.log('══════════════════════════════════════════════════\n');
  console.log('In direct mode the model answers from its training data alone.');
  console.log('No agent steps exist → toolEvidence is undefined → lexical overlap runs.\n');

  const userInput = 'What day is it today?';
  // The model outputs a bare day name from training data — no overlap with the query
  const assistantOutput = 'Sunday.';

  // No agent run → no steps → no tool evidence
  const toolEvidence = undefined;
  console.log('toolEvidence present:', !!toolEvidence);

  const results = await pipeline.evaluate(assistantOutput, 'post-execution', {
    userInput,
    assistantOutput,
    toolEvidence,
    action: userInput,
  });

  const summary = summarizeGuardrailResults(results, 'cognitive');
  console.log('\nGuardrail results:');
  for (const r of results) {
    console.log(`  ${r.guardrailId}: ${r.decision} (confidence: ${r.confidence}) — ${r.explanation}`);
  }
  console.log('Overall decision:', summary?.decision ?? 'allow');
  console.log('\n⚠ Memory-only answer warns — eval score is penalised (warnPenalty: 0.25).');
}

// ── Run both scenarios ────────────────────────────────────────────────────────

async function main() {
  await scenarioWithTool();
  await scenarioWithoutTool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
