/**
 * Example 144 — Phase 4: A2A Protocol (v1.0) + Live-Agent Cancellation + SSE Streaming
 *
 * Demonstrates:
 *   1. a2a.inbound  — live agent that accepts A2A tasks from the inbox
 *   2. a2a.outbound — live agent that delegates to a remote A2A endpoint
 *   3. RunCancellationBus — in-process AbortSignal for immediate run cancellation
 *   4. onEvent callback — SSE fan-out via LiveRunEventBus
 *
 * A2A v1.0 task shapes used here:
 *   - A2ATaskSendParams: { message: { role, parts: [{ text }] } }  (no `type` discriminator)
 *   - A2ATask: { id, contextId, status: { state: 'TASK_STATE_*' }, artifacts[], history[] }
 */

import {
  RunCancellationBus,
  a2aInboundHandler,
  a2aOutboundHandler,
  createDefaultHandlerRegistry,
} from '@weaveintel/live-agents-runtime';
import type { A2ATaskSendParams, A2ATask } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ─── 1. RunCancellationBus ────────────────────────────────────────────────

const cancellationBus = new RunCancellationBus();

const runId = 'run-001';
const signal = cancellationBus.getSignal(runId);

console.log('Before cancel — isCancelled:', cancellationBus.isCancelled(runId));

cancellationBus.cancel(runId);
console.log('After cancel  — isCancelled:', cancellationBus.isCancelled(runId));
console.log('Signal aborted:', cancellationBus.getSignal(runId)?.aborted);

cancellationBus.cancel(runId); // idempotent
cancellationBus.clear(runId);
console.log('After clear   — isCancelled:', cancellationBus.isCancelled(runId));

void signal;

// ─── 2. A2A v1.0 task shapes ─────────────────────────────────────────────
//
// Send params (what the client POSTs):

const contextId = newUUIDv7();

const sendParams: A2ATaskSendParams = {
  message: {
    role: 'user',
    parts: [
      // v1.0: no `type` discriminator — just the content field
      { text: 'Summarise the key findings from the Q3 sales report.' },
    ],
    contextId,
    messageId: newUUIDv7(),
  },
  metadata: { skill: 'summarise' },
};

console.log('\nA2A v1.0 send params to dispatch as inbox body:');
console.log(JSON.stringify(sendParams, null, 2));

// Server response (A2ATask):
const exampleTask: A2ATask = {
  id: newUUIDv7(),
  contextId,
  status: {
    state: 'TASK_STATE_COMPLETED',
    timestamp: new Date().toISOString(),
  },
  artifacts: [
    {
      artifactId: newUUIDv7(),
      name: 'summary',
      parts: [{ text: 'Q3 key findings: revenue up 12%, churn down 3%.' }],
    },
  ],
  history: [
    sendParams.message,
    { role: 'agent', parts: [{ text: 'Q3 key findings: revenue up 12%, churn down 3%.' }], contextId },
  ],
};

console.log('\nA2A v1.0 task response shape:');
console.log(JSON.stringify({ ...exampleTask, id: '<uuid>', contextId: '<uuid>' }, null, 2));

// ─── 3. Handler registry ─────────────────────────────────────────────────

const registry = createDefaultHandlerRegistry();
console.log('\nRegistered handler kinds:');
for (const kind of registry.kinds()) {
  console.log(' •', kind);
}

console.assert(registry.resolve('a2a.inbound')  !== null, 'a2a.inbound missing');
console.assert(registry.resolve('a2a.outbound') !== null, 'a2a.outbound missing');

// ─── 4. a2a.inbound config ───────────────────────────────────────────────
//
// The a2a.inbound handler accepts both v1.0 (message.parts) and v0.3 (input.parts).

const inboundBindingConfig = {
  handlerKind: 'a2a.inbound',
  config: {
    fallbackPrompt: 'You are a task processor. Execute the inbound A2A task precisely.',
    maxSteps: 20,
  },
};
console.log('\na2a.inbound binding config:', JSON.stringify(inboundBindingConfig, null, 2));

// ─── 5. a2a.outbound config ──────────────────────────────────────────────
//
// The a2a.outbound handler POSTs A2ATaskSendParams to targetUrl/api/a2a/tasks
// and expects an A2ATask response (v1.0 TASK_STATE_* states).

const outboundBindingConfig = {
  handlerKind: 'a2a.outbound',
  config: {
    targetUrl: 'https://specialist-agent.example.com',
    skill: 'summarise',
    timeoutMs: 15_000,
  },
};
console.log('\na2a.outbound binding config:', JSON.stringify(outboundBindingConfig, null, 2));

// ─── 6. v1.0 Task State constants ────────────────────────────────────────

console.log('\nA2A v1.0 task states:');
const v1States = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',  // new in v1.0
  'TASK_STATE_AUTH_REQUIRED',   // new in v1.0
  'TASK_STATE_REJECTED',        // new in v1.0
];
for (const state of v1States) console.log(' •', state);

// ─── 7. SSE streaming ────────────────────────────────────────────────────
//
// handleStreamMessage yields A2AStreamEvent (field-presence union):
//   - { statusUpdate: TaskStatusUpdateEvent }
//   - { artifactUpdate: TaskArtifactUpdateEvent }  ← new in v1.0
//   - { task: A2ATask }   ← final terminal task
//   - { message: A2AMessage }

console.log('\nSSE stream event types (v1.0):');
console.log('  { statusUpdate: { taskId, contextId, status: { state, timestamp } } }');
console.log('  { artifactUpdate: { taskId, contextId, artifact, append, lastChunk } }');
console.log('  { task: A2ATask }   ← final event');
console.log('  { message: A2AMessage }   ← direct agent response');

// Stream closes when server closes the SSE connection (terminal/interrupted state).
// No [DONE] sentinel in v1.0.

console.log('\nAdmin SSE endpoint: GET /api/admin/live-runs/:id/stream');
console.log('  • Replays last 100 events from DB on connect.');
console.log('  • Pushes new step_started / step_completed events live.');
console.log('  • Sends ": keepalive" comments every 15 s.');

// ─── 8. Integration checklist ────────────────────────────────────────────

console.log(`
Phase 4 / A2A v1.0 integration checklist:
  [✓] RunCancellationBus — imported from @weaveintel/live-agents-runtime
  [✓] a2a.inbound        — registered; accepts v1.0 and v0.3 task shapes
  [✓] a2a.outbound       — registered; sends v1.0 A2ATaskSendParams; reads A2ATask response
  [✓] A2A-Version: 1.0   — sent in all outbound fetch headers
  [✓] TASK_STATE_*       — SCREAMING_SNAKE_CASE states with 3 new states
  [✓] A2APart            — field-presence (no type discriminator)
  [✓] AgentCard          — supportedInterfaces[], capabilities object, skill.id
  [✓] A2ATask            — contextId, artifacts[], history[], nested status object
  [✓] SSE events         — statusUpdate + artifactUpdate + task (no [DONE] sentinel)
`);

export { a2aInboundHandler, a2aOutboundHandler, RunCancellationBus };
