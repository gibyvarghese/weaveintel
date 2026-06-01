/**
 * Example 128 — Runtime capabilities end-to-end.
 *
 * Demonstrates one runtime instance wiring every ambient capability together:
 *   - runtime.net.egress       (hardened fetch + SSRF guard)
 *   - runtime.observability    (in-memory tracer captures agent spans)
 *   - runtime.secrets          (secret resolution via runtime slot)
 *   - runtime.audit            (run/tool/output audit events)
 *   - runtime.persistence      (KV write/read through runtime slot)
 *   - runtime.resilience       (signal bus emit)
 *   - runtime.guardrails       (tool-call deny + output deny/redact)
 *   - requires assertions      (tool registration with capability requirements)
 *
 * Run:
 *   npx tsx examples/128-runtime-capabilities-e2e.ts
 */

import assert from 'node:assert/strict';

import {
  Capabilities,
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
import type { Model, ModelRequest, ModelResponse } from '@weaveintel/core';

type GuardrailDecision = { allow: boolean; reason?: string; redactedText?: string };

function modelCaps(withTools: boolean): ReadonlySet<string> {
  const ids = [Capabilities.Chat];
  if (withTools) ids.push(Capabilities.ToolCalling);
  return new Set(ids);
}

const audit: AuditEntry[] = [];
const tracer = weaveInMemoryTracer();
const emittedSignals: Array<{ kind: string; endpoint: string }> = [];

const guardrails: RuntimeGuardrailsSlot = {
  async checkToolCall(_ctx, schema: ToolSchema, args: Readonly<Record<string, unknown>>): Promise<GuardrailDecision> {
    if (schema.name === 'runtime_echo') {
      const text = String(args['text'] ?? '');
      if (text.includes('BLOCK_TOOL')) {
        return { allow: false, reason: 'tool payload denied by guardrails' };
      }
    }
    return { allow: true };
  },

  async checkOutput(_ctx, text: string): Promise<GuardrailDecision> {
    if (text.includes('FORBIDDEN_OUTPUT')) {
      return { allow: false, reason: 'output policy denied content' };
    }
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
  metadata: { example: '128-runtime-capabilities-e2e' },
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

console.log('--- secrets ---');
process.env['EX128_SECRET'] = 'runtime-secret-value';
const secret = await runtime.secrets.resolve('EX128_SECRET');
assert.equal(secret, 'runtime-secret-value');
console.log('resolved EX128_SECRET via runtime.secrets');

console.log('--- persistence ---');
assert.ok(runtime.persistence, 'runtime.persistence must be configured');
await runtime.persistence.kv.set('ex128:key', JSON.stringify({ ok: true }));
const persisted = await runtime.persistence.kv.get('ex128:key');
assert.equal(persisted, JSON.stringify({ ok: true }));
console.log('runtime.persistence.kv set/get succeeded');

console.log('--- resilience ---');
runtime.resilience?.emit({ kind: 'endpoint.degraded', endpoint: 'demo://tool/runtime_echo' });
assert.equal(emittedSignals.length, 1);
console.log('runtime.resilience.emit captured signal');

console.log('--- egress ---');
try {
  const r = await runtime.egress.fetch('https://example.com', undefined, {
    errorTag: 'example-128',
    timeoutMs: 5000,
  });
  console.log('egress https://example.com status:', r.status);
} catch (err) {
  console.log('egress outbound attempt failed (acceptable offline):', (err as Error).message);
}
await assert.rejects(
  runtime.egress.fetch('https://169.254.169.254/latest/meta-data/', undefined, {
    errorTag: 'example-128',
    timeoutMs: 5000,
  }),
);
console.log('SSRF guard blocked metadata endpoint as expected');

console.log('--- tool registry requires ---');
const tools = createToolRegistry({ runtime });
tools.register(
  defineTool({
    name: 'runtime_echo',
    description: 'Echo text payload for runtime capability verification.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
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

const noPersistenceRuntime = weaveRuntime({
  tracer,
  installDefaultTracer: false,
  tlsFloor: false,
});
const regWithoutPersistence = createToolRegistry({ runtime: noPersistenceRuntime });
assert.throws(() => {
  regWithoutPersistence.register(
    defineTool({
      name: 'requires_persistence',
      description: 'Intentional failure path for requires check.',
      parameters: { type: 'object', properties: {} },
      requires: [RuntimeCapabilities.Persistence],
      async execute() {
        return 'nope';
      },
    }),
  );
});
console.log('registration-time requires assertion verified');

function makeToolCallThenSafeOutputModel(toolText: string): Model {
  let step = 0;
  return {
    capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
    hasCapability(id) {
      return this.capabilities.has(id);
    },
    info: {
      provider: 'example',
      modelId: 'example-128-model',
      displayName: 'Example 128 Model',
      capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
      maxContextTokens: 4096,
    },
    async generate(_ctx, _req: ModelRequest): Promise<ModelResponse> {
      step += 1;
      if (step === 1) {
        return {
          id: `resp-${step}`,
          content: '',
          toolCalls: [{ id: 'tool-1', name: 'runtime_echo', arguments: JSON.stringify({ text: toolText }) }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: 'example-128-model',
        };
      }
      return {
        id: `resp-${step}`,
        content: 'Agent produced SECRET output after tool call',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'example-128-model',
      };
    },
  };
}

const forbiddenOutputModel: Model = {
  capabilities: modelCaps(false) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
  hasCapability(id) {
    return this.capabilities.has(id);
  },
  info: {
    provider: 'example',
    modelId: 'example-128-forbidden-model',
    displayName: 'Example 128 Forbidden Model',
    capabilities: modelCaps(false) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
    maxContextTokens: 4096,
  },
  async generate(): Promise<ModelResponse> {
    return {
      id: 'resp-forbidden',
      content: 'FORBIDDEN_OUTPUT: this should be blocked',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: 'example-128-forbidden-model',
    };
  },
};

console.log('--- guardrails + observability + audit via agent ---');
audit.length = 0;
tracer.clear();

const agentAllow = weaveAgent({
  name: 'ex128-agent-allow',
  model: makeToolCallThenSafeOutputModel('hello-runtime'),
  tools,
  maxSteps: 4,
});
const runAllow = await agentAllow.run(ctx, {
  goal: 'run allowed tool then redact output',
  messages: [{ role: 'user', content: 'hello' }],
});
assert.ok(runAllow.steps.some((s) => s.type === 'tool_call'));
assert.ok(runAllow.steps.some((s) => s.type === 'response' && s.content?.includes('[REDACTED]')));

const agentToolDenied = weaveAgent({
  name: 'ex128-agent-tool-denied',
  model: makeToolCallThenSafeOutputModel('BLOCK_TOOL payload'),
  tools,
  maxSteps: 4,
});
const runToolDenied = await agentToolDenied.run(ctx, {
  goal: 'tool should be denied by guardrails',
  messages: [{ role: 'user', content: 'deny tool' }],
});
assert.ok(runToolDenied.steps.some((s) => s.type === 'tool_call' && s.toolCall?.result?.includes('denied by guardrails')));

const agentOutputDenied = weaveAgent({
  name: 'ex128-agent-output-denied',
  model: forbiddenOutputModel,
  tools,
  maxSteps: 2,
});
const runOutputDenied = await agentOutputDenied.run(ctx, {
  goal: 'output should be denied by guardrails',
  messages: [{ role: 'user', content: 'deny output' }],
});
assert.ok(runOutputDenied.steps.some((s) => s.type === 'response' && s.content?.includes('blocked by guardrails')));

const auditActions = audit.map((a) => `${a.action}/${a.outcome}`);
console.log('audit actions:', auditActions);

for (const expected of [
  'agent.run.start/success',
  'agent.tool.invoke/success',
  'agent.tool.invoke/denied',
  'agent.output.denied/denied',
  'agent.run.end/success',
]) {
  assert.ok(auditActions.includes(expected), `missing audit action ${expected}`);
}

const spanNames = tracer.spans.map((s) => s.name);
console.log('recorded spans:', spanNames);
assert.ok(spanNames.includes('agents.model.generate'));
assert.ok(spanNames.includes('agents.tool.invoke'));

console.log('--- supervisor hierarchy (multi-agent) ---');

function makeWorkerModel(toolName: string, toolArgs: Record<string, unknown>, finalText: string): Model {
  let step = 0;
  return {
    capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
    hasCapability(id) {
      return this.capabilities.has(id);
    },
    info: {
      provider: 'example',
      modelId: `worker-${toolName}`,
      displayName: `Worker ${toolName}`,
      capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
      maxContextTokens: 4096,
    },
    async generate(): Promise<ModelResponse> {
      step += 1;
      if (step === 1) {
        return {
          id: `${toolName}-resp-${step}`,
          content: '',
          toolCalls: [{ id: `${toolName}-call`, name: toolName, arguments: JSON.stringify(toolArgs) }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: `worker-${toolName}`,
        };
      }
      return {
        id: `${toolName}-resp-${step}`,
        content: finalText,
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: `worker-${toolName}`,
      };
    },
  };
}

function makeSupervisorModel(): Model {
  let step = 0;
  return {
    capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
    hasCapability(id) {
      return this.capabilities.has(id);
    },
    info: {
      provider: 'example',
      modelId: 'supervisor-model',
      displayName: 'Supervisor Model',
      capabilities: modelCaps(true) as ReadonlySet<import('@weaveintel/core').CapabilityId>,
      maxContextTokens: 4096,
    },
    async generate(_ctx, _req): Promise<ModelResponse> {
      step += 1;
      if (step === 1) {
        return {
          id: `supervisor-resp-${step}`,
          content: '',
          toolCalls: [{
            id: 'delegate-1',
            name: 'delegate_to_worker',
            arguments: JSON.stringify({ worker: 'researcher', goal: 'collect runtime findings' }),
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: 'supervisor-model',
        };
      }
      if (step === 2) {
        return {
          id: `supervisor-resp-${step}`,
          content: '',
          toolCalls: [{
            id: 'delegate-2',
            name: 'delegate_to_worker',
            arguments: JSON.stringify({ worker: 'writer', goal: 'write short summary' }),
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: 'supervisor-model',
        };
      }
      return {
        id: `supervisor-resp-${step}`,
        content: 'Supervisor finished orchestration with two delegations.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'supervisor-model',
      };
    },
  };
}

const researcherTools = createToolRegistry({ runtime });
researcherTools.register(
  defineTool({
    name: 'research_lookup',
    description: 'Return deterministic research payload for supervisor demo.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    requires: [RuntimeCapabilities.NetEgress, RuntimeCapabilities.Persistence],
    async execute(args) {
      return `research:${String(args['topic'] ?? '')}`;
    },
  }),
);

const writerTools = createToolRegistry({ runtime });
writerTools.register(
  defineTool({
    name: 'draft_report',
    description: 'Return deterministic writer payload for supervisor demo.',
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

const supervisor = weaveAgent({
  name: 'ex128-supervisor',
  model: makeSupervisorModel(),
  workers: [
    {
      name: 'researcher',
      description: 'Research worker that uses research_lookup.',
      model: makeWorkerModel('research_lookup', { topic: 'runtime capabilities' }, 'research complete'),
      tools: researcherTools,
    },
    {
      name: 'writer',
      description: 'Writer worker that uses draft_report.',
      model: makeWorkerModel('draft_report', { notes: 'runtime summary' }, 'writer complete'),
      tools: writerTools,
    },
  ],
  maxSteps: 8,
});

const supervisorRun = await supervisor.run(ctx, {
  goal: 'orchestrate workers',
  messages: [{ role: 'user', content: 'run supervisor orchestration' }],
});
assert.ok(supervisorRun.steps.some((s) => s.type === 'tool_call' && s.toolCall?.name === 'delegate_to_worker'));
assert.ok(
  supervisorRun.steps.some((s) => s.type === 'response' && s.content?.includes('Supervisor finished orchestration')),
);
console.log('supervisor run complete with delegate_to_worker tool calls');

console.log('--- workflow engine with tool + agent handlers ---');

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
handlerRegistry.register(createToolResolver({
  async getTool(toolKey) {
    const tool = workflowTools.get(toolKey);
    if (!tool) return undefined;
    return async (input: Record<string, unknown>) => {
      const out = await tool.invoke(ctx, { name: toolKey, arguments: input });
      return { text: out.content };
    };
  },
}));
handlerRegistry.register(createAgentResolver({
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
}));

const engine = new DefaultWorkflowEngine({ runtime, resolverRegistry: handlerRegistry });
const workflow = defineWorkflow('Runtime Capability Workflow')
  .setId('ex128-runtime-workflow')
  .deterministic('echo-step', 'Echo Step', { handler: 'tool:wf_echo', next: 'supervise-step' })
  .agentic('supervise-step', 'Supervisor Step', { handler: 'agent:supervisor', next: 'summary-step' })
  .deterministic('summary-step', 'Summary Step', {
    handler:
      'script:return { summary: `echo=${String(variables["__step_echo-step"]?.text ?? "")}; supervisor=${String(variables["__step_supervise-step"]?.status ?? "")}` };',
  })
  .build();
await engine.createDefinition(workflow);

const workflowRun = await engine.startRun('ex128-runtime-workflow', {
  text: 'workflow hello',
  goal: 'workflow should invoke supervisor agent',
});
assert.equal(workflowRun.status, 'completed');
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'echo-step'));
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'supervise-step'));
assert.ok(workflowRun.state.history.some((h) => h.stepId === 'summary-step'));
console.log('workflow run completed with tool resolver + agent resolver');

const workflowAuditActions = audit.map((a) => `${a.action}/${a.outcome}`);
assert.ok(workflowAuditActions.some((a) => a.startsWith('workflow.run.start/')));
assert.ok(workflowAuditActions.some((a) => a.startsWith('workflow.run.end/')));
console.log('workflow runtime audit events observed');

console.log('\nExample 128 complete: runtime + supervisor + workflow capabilities verified end-to-end.');
