/**
 * Example 144 — Phase 4: A2A Protocol + Live-Agent Cancellation + SSE Streaming
 *
 * Demonstrates:
 *   1. a2a.inbound  — live agent that accepts A2A tasks from the inbox
 *   2. a2a.outbound — live agent that delegates to a remote A2A endpoint
 *   3. RunCancellationBus — in-process AbortSignal for immediate run cancellation
 *   4. onEvent callback — SSE fan-out via LiveRunEventBus
 *
 * These primitives are wired automatically when the generic supervisor boots
 * with LIVE_AGENTS_GENERIC_RUNTIME=1.
 */

import {
  RunCancellationBus,
  a2aInboundHandler,
  a2aOutboundHandler,
  createDefaultHandlerRegistry,
} from '@weaveintel/live-agents-runtime';
import type { A2ATask } from '@weaveintel/core';

// ─── 1. RunCancellationBus ────────────────────────────────────────────────
//
// Use it to cancel a long-running agent task without waiting for the next
// DB poll cycle (stop_requested flag). Both mechanisms can coexist:
//   - DB flag: survives process restarts, works across replicas.
//   - Bus signal: fires immediately in the same process.

const bus = new RunCancellationBus();

const runId = 'run-001';
const signal = bus.getSignal(runId); // undefined — not yet cancelled

console.log('Before cancel — isCancelled:', bus.isCancelled(runId)); // false

bus.cancel(runId);
console.log('After cancel  — isCancelled:', bus.isCancelled(runId)); // true
console.log('Signal aborted:', bus.getSignal(runId)?.aborted);       // true

// Idempotent — calling cancel again is safe.
bus.cancel(runId);

// Clean up when the run ends (prevents memory leak).
bus.clear(runId);
console.log('After clear   — isCancelled:', bus.isCancelled(runId)); // false

void signal; // the original signal reference remains aborted even after clear

// ─── 2. A2A task shape ───────────────────────────────────────────────────
//
// Any live agent's inbox message body can be an A2ATask JSON.
// `a2a.inbound` parses it and uses the text parts as the user goal.

const task: A2ATask = {
  id: 'task-abc123',
  skill: 'summarise',
  input: {
    role: 'user',
    parts: [
      { type: 'text', text: 'Summarise the key findings from the Q3 sales report.' },
    ],
  },
};

console.log('\nA2A task to dispatch as inbox body:');
console.log(JSON.stringify(task, null, 2));

// ─── 3. Handler registry ─────────────────────────────────────────────────
//
// createDefaultHandlerRegistry() now includes a2a.inbound + a2a.outbound
// in addition to the four Phase 6 built-ins.

const registry = createDefaultHandlerRegistry();
console.log('\nRegistered handler kinds:');
for (const kind of registry.kinds()) {
  console.log(' •', kind);
}

// Verify both new kinds are registered.
console.assert(registry.resolve('a2a.inbound')  !== null, 'a2a.inbound missing');
console.assert(registry.resolve('a2a.outbound') !== null, 'a2a.outbound missing');

// ─── 4. a2a.inbound config ───────────────────────────────────────────────
//
// Bind this to a live agent via live_agent_handler_bindings.config_json.
// The supervisor picks it up and calls `weaveLiveAgent` per tick.

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
// Bind this to a "delegator" agent that forwards inbox tasks to a remote
// A2A endpoint. No LLM is needed — it's a pure HTTP bridge.

const outboundBindingConfig = {
  handlerKind: 'a2a.outbound',
  config: {
    targetUrl: 'https://specialist-agent.example.com',
    skill: 'summarise',
    timeoutMs: 15_000,
  },
};
console.log('\na2a.outbound binding config:', JSON.stringify(outboundBindingConfig, null, 2));

// ─── 6. SSE streaming ────────────────────────────────────────────────────
//
// When LIVE_AGENTS_GENERIC_RUNTIME=1, the supervisor's onEvent callback
// fires into getLiveRunEventBus() for every step_started / step_completed
// event. The admin SSE endpoint subscribes:
//
//   GET /api/admin/live-runs/:id/stream
//
// Example client:
//
//   const es = new EventSource('/api/admin/live-runs/run-001/stream');
//   es.onmessage = (e) => {
//     const event = JSON.parse(e.data);
//     console.log(event.kind, event.summary);
//   };

console.log('\nSSE endpoint: GET /api/admin/live-runs/:id/stream');
console.log('  • Replays last 100 events from DB on connect.');
console.log('  • Pushes new step_started / step_completed events live.');
console.log('  • Sends ": keepalive" comments every 15 s.');

// ─── 7. Integration checklist ────────────────────────────────────────────

console.log(`
Phase 4 integration checklist:
  [✓] RunCancellationBus — imported from @weaveintel/live-agents-runtime
  [✓] a2a.inbound        — registered in createDefaultHandlerRegistry()
  [✓] a2a.outbound       — registered in createDefaultHandlerRegistry()
  [✓] supervisor.onEvent — wired to getLiveRunEventBus() in generic-supervisor-boot.ts
  [✓] /stop route        — calls getCancellationBus().cancel(runId) + supervisor.cancelRun(runId)
  [✓] SSE route          — GET /api/admin/live-runs/:id/stream (requires auth)
`);

export { a2aInboundHandler, a2aOutboundHandler, RunCancellationBus };
