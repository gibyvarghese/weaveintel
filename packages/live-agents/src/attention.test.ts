import { describe, expect, it } from 'vitest';
import type { ExecutionContext, Model, ModelRequest, ModelResponse } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import type { AttentionContext, Message } from './types.js';
import { createModelAttentionPolicy } from './attention.js';

function fakeModel(content: string): Model {
  return {
    info: {
      provider: 'fake',
      modelId: 'fake-1',
      capabilities: new Set(),
    },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, _request: ModelRequest): Promise<ModelResponse> {
      return {
        id: 'res-1',
        content,
        finishReason: 'stop',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
        model: 'fake-1',
      };
    },
  };
}

function baseMessage(): Message {
  return {
    id: 'msg-1',
    meshId: 'mesh-1',
    fromType: 'HUMAN',
    fromId: 'human-1',
    fromMeshId: null,
    toType: 'AGENT',
    toId: 'agent-1',
    topic: 'test',
    kind: 'ASK',
    replyToMessageId: null,
    threadId: 'thread-1',
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: new Date().toISOString(),
    subject: 'Need help',
    body: 'Please process this message',
  };
}

function baseContext(overrides?: Partial<AttentionContext>): AttentionContext {
  return {
    nowIso: new Date().toISOString(),
    agent: {
      id: 'agent-1',
      meshId: 'mesh-1',
      name: 'Agent',
      role: 'Responder',
      contractVersionId: 'contract-1',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      archivedAt: null,
    },
    contract: null,
    inbox: [baseMessage()],
    backlog: [],
    activeBindings: [],
    model: fakeModel('{}'),
    ...overrides,
  };
}

describe('createModelAttentionPolicy', () => {
  it('returns model-selected ProcessMessage when valid', async () => {
    const policy = createModelAttentionPolicy({
      systemPrompt: 'You help with attention decisions',
    });

    const action = await policy.decide(
      baseContext({ model: fakeModel('{"action":{"type":"ProcessMessage","messageId":"msg-1"}}') }),
      weaveContext({ userId: 'human:ops' }),
    );
    expect(action).toEqual({ type: 'ProcessMessage', messageId: 'msg-1' });
  });

  it('falls back to standard policy when model output is invalid', async () => {
    const policy = createModelAttentionPolicy({
      systemPrompt: 'You help with attention decisions',
    });

    const action = await policy.decide(
      baseContext({ model: fakeModel('{"action":{"type":"UnknownAction"}}') }),
      weaveContext({ userId: 'human:ops' }),
    );
    expect(action.type).toBe('ProcessMessage');
  });

  it('uses model from context to make decisions', async () => {
    const policy = createModelAttentionPolicy({
      systemPrompt: 'You help with attention decisions',
    });

    const decisionModel = fakeModel('{"action":{"type":"ProcessMessage","messageId":"msg-1"}}');

    const action = await policy.decide(
      baseContext({ model: decisionModel }),
      weaveContext({ userId: 'human:ops', tenantId: 'tenant-1' }),
    );

    expect(action).toEqual({ type: 'ProcessMessage', messageId: 'msg-1' });
  });
});
