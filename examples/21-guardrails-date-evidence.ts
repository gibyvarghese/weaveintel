/**
 * Example 21: Guardrails Date Evidence Check
 *
 * Demonstrates a supervisor + worker-tools flow, then runs package-level
 * guardrails over the final answer. The use case intentionally simulates an
 * agent that has no date/time tool and still answers the day.
 */
import {
  weaveContext,
  weaveEventBus,
  weaveTool,
  weaveToolRegistry,
  type Guardrail,
} from '@weaveintel/core';
import { weaveSupervisor } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';
import { createGuardrailPipeline, summarizeGuardrailResults } from '@weaveintel/guardrails';

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // Worker tools intentionally do NOT provide actual date/time lookup.
  const assistantTools = weaveToolRegistry();
  assistantTools.register(
    weaveTool({
      name: 'check_capabilities',
      description: 'Returns what capabilities are available to the worker.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        return JSON.stringify({
          hasDateTimeTool: false,
          availableTools: ['check_capabilities'],
          note: 'No date/time source is available in this run.',
        });
      },
    }),
  );

  const supervisorModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_delegate_1',
            function: {
              name: 'delegate_to_worker',
              arguments: JSON.stringify({
                worker: 'assistant',
                goal: 'Answer: What day is it today?',
              }),
            },
          },
        ],
      },
      {
        content: 'It is Monday.',
        toolCalls: [],
      },
    ],
  });

  const workerModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_tool_1',
            function: {
              name: 'check_capabilities',
              arguments: '{}',
            },
          },
        ],
      },
      {
        // Intentionally unsupported because no time tool exists.
        content: 'It is Monday.',
        toolCalls: [],
      },
    ],
  });

  const supervisor = weaveSupervisor({
    model: supervisorModel,
    bus,
    workers: [
      {
        name: 'assistant',
        description: 'General assistant with limited tool access (no date/time).',
        model: workerModel,
        tools: assistantTools,
      },
    ],
    maxSteps: 6,
  });

  const userInput = 'What day is it today?';
  const run = await supervisor.run(ctx, {
    messages: [{ role: 'user', content: userInput }],
  });

  const assistantOutput = run.output;

  const guardrails: Guardrail[] = [
    {
      id: 'verification-date-evidence',
      name: 'Date Evidence Verification',
      description: 'Warn when date/day answers are not sufficiently grounded in the user request context.',
      type: 'custom',
      stage: 'post-execution',
      enabled: true,
      priority: 1,
      config: {
        rule: 'grounding-overlap',
        category: 'verification',
        min_overlap: 0.35,
      },
    },
  ];

  const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });

  const results = await pipeline.evaluate(assistantOutput, 'post-execution', {
    userInput,
    assistantOutput,
    action: userInput,
    metadata: {
      hasDateTimeTool: false,
      note: 'Agent intentionally has no time tool.',
    },
  });

  const summary = summarizeGuardrailResults(results, 'verification');

  console.log('=== Supervisor + Tools Run ===');
  console.log('Supervisor output:', assistantOutput);
  console.log(`Total steps: ${run.steps.length}`);
  for (const step of run.steps) {
    console.log(`  [${step.type}] ${step.toolCall?.name ?? step.content ?? ''}`);
  }

  console.log('\n=== Guardrail Evaluation ===');
  console.log('Use case: no date/time tool, assistant answers day directly');
  console.log('User input:', userInput);
  console.log('Assistant output:', assistantOutput);
  console.log('Guardrail results:', JSON.stringify(results, null, 2));
  console.log('Verification summary:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
