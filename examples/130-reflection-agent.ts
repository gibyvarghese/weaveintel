/**
 * Example 130 — Reflection agent (W1)
 *
 * Demonstrates the self-correction loop: after producing a terminal response,
 * the agent critiques its own output and revises it if the critique rejects.
 *
 * Key concepts:
 *   • `reflect.maxRevisions` — how many critique/revise cycles before accepting
 *   • `reflect.criteria`     — natural-language rubric for the self-critic
 *   • The critic and revise loop are wired inside weaveAgent — no separate agent
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/130-reflection-agent.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

async function main() {
  // The mock model returns three responses:
  //   1. Initial draft (terminal)
  //   2. Self-critique JSON {"rating": 3, "accepted": false, "feedback": "Too brief"}
  //   3. Revised draft (terminal, accepted)
  const model = createMockModel({
    name: 'mock-reflect',
    responses: [
      'Paris.',
      JSON.stringify({ rating: 3, accepted: false, feedback: 'The answer is too brief — add context about Paris being the capital.' }),
      'Paris is the capital and largest city of France, home to the Eiffel Tower and the Louvre.',
      JSON.stringify({ rating: 9, accepted: true, feedback: 'Good answer.' }),
    ],
  });

  const agent = weaveAgent({
    model,
    maxSteps: 10,
    name: 'reflect-demo',
    reflect: {
      maxRevisions: 2,
      criteria: 'The answer must be informative and include relevant context, not just a one-word response.',
    },
  });

  const ctx = weaveContext({});
  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });

  console.log('Status   :', result.status);
  console.log('Output   :', result.output);
  console.log('Steps    :', result.steps.length);
  console.log('Tokens   :', result.usage.totalTokens);

  // Show any reflection steps
  const reflectSteps = result.steps.filter((s) => s.content?.startsWith('[reflect:'));
  if (reflectSteps.length) {
    console.log('\nReflection steps:');
    reflectSteps.forEach((s) => console.log(' •', s.content));
  }
}

main().catch(console.error);
