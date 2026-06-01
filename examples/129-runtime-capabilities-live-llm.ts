/**
 * Example 129 — Runtime capabilities with live LLM calls.
 *
 * This variant keeps the runtime wiring from example 128, but uses a real
 * provider model for supervisor and worker agents.
 *
 * Requirements:
 * - OPENAI_API_KEY in environment
 *
 * Run:
 *   set -a && source .env && set +a && npx tsx examples/129-runtime-capabilities-live-llm.ts
 */

import 'dotenv/config';
import assert from 'node:assert/strict';

import {
  RuntimeCapabilities,
  describeRuntimeCapabilities,
  weaveContext,
  weaveInMemoryPersistence,
  weaveRuntime,
  weaveTool as defineTool,
  weaveToolRegistry as createToolRegistry,
  weaveToolRegistry,
  type AuditEntry,
  type AuditLogger,
  type RuntimeGuardrailsSlot,
  type ToolSchema,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveInMemoryTracer } from '@weaveintel/observability';
import {
  DefaultWorkflowEngine,
  createAgentResolver,
  createHandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  defineWorkflow,
} from '@weaveintel/workflows';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

if (!process.env['OPENAI_API_KEY']) {
  throw new Error('OPENAI_API_KEY is required for example 129');
}

const audit: AuditEntry[] = [];
const tracer = weaveInMemoryTracer();
const emittedSignals: Array<{ kind: string; endpoint: string }> = [];

const guardrails: RuntimeGuardrailsSlot = {
  async checkToolCall(_ctx, schema: ToolSchema, args: Readonly<Record<string, unknown>>) {
    if (schema.name === 'runtime_echo' && String(args['text'] ?? '').includes('BLOCK_TOOL')) {
      return { allow: false, reason: 'tool payload denied by guardrails' };
    }
    return { allow: true };
  },
  async checkOutput(_ctx, text: string) {
    if (text.includes('SECRET')) {
      return { allow: true, redactedText: text.replaceAll('SECRET', '[REDACTED]') };
    }
    return { allow: true };
  },
};

const auditLogger: AuditLogger = {
  async log(entry) {
    audit.push(entry);
  },
};

const runtime = weaveRuntime({
  tracer,
  audit: auditLogger,
  guardrails,
  persistence: weaveInMemoryPersistence(),
  resilience: {
    emit(event) {
      emittedSignals.push({ kind: event.kind, endpoint: event.endpoint });
    },
  },
  metadata: { example: '129-runtime-capabilities-live-llm' },
  installDefaultTracer: false,
  tlsFloor: false,
});

const ctx = weaveContext({ runtime });

console.log('--- runtime capabilities ---');
console.log(describeRuntimeCapabilities(runtime));
assert.ok(runtime.has(RuntimeCapabilities.NetEgress));
assert.ok(runtime.has(RuntimeCapabilities.Observability));
assert.ok(runtime.has(RuntimeCapabilities.Secrets));
assert.ok(runtime.has(RuntimeCapabilities.Audit));
assert.ok(runtime.has(RuntimeCapabilities.Persistence));
assert.ok(runtime.has(RuntimeCapabilities.Resilience));
assert.ok(runtime.has(RuntimeCapabilities.Guardrails));

console.log('--- egress + secrets + persistence + resilience ---');
process.env['EX129_SECRET'] = 'runtime-secret-live';
const secret = await runtime.secrets.resolve('EX129_SECRET');
assert.equal(secret, 'runtime-secret-live');

await runtime.persistence?.kv.set('ex129:key', JSON.stringify({ ok: true }));
const persisted = await runtime.persistence?.kv.get('ex129:key');
assert.equal(persisted, JSON.stringify({ ok: true }));

runtime.resilience?.emit({ kind: 'endpoint.degraded', endpoint: 'demo://ex129' });
assert.equal(emittedSignals.length, 1);

const egressResponse = await runtime.egress.fetch('https://example.com', undefined, {
  errorTag: 'example-129',
  timeoutMs: 7000,
});
console.log('egress status:', egressResponse.status);
assert.equal(typeof egressResponse.status, 'number');
await assert.rejects(
  runtime.egress.fetch('https://169.254.169.254/latest/meta-data/', undefined, {
    errorTag: 'example-129',
    timeoutMs: 5000,
  }),
);

console.log('--- tool requires checks ---');
const sharedTools = createToolRegistry({ runtime });
sharedTools.register(
  defineTool({
    name: 'runtime_echo',
    description: 'Echo text payload for runtime checks.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    requires: [
      RuntimeCapabilities.NetEgress,
      RuntimeCapabilities.Persistence,
      RuntimeCapabilities.Resilience,
      RuntimeCapabilities.Guardrails,
    ],
    async execute(args) {
      return `echo:${String(args['text'] ?? '')}`;
    },
  }),
);

const researcherTools = createToolRegistry({ runtime });
researcherTools.register(
  defineTool({
    name: 'research_lookup',
    description: 'Collect deterministic findings for supervisor.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    requires: [RuntimeCapabilities.NetEgress, RuntimeCapabilities.Persistence],
    async execute(args) {
      return `findings:${String(args['topic'] ?? '')}`;
    },
  }),
);

const writerTools = createToolRegistry({ runtime });
writerTools.register(
  defineTool({
    name: 'draft_report',
    description: 'Draft a concise report from notes.',
    parameters: {
      type: 'object',
      properties: { notes: { type: 'string' } },
      required: ['notes'],
    },
    requires: [RuntimeCapabilities.Persistence, RuntimeCapabilities.Resilience],
    async execute(args) {
      return `report:${String(args['notes'] ?? '')}`;
    },
  }),
);

console.log('--- live supervisor (real LLM) ---');
const liveModel = weaveOpenAIModel('gpt-4o-mini', {
  apiKey: process.env['OPENAI_API_KEY'],
});

const supervisor = weaveAgent({
  name: 'ex129-supervisor',
  model: liveModel,
  workers: [
    {
      name: 'researcher',
      description: 'Research worker. Use research_lookup to gather facts.',
      model: liveModel,
      tools: researcherTools,
    },
    {
      name: 'writer',
      description: 'Writer worker. Use draft_report to produce summary text.',
      model: liveModel,
      tools: writerTools,
    },
  ],
  maxSteps: 10,
});

const supervisorRun = await supervisor.run(ctx, {
  goal: 'Delegate to researcher and writer. Return a short final summary.',
  messages: [
    {
      role: 'user',
      content:
        'Use delegate_to_worker to call researcher first, then writer. Final answer should be one short paragraph.',
    },
  ],
});

console.log('supervisor status:', supervisorRun.status);
console.log('supervisor output length:', supervisorRun.output.length);
assert.equal(supervisorRun.status, 'completed');
assert.ok(supervisorRun.steps.length > 0);

const delegated = supervisorRun.steps.some(
  (s) => s.type === 'tool_call' && s.toolCall?.name === 'delegate_to_worker',
);
console.log('delegate_to_worker observed:', delegated);

console.log('--- workflow with tool + agent handlers ---');
const workflowTools = weaveToolRegistry();
workflowTools.register(
  defineTool({
    name: 'wf_echo',
    description: 'Workflow-level echo tool.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    requires: [RuntimeCapabilities.Persistence],
    async execute(args) {
      return { content: `wf-echo:${String(args['text'] ?? '')}` };
    },
  }),
);

const handlerRegistry = createHandlerResolverRegistry();
handlerRegistry.register(createNoopResolver());
handlerRegistry.register(createScriptResolver());
handlerRegistry.register(
  createToolResolver({
    async getTool(toolKey) {
      const tool = workflowTools.get(toolKey);
      if (!tool) return undefined;
      return async (input: Record<string, unknown>) => {
        const out = await tool.invoke(ctx, { name: toolKey, arguments: input });
        return { text: out.content };
      };
    },
  }),
);
handlerRegistry.register(
  createAgentResolver({
    async invokeAgent(agentKey, variables) {
      if (agentKey !== 'supervisor') {
        throw new Error(`unknown workflow agent ${agentKey}`);
      }
      const goal = String(variables['goal'] ?? 'workflow goal');
      const res = await supervisor.run(ctx, {
        goal,
        messages: [{ role: 'user', content: goal }],
      });
      return { output: res.output, status: res.status, stepCount: res.steps.length };
    },
  }),
);

const engine = new DefaultWorkflowEngine({ runtime, resolverRegistry: handlerRegistry });
const workflow = defineWorkflow('Live Runtime Capability Workflow')
  .setId('ex129-runtime-workflow')
  .deterministic('echo-step', 'Echo Step', { handler: 'tool:wf_echo', next: 'supervise-step' })
  .agentic('supervise-step', 'Supervisor Step', { handler: 'agent:supervisor', next: 'summary-step' })
  .deterministic('summary-step', 'Summary Step', {
    handler:
      'script:return { summary: `echo=${String(variables["__step_echo-step"]?.text ?? "")}; supervisor=${String(variables["__step_supervise-step"]?.status ?? "")}` };',
  })
  .build();

await engine.createDefinition(workflow);
const workflowRun = await engine.startRun('ex129-runtime-workflow', {
  text: 'workflow hello',
  goal: 'Use supervisor to produce a concise summary from worker results.',
});

console.log('workflow status:', workflowRun.status);
assert.equal(workflowRun.status, 'completed');
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'echo-step'));
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'supervise-step'));
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'summary-step'));

const auditActions = audit.map((a) => `${a.action}/${a.outcome}`);
assert.ok(auditActions.some((a) => a.startsWith('agent.run.start/')));
assert.ok(auditActions.some((a) => a.startsWith('agent.run.end/')));
assert.ok(auditActions.some((a) => a.startsWith('workflow.run.start/')));
assert.ok(auditActions.some((a) => a.startsWith('workflow.run.end/')));

console.log('audit action count:', auditActions.length);
console.log('span count:', tracer.spans.length);
assert.ok(tracer.spans.length > 0);

console.log('\nExample 129 complete: runtime capabilities verified with live LLM-backed supervisor + workflow.');
