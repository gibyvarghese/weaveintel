/**
 * Example 124 — Ambient agent (Phase 3).
 *
 * The Phase 2 runtime is just a container of slots. Phase 3 wires those
 * slots into the agent loop and tool registry so a single
 * `weaveRuntime()` automatically gives every agent and tool:
 *
 *   - observed model + tool calls          (tracer)
 *   - audit entries at run + tool boundaries (audit)
 *   - guardrails approve/deny on tool args   (guardrails slot)
 *   - registration-time `requires` assertions (registry)
 *
 * No DB, no LLM, no external service — a stub model drives the loop.
 *
 *   npx tsx examples/124-ambient-agent.ts
 */

import {
  weaveRuntime,
  weaveContext,
  weaveTool as defineTool,
  weaveToolRegistry as createToolRegistry,
  RuntimeCapabilities,
  type AuditEntry,
  type AuditLogger,
  type RuntimeGuardrailsSlot,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveInMemoryTracer } from '@weaveintel/observability';
import type { Model, ModelMessage, ModelResponse } from '@weaveintel/core';

// ─── 1. Recording audit logger so the example can assert what was logged ──

const audit: AuditEntry[] = [];
const recordingAudit: AuditLogger = {
  async log(entry) { audit.push(entry); },
};

// ─── 2. Guardrails slot: deny a specific tool by name on demand ──────

let denyNext = false;
const guardrails: RuntimeGuardrailsSlot = {
  async checkToolCall(_ctx, schema, _args) {
    if (denyNext && schema.name === 'ping') {
      return { allow: false, reason: 'demo: explicit deny' };
    }
    return { allow: true };
  },
};

// ─── 3. Ambient runtime — one construction, used everywhere ─────────

const runtime = weaveRuntime({
  tracer: weaveInMemoryTracer(),
  audit: recordingAudit,
  guardrails,
});

const ctx = weaveContext({ runtime });

// ─── 4. Tool registry built with the runtime so requires are asserted ──

const tools = createToolRegistry({ runtime });
tools.register(
  defineTool({
    name: 'ping',
    description: 'Stub tool that returns "pong".',
    parameters: { type: 'object', properties: {} },
    requires: [RuntimeCapabilities.NetEgress],
    async execute() { return 'pong'; },
  }),
);

// ─── 5. Stub model: one tool call, then a final answer ──────────────

let call = 0;
const model: Model = {
  name: 'demo-stub',
  capabilities: { tools: true, streaming: false, vision: false, audio: false, embeddings: false, jsonMode: false, maxContextTokens: 8192 },
  async generate(_messages: ModelMessage[]): Promise<ModelResponse> {
    call += 1;
    if (call === 1) {
      return {
        content: '',
        toolCalls: [{ id: 't1', name: 'ping', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
    return {
      content: 'pong received',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  },
};

// ─── 6. Run the agent — ambient layers attach automatically ─────────

const agent = weaveAgent({ name: 'demo-agent', model, tools, maxSteps: 4 });
const result = await agent.run(ctx, { goal: 'say pong', messages: [{ role: 'user', content: 'hi' }] });

console.log('---');
console.log('final content:', result.finalContent);
console.log('steps:', result.steps.length);
console.log('audit actions:', audit.map((a) => `${a.action}/${a.outcome}`));

const must = ['agent.run.start', 'agent.tool.invoke', 'agent.run.end'];
for (const action of must) {
  if (!audit.find((a) => a.action === action)) {
    throw new Error(`expected audit action "${action}" not recorded`);
  }
}
console.log('OK: ambient audit + tracer fired without any explicit wiring at the agent call site');

// ─── 7. Re-run with guardrails denying the tool ─────────────────────

denyNext = true;
audit.length = 0;
call = 0;
const denied = await agent.run(weaveContext({ runtime }), { goal: 'denied', messages: [{ role: 'user', content: 'hi' }] });
const denyEntry = audit.find((a) => a.action === 'agent.tool.invoke' && a.outcome === 'denied');
if (!denyEntry) throw new Error('expected guardrails deny audit entry');
console.log('OK: guardrails denial captured in audit, agent continued gracefully ->', denied.finalContent);
