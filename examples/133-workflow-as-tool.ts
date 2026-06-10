/**
 * Example 133 — Workflow-as-tool adapter (W4)
 *
 * Demonstrates wrapping a workflow as a weaveTool so an agent can trigger
 * a multi-step workflow process within its ReAct loop.
 *
 * Key concepts:
 *   • `weaveWorkflowTool` — creates a tool that starts a workflow run
 *   • Completed workflows return JSON `{ status, output, runId }`
 *   • Missing/failed workflows return `{ status: "failed", error, runId: "" }`
 *
 * Run: npx tsx examples/133-workflow-as-tool.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveWorkflowTool } from '@weaveintel/recipes';
import { weaveContext, weaveToolRegistry, Capabilities } from '@weaveintel/core';
import type { Model, ExecutionContext, ModelRequest, ModelResponse } from '@weaveintel/core';
import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemoryWorkflowDefinitionStore,
  createNoopResolver,
} from '@weaveintel/workflows';

const baseUsage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

function makeSequenceModel(name: string, responses: ModelResponse[]): Model {
  let call = 0;
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  return {
    info: { provider: 'stub', modelId: name, capabilities: caps, displayName: name },
    capabilities: caps,
    hasCapability(id) { return caps.has(id); },
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      const resp = responses[call % responses.length]!;
      call++;
      return resp;
    },
  };
}

async function main() {
  // ── Scenario A: workflow completes normally ───────────────────────────────
  console.log('=== Scenario A: Workflow completes normally ===');

  const store = new InMemoryWorkflowDefinitionStore();
  const resolver = new HandlerResolverRegistry();
  resolver.register(createNoopResolver());

  await store.save({
    id: 'validate-input',
    name: 'Input Validation Pipeline',
    version: '1',
    steps: [
      { id: 'step1', name: 'Validate', handler: 'noop:validate', next: 'step2' },
      { id: 'step2', name: 'Score',    handler: 'noop:score',    next: null },
    ],
  });

  const engine = new DefaultWorkflowEngine({ store, registry: resolver });

  const validationTool = weaveWorkflowTool({
    engine,
    workflowId: 'validate-input',
    name: 'run_validation',
    description: 'Run the input validation pipeline on the provided data',
    inputSchema: {
      type: 'object',
      properties: { data: { type: 'string' } },
      required: ['data'],
    },
  });

  const toolsA = weaveToolRegistry();
  toolsA.register(validationTool);

  const agentModelA = makeSequenceModel('agent-A', [
    {
      id: 'r1', model: 'agent-A', content: '', finishReason: 'tool_calls', usage: baseUsage,
      toolCalls: [{ id: 't1', name: 'run_validation', arguments: JSON.stringify({ data: 'test-payload' }) }],
    },
    {
      id: 'r2', model: 'agent-A', content: 'Validation pipeline completed successfully for test-payload.', toolCalls: [], finishReason: 'stop', usage: baseUsage,
    },
  ]);

  const agentA = weaveAgent({ model: agentModelA, tools: toolsA, maxSteps: 5, name: 'workflow-tool-demo' });
  const ctx = weaveContext({});
  const resultA = await agentA.run(ctx, {
    messages: [{ role: 'user', content: 'Please validate the test payload' }],
  });

  console.log('Status :', resultA.status);
  console.log('Output :', resultA.output);
  console.log('Steps  :', resultA.steps.length);

  const toolStepA = resultA.steps.find((s) => s.toolCall?.name === 'run_validation');
  if (toolStepA?.toolCall?.result) {
    try {
      const r = JSON.parse(toolStepA.toolCall.result) as { status: string; runId: string; output?: string };
      console.log('Workflow status :', r.status);
      console.log('Run ID          :', r.runId);
    } catch {
      console.log('Tool result     :', toolStepA.toolCall.result.slice(0, 100));
    }
  }

  // ── Scenario B: unknown workflow → tool returns failed JSON ───────────────
  console.log('\n=== Scenario B: Unknown workflow → tool returns failed ===');

  const missingTool = weaveWorkflowTool({
    engine,
    workflowId: 'non-existent-workflow',
    name: 'run_missing',
    description: 'Starts a workflow that does not exist',
  });

  const toolsB = weaveToolRegistry();
  toolsB.register(missingTool);

  const agentModelB = makeSequenceModel('agent-B', [
    {
      id: 'r3', model: 'agent-B', content: '', finishReason: 'tool_calls', usage: baseUsage,
      toolCalls: [{ id: 't2', name: 'run_missing', arguments: '{}' }],
    },
    {
      id: 'r4', model: 'agent-B', content: 'The workflow failed — I will handle this gracefully.', toolCalls: [], finishReason: 'stop', usage: baseUsage,
    },
  ]);

  const agentB = weaveAgent({ model: agentModelB, tools: toolsB, maxSteps: 5, name: 'workflow-fail-demo' });
  const resultB = await agentB.run(ctx, {
    messages: [{ role: 'user', content: 'Run the missing workflow' }],
  });

  console.log('Status :', resultB.status);
  console.log('Output :', resultB.output);

  const toolStepB = resultB.steps.find((s) => s.toolCall?.name === 'run_missing');
  if (toolStepB?.toolCall?.result) {
    try {
      const r = JSON.parse(toolStepB.toolCall.result) as { status: string; error?: string; runId: string };
      console.log('Tool result status :', r.status);
      console.log('Error              :', (r.error ?? '').slice(0, 80));
    } catch {
      console.log('Tool result        :', toolStepB.toolCall.result.slice(0, 100));
    }
  }
}

main().catch(console.error);
