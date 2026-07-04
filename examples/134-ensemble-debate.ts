/**
 * Example 134 — Ensemble / debate pattern (W5)
 *
 * Demonstrates running multiple agents on the same input and reconciling
 * their outputs using three built-in conflict resolvers:
 *
 *   • `createVoteResolver`    — majority vote (cheapest, no extra LLM call)
 *   • `createArbiterResolver` — present all candidates to a model arbiter
 *   • `createJudgeResolver`   — score each candidate via RubricJudgeAdapter
 *
 * This example uses the vote resolver (no rubric required).
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/134-ensemble-debate.ts
 */

import { weaveAgent, weaveEnsemble, createVoteResolver, createArbiterResolver } from '@weaveintel/agents';
import type { EnsembleResult } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

async function main() {
  // Three agents with different "opinions"
  const agentA = weaveAgent({
    model: createMockModel({ name: 'mock-a', responses: ['Python is the best language.'] }),
    maxSteps: 3, name: 'agent-a',
  });
  const agentB = weaveAgent({
    model: createMockModel({ name: 'mock-b', responses: ['Python is the best language.'] }),
    maxSteps: 3, name: 'agent-b',
  });
  const agentC = weaveAgent({
    model: createMockModel({ name: 'mock-c', responses: ['TypeScript is the best language.'] }),
    maxSteps: 3, name: 'agent-c',
  });

  console.log('=== Vote resolver (majority wins) ===');
  const voteEnsemble = weaveEnsemble({
    agents: [agentA, agentB, agentC],
    resolver: createVoteResolver(),
    parallel: true,
  });

  const ctx = weaveContext({});
  const voteResult = (await voteEnsemble.run(ctx, {
    messages: [{ role: 'user', content: 'What is the best programming language?' }],
  })) as EnsembleResult;

  console.log('Winner   :', voteResult.winner);
  console.log('Rationale:', voteResult.rationale);
  console.log('Output   :', voteResult.output);
  console.log('Candidates:', voteResult.candidates.map((c) => `${c.agentName}: "${c.output}"`));

  console.log('\n=== Arbiter resolver (model picks best) ===');
  const arbiterModel = createMockModel({
    name: 'arbiter',
    responses: ['Python is the best language for general use due to its ecosystem.'],
  });

  const arbiterEnsemble = weaveEnsemble({
    agents: [
      weaveAgent({ model: createMockModel({ name: 'a', responses: ['Python is great.'] }), maxSteps: 3, name: 'a' }),
      weaveAgent({ model: createMockModel({ name: 'b', responses: ['TypeScript is great.'] }), maxSteps: 3, name: 'b' }),
    ],
    resolver: createArbiterResolver({ model: arbiterModel, instruction: 'Pick the most nuanced answer.' }),
    parallel: false,
  });

  const arbiterResult = (await arbiterEnsemble.run(ctx, {
    messages: [{ role: 'user', content: 'What is the best programming language?' }],
  })) as EnsembleResult;

  console.log('Output   :', arbiterResult.output);
  console.log('Rationale:', arbiterResult.rationale);
}

main().catch(console.error);
