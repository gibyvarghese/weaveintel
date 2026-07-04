/**
 * Example 142 — A2A external agent as a supervisor worker (P3-3)
 *
 * Demonstrates how weaveA2AWorker wraps a remote A2A endpoint as a
 * first-class WorkerDefinition usable in a weaveAgent supervisor:
 *
 *   weaveA2AWorker(opts)        — discover card + build synthetic model
 *   weaveA2AWorkerFromCard(card) — use pre-discovered card (no async)
 *
 * The synthetic Model's generate() call:
 *   1. Converts the last Message to an A2ATaskSendParams
 *   2. Sends it via weaveA2AClient().sendMessage()
 *   3. Maps the A2ATask result back to a ModelResponse
 *
 * In this example we use weaveA2ABus (in-process A2A bus) so no real
 * HTTP server is needed — the "remote" agent runs in the same process.
 *
 * Usage:
 *   npx ts-node examples/142-a2a-worker.ts
 */

import {
  weaveContext,
  weaveRuntime,
  weaveToolRegistry,
} from '@weaveintel/core';
import type { AgentCard } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveA2AWorkerFromCard } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

const runtime = weaveRuntime({});

function makeCtx() {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// ─── Simulate a remote A2A specialist agent card ───────────────
//
// In production you would call weaveA2AClient().discover(agentUrl)
// to fetch this card. Here we build a synthetic one so the example
// runs without a live HTTP server.

const syntheticCard: AgentCard = {
  name: 'research-specialist',
  description: 'Deep-dive research specialist agent with web access.',
  version: '1.0.0',
  url: 'https://specialist.example.com',
  supportedInterfaces: [
    { url: 'https://specialist.example.com', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
    stateTransitionHistory: false,
  },
  skills: [
    { id: 'research', name: 'Research', description: 'Conduct in-depth research on any topic.' },
  ],
};

// ─── Scenario 1: Supervisor with an A2A worker ────────────────

async function scenario1A2ASupervisor() {
  console.log('\n── Scenario 1: Supervisor delegating to A2A worker ──');

  // Build the A2A worker from the discovered card
  // The agentUrl is what the client would actually call; in this demo
  // we provide a custom client stub so it never makes real HTTP requests.
  const stubClient = {
    discover: async (_url: string) => syntheticCard,
    sendMessage: async (_ctx: unknown, _url: string, params: { message: { parts: Array<{ text?: string }> } }) => {
      const inputText = params.message.parts.map((p) => p.text ?? '').join('');
      console.log('  [A2A worker received]:', inputText);
      return {
        id: 'task-001',
        contextId: 'ctx-001',
        status: {
          state: 'TASK_STATE_COMPLETED',
          timestamp: new Date().toISOString(),
        },
        artifacts: [
          {
            artifactId: 'art-001',
            name: 'research-output',
            parts: [
              {
                text: `Research result: The topic "${inputText.slice(0, 60)}..." has multiple dimensions. Key findings: 1) High relevance 2) Recent developments in 2026 3) Strong academic consensus.`,
              },
            ],
          },
        ],
        history: [],
      };
    },
  };

  const a2aWorker = weaveA2AWorkerFromCard(
    syntheticCard,
    'https://specialist.example.com',
    { client: stubClient as never },
  );

  console.log('  A2A worker built:', { name: a2aWorker.name, description: a2aWorker.description });

  // Supervisor that can delegate to the A2A specialist
  const supervisorModel = weaveFakeModel({ responses: [
    { content: '', toolCalls: [{ id: 'tc1', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'research-specialist', goal: 'Research the impact of AI agents on software development in 2026.' }) } }] },
    { content: 'Based on the research specialist\'s findings: AI agents are transforming software development through automated code generation, testing, and deployment pipelines.' },
  ] });

  const supervisor = weaveAgent({
    model: supervisorModel,
    name: 'coordinator',
    workers: [a2aWorker],
    maxSteps: 5,
  });

  const result = await supervisor.run(makeCtx(), {
    goal: 'Research AI agent impact on software development',
    messages: [{ role: 'user', content: 'What is the impact of AI agents on software development in 2026?' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 2: Multiple A2A workers ────────────────────────

async function scenario2MultipleA2AWorkers() {
  console.log('\n── Scenario 2: Multiple A2A specialist workers ──');

  const makeStubClient = (workerName: string, response: string) => ({
    discover: async (_url: string) => syntheticCard,
    sendMessage: async () => ({
      id: `task-${workerName}`,
      contextId: `ctx-${workerName}`,
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      artifacts: [{
        artifactId: `art-${workerName}`,
        name: 'output',
        parts: [{ text: response }],
      }],
      history: [],
    }),
  });

  const analyticsWorker = weaveA2AWorkerFromCard(
    { ...syntheticCard, name: 'analytics-agent', description: 'Runs data analytics queries.' },
    'https://analytics.example.com',
    { name: 'analytics-agent', client: makeStubClient('analytics', 'Q4 2025 revenue grew 23% YoY, driven by enterprise SaaS contracts.') as never },
  );

  const forecastWorker = weaveA2AWorkerFromCard(
    { ...syntheticCard, name: 'forecast-agent', description: 'Generates financial forecasts.' },
    'https://forecast.example.com',
    { name: 'forecast-agent', client: makeStubClient('forecast', 'Q1 2026 forecast: 18% growth expected, contingent on new product launch.') as never },
  );

  const supervisorModel = weaveFakeModel({ responses: [
    { content: '', toolCalls: [{ id: 'tc2', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'analytics-agent', goal: 'Get Q4 2025 revenue data' }) } }] },
    { content: '', toolCalls: [{ id: 'tc3', function: { name: 'delegate_to_worker', arguments: JSON.stringify({ worker: 'forecast-agent', goal: 'Get Q1 2026 forecast' }) } }] },
    { content: 'Q4 2025 revenue grew 23% YoY. Q1 2026 forecast shows 18% growth pending new product launch.' },
  ] });

  const supervisor = weaveAgent({
    model: supervisorModel,
    name: 'business-coordinator',
    workers: [analyticsWorker, forecastWorker],
    maxSteps: 10,
  });

  const result = await supervisor.run(makeCtx(), {
    goal: 'Prepare quarterly business review',
    messages: [{ role: 'user', content: 'Summarise Q4 2025 performance and Q1 2026 forecast.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1A2ASupervisor();
  await scenario2MultipleA2AWorkers();
  console.log('\n✓ All A2A worker scenarios complete.');
})().catch(console.error);
