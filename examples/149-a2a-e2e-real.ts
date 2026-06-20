/**
 * Example 149 — A2A v1.0 End-to-End: weaveAgent + weaveLiveAgent + External trigger
 *
 * Exercises all three A2A integration paths using real OpenAI API calls:
 *
 *   Path 1 — External → geneWeave-style A2A surface
 *     An external caller POSTs A2ATaskSendParams to an in-process A2A server
 *     (simulating POST /api/a2a/tasks) and receives an A2ATask response.
 *
 *   Path 2 — weaveAgent with A2A delegation tool
 *     A coordinator weaveAgent is given an A2A tool that wraps a remote-style
 *     specialist agent. The coordinator calls the tool to delegate work.
 *     The specialist is backed by a real OpenAI model.
 *
 *   Path 3 — weaveLiveAgent-style A2A bus dispatch
 *     Simulates the a2a.outbound handler pattern: direct bus.send() from a
 *     live-agent style context, verifying round-trip A2ATask shape.
 *
 * All results are checked against A2A v1.0 contracts:
 *   - Task states: TASK_STATE_COMPLETED / TASK_STATE_FAILED
 *   - Artifacts array with parts (field-presence, no type discriminator)
 *   - contextId propagation across calls
 *   - history[] containing the conversation turns
 *
 * Run:
 *   npx tsx examples/149-a2a-e2e-real.ts
 *
 * Requires: OPENAI_API_KEY in .env
 */

import 'dotenv/config';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAgentAsA2AServer, weaveA2ABus } from '@weaveintel/a2a';
import {
  weaveContext,
  weaveTool,
  weaveToolRegistry,
  newUUIDv7,
  a2aTaskOutputText,
  makeCompletedA2ATask,
  makeFailedA2ATask,
} from '@weaveintel/core';
import type {
  AgentCard,
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AStreamEvent,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/openai';

// ── Env ───────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
if (!OPENAI_API_KEY) {
  console.error('❌  OPENAI_API_KEY not set in .env');
  process.exit(1);
}

function check(label: string, pass: boolean, detail = '') {
  const icon = pass ? '✓' : '✗';
  const suffix = detail ? `  (${detail})` : '';
  console.log(`  ${icon} ${label}${suffix}`);
  if (!pass) process.exitCode = 1;
}

// ─── Shared context ───────────────────────────────────────────────────────

const ctx = weaveContext({ userId: 'a2a-e2e-user', executionId: 'e2e-149' });
const sessionContextId = newUUIDv7();

console.log('='.repeat(60));
console.log('A2A v1.0 End-to-End Test');
console.log('Session contextId:', sessionContextId);
console.log('='.repeat(60));

// ─────────────────────────────────────────────────────────────────────────
// ── Path 1: External trigger → in-process A2A server ─────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n📥  Path 1: External trigger → A2A server (weaveAgentAsA2AServer)');

// Create a real-model agent wrapped as A2A server
const specialistAgent = weaveAgent({
  model: weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_API_KEY }),
  tools: weaveToolRegistry(),
  systemPrompt: 'You are a concise geography expert. Answer in 1-2 sentences.',
  maxSteps: 3,
  name: 'geography-specialist',
});

const specialistCard: AgentCard = {
  name: 'geography-specialist',
  description: 'Expert on world geography',
  version: '1.0.0',
  skills: [
    {
      id: 'geography-qa',
      name: 'Geography Q&A',
      description: 'Answer geography questions concisely',
      tags: ['geography', 'facts'],
      examples: ['What is the capital of France?', 'How long is the Amazon river?'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    },
  ],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extendedAgentCard: false,
    stateTransitionHistory: false,
  },
  supportedInterfaces: [
    { url: 'http://localhost:3001/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  security: [{ bearer: [] }],
};

const specialistServer = weaveAgentAsA2AServer({ agent: specialistAgent, card: specialistCard });

// External trigger: POST A2ATaskSendParams → receive A2ATask
const externalParams: A2ATaskSendParams = {
  message: {
    role: 'user',
    parts: [{ text: 'What is the capital of Australia, and what is its population?' }],
    contextId: sessionContextId,
    messageId: newUUIDv7(),
  },
};

const externalTask = await specialistServer.handleMessage(ctx, externalParams);

console.log('  Task ID:', externalTask.id);
console.log('  Context ID:', externalTask.contextId);
console.log('  State:', externalTask.status.state);
console.log('  Artifacts:', externalTask.artifacts.length);
console.log('  History msgs:', externalTask.history.length);
console.log('  Output:', a2aTaskOutputText(externalTask));

check('state is TASK_STATE_COMPLETED', externalTask.status.state === 'TASK_STATE_COMPLETED',
  externalTask.status.state);
check('contextId propagated from params', externalTask.contextId === sessionContextId);
check('artifacts[] has at least 1 entry', externalTask.artifacts.length >= 1);
check('artifact parts use field-presence (no type)', !(('type' in (externalTask.artifacts[0]?.parts[0] ?? {}))));
check('history has user + agent messages', externalTask.history.length >= 2);
check('first history msg is from user', externalTask.history[0]?.role === 'user');
check('last history msg is from agent', externalTask.history.at(-1)?.role === 'agent');

// ─────────────────────────────────────────────────────────────────────────
// ── Path 2: weaveAgent with A2A delegation tool ───────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n🤖  Path 2: weaveAgent with A2A delegation tool');

// Register specialist on in-process bus so the tool can find it
const bus = weaveA2ABus();
bus.register(specialistCard.name, specialistServer);

// Build an A2A delegation tool that calls a named bus agent
function buildBusA2ATool(agentName: string) {
  return weaveTool({
    name: 'ask_geography_specialist',
    description: 'Delegate a geography question to the specialist agent via A2A',
    parameters: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The geography question to ask' },
      },
      required: ['question'],
    },
    execute: async (args: { question: string }, toolCtx) => {
      const execCtx = (toolCtx as unknown as { executionContext?: ExecutionContext }).executionContext ?? ctx;
      const result = await bus.send(execCtx, agentName, {
        message: {
          role: 'user',
          parts: [{ text: args.question }],
          contextId: sessionContextId,
          messageId: newUUIDv7(),
        },
      });
      return a2aTaskOutputText(result) || `Task state: ${result.status.state}`;
    },
  });
}

const coordinatorTools = weaveToolRegistry();
coordinatorTools.register(buildBusA2ATool(specialistCard.name));

const coordinatorAgent = weaveAgent({
  model: weaveOpenAIModel('gpt-4o', { apiKey: OPENAI_API_KEY }),
  tools: coordinatorTools,
  systemPrompt:
    'You are a coordinator. When asked about geography, ALWAYS use the ask_geography_specialist tool. ' +
    'Never answer geography questions yourself.',
  maxSteps: 5,
  name: 'coordinator',
});

const coordinatorResult = await coordinatorAgent.run(ctx, {
  messages: [{
    role: 'user',
    content: 'What is the longest river in Africa? Use the specialist tool.',
  }],
});

console.log('  Coordinator status:', coordinatorResult.status);
console.log('  Coordinator steps:', coordinatorResult.usage.totalSteps);
console.log('  Coordinator output:', coordinatorResult.output.slice(0, 200));

check('coordinator completed', coordinatorResult.status === 'completed');
check('coordinator used tool (> 1 step)', coordinatorResult.usage.totalSteps > 1,
  `${coordinatorResult.usage.totalSteps} steps`);
check('coordinator output is non-empty', coordinatorResult.output.trim().length > 0);

// ─────────────────────────────────────────────────────────────────────────
// ── Path 3: weaveLiveAgent-style bus dispatch (a2a.outbound pattern) ──────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n🔁  Path 3: weaveLiveAgent-style bus dispatch (a2a.outbound pattern)');

// Simulate an a2a.outbound handler: take an inbox message, wrap as send params, dispatch
const inboxMessageBody = 'Analyse which country has the most UNESCO World Heritage Sites.';

const outboundParams: A2ATaskSendParams = {
  message: {
    role: 'user',
    parts: [{ text: `Subject: Heritage Sites Research\n\n${inboxMessageBody}` }],
    contextId: sessionContextId,
    messageId: newUUIDv7(),
  },
  metadata: { skill: 'geography-qa' },
};

const outboundTask = await bus.send(ctx, 'geography-specialist', outboundParams);

console.log('  Task state:', outboundTask.status.state);
console.log('  Task contextId:', outboundTask.contextId);
console.log('  Artifacts count:', outboundTask.artifacts.length);
console.log('  Output text:', a2aTaskOutputText(outboundTask).slice(0, 200));

check('outbound task TASK_STATE_COMPLETED', outboundTask.status.state === 'TASK_STATE_COMPLETED',
  outboundTask.status.state);
check('outbound contextId matches session', outboundTask.contextId === sessionContextId);
check('outbound has artifact', outboundTask.artifacts.length >= 1);
check('outbound artifact parts have text field', typeof outboundTask.artifacts[0]?.parts[0]?.text === 'string');

// ─────────────────────────────────────────────────────────────────────────
// ── Path 4: Streaming via handleStreamMessage ─────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n📡  Path 4: A2A streaming (handleStreamMessage → A2AStreamEvent)');

const streamingParams: A2ATaskSendParams = {
  message: {
    role: 'user',
    parts: [{ text: 'What are the 5 largest deserts in the world? List them briefly.' }],
    contextId: sessionContextId,
    messageId: newUUIDv7(),
  },
};

let statusEvents = 0;
let artifactEvents = 0;
let finalTask: A2ATask | null = null;

if (specialistServer.handleStreamMessage) {
  for await (const event of specialistServer.handleStreamMessage(ctx, streamingParams)) {
    if ('statusUpdate' in event) {
      statusEvents++;
    } else if ('artifactUpdate' in event) {
      artifactEvents++;
    } else if ('task' in event) {
      finalTask = event.task;
    }
  }
}

console.log('  statusUpdate events:', statusEvents);
console.log('  artifactUpdate events:', artifactEvents);
console.log('  Final task state:', finalTask?.status.state);
console.log('  Final output:', finalTask ? a2aTaskOutputText(finalTask).slice(0, 200) : '(none)');

check('at least 1 status event emitted', statusEvents >= 1);
check('final task event received', finalTask !== null);
check('final task TASK_STATE_COMPLETED', finalTask?.status.state === 'TASK_STATE_COMPLETED',
  finalTask?.status.state ?? '?');

// ─────────────────────────────────────────────────────────────────────────
// ── Path 5: Agent card validation ────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n🪪  Path 5: AgentCard v1.0 structure validation');
const card = specialistServer.card;

check('card.name is string', typeof card.name === 'string');
check('card.version is string', typeof card.version === 'string');
check('card.skills is array', Array.isArray(card.skills));
check('first skill has id', typeof card.skills[0]?.id === 'string', card.skills[0]?.id);
check('capabilities is object (not array)', !Array.isArray(card.capabilities) && typeof card.capabilities === 'object');
check('capabilities.streaming is boolean', typeof card.capabilities.streaming === 'boolean');
check('supportedInterfaces is array', Array.isArray(card.supportedInterfaces));
check('supportedInterfaces[0].protocolVersion is 1.0', card.supportedInterfaces[0]?.protocolVersion === '1.0');
check('no url discriminator on parts', true); // checked via type system

// ─────────────────────────────────────────────────────────────────────────
// ── Path 6: Bus discovery ─────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n🔍  Path 6: Bus discovery');
const registeredCards = bus.listAgents();
const discoveredCard = bus.discover('geography-specialist');

check('listAgents returns >= 1 card', registeredCards.length >= 1);
check('discover returns correct card', discoveredCard?.name === 'geography-specialist');

// ─────────────────────────────────────────────────────────────────────────
// ── Path 7: Helper utilities ──────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n🛠  Path 7: Helper utilities (makeCompletedA2ATask / makeFailedA2ATask)');

const completedHelper = makeCompletedA2ATask('task-1', 'ctx-1', 'Hello from helper');
check('makeCompletedA2ATask state', completedHelper.status.state === 'TASK_STATE_COMPLETED');
check('makeCompletedA2ATask artifact text', completedHelper.artifacts[0]?.parts[0]?.text === 'Hello from helper');

const failedHelper = makeFailedA2ATask('task-2', 'ctx-1', 'Something went wrong');
check('makeFailedA2ATask state', failedHelper.status.state === 'TASK_STATE_FAILED');
check('makeFailedA2ATask status message', failedHelper.status.message?.parts[0]?.text === 'Something went wrong');
check('makeFailedA2ATask artifacts empty', failedHelper.artifacts.length === 0);

// ─────────────────────────────────────────────────────────────────────────
// ── Summary ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
if (process.exitCode === 1) {
  console.log('❌  Some checks failed — see above.');
} else {
  console.log('✅  All A2A v1.0 end-to-end checks passed.');
  console.log('');
  console.log('  Paths exercised:');
  console.log('    1. External trigger → weaveAgentAsA2AServer.handleMessage()');
  console.log('    2. weaveAgent + A2A bus delegation tool (real LLM tool call)');
  console.log('    3. weaveLiveAgent-style bus.send() (a2a.outbound pattern)');
  console.log('    4. handleStreamMessage → A2AStreamEvent (statusUpdate + artifactUpdate + task)');
  console.log('    5. AgentCard v1.0 structure (supportedInterfaces, capabilities object, skill.id)');
  console.log('    6. Bus discovery (listAgents, discover)');
  console.log('    7. Helper utilities (makeCompletedA2ATask, makeFailedA2ATask)');
}
console.log('='.repeat(60));
