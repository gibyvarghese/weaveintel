import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  type Model,
  type ModelRequest,
  type ModelResponse,
  weaveCapabilities,
  weaveContext,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';
import { createApprovalDrivenAgent } from './createApprovalDrivenAgent.js';

function makeToolCallingModel(toolName: string): Model {
  const caps = weaveCapabilities(Capabilities.Chat, Capabilities.ToolCalling);

  return {
    info: {
      provider: 'test',
      modelId: 'test-model',
      displayName: 'Test Model',
      capabilities: caps.capabilities,
    },
    capabilities: caps.capabilities,
    hasCapability: caps.hasCapability,
    async generate(_ctx, request: ModelRequest): Promise<ModelResponse> {
      const hasToolResult = request.messages.some(m => m.role === 'tool');

      if (!hasToolResult) {
        return {
          id: 'r1',
          content: '',
          toolCalls: [{ id: 'tc1', name: toolName, arguments: '{}' }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: 'test-model',
        };
      }

      return {
        id: 'r2',
        content: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: 'test-model',
      };
    },
  };
}

describe('createApprovalDrivenAgent', () => {
  it('blocks approval-required tools at runtime', async () => {
    const registry = weaveToolRegistry();
    registry.register(weaveTool({
      name: 'delete_record',
      description: 'Delete a record',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'should not run';
      },
    }));

    const agent = createApprovalDrivenAgent({
      model: makeToolCallingModel('delete_record'),
      tools: registry,
      approvalRequired: ['delete_record'],
    });

    const result = await agent.run(weaveContext(), {
      messages: [{ role: 'user', content: 'delete that row' }],
    });

    const toolStep = result.steps.find(step => step.type === 'tool_call');
    expect(toolStep?.toolCall?.result).toContain('requires human approval');
  });

  it('allows non-gated tools to execute', async () => {
    const registry = weaveToolRegistry();
    registry.register(weaveTool({
      name: 'lookup_record',
      description: 'Lookup a record',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok';
      },
    }));

    const agent = createApprovalDrivenAgent({
      model: makeToolCallingModel('lookup_record'),
      tools: registry,
      approvalRequired: ['delete_record'],
    });

    const result = await agent.run(weaveContext(), {
      messages: [{ role: 'user', content: 'look it up' }],
    });

    const toolStep = result.steps.find(step => step.type === 'tool_call');
    expect(toolStep?.toolCall?.result).toBe('ok');
  });
});
