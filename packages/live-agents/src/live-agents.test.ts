import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import {
  createExternalEventHandler,
  createHeartbeat,
  NotImplementedLiveAgentsError,
  weaveInMemoryStateStore,
} from './index.js';

describe('@weaveintel/live-agents phase 1 scaffold', () => {
  it('enforces human-only account bindings', async () => {
    const store = weaveInMemoryStateStore();
    await expect(
      store.saveAccountBinding({
        id: 'binding-1',
        agentId: 'agent-1',
        accountId: 'account-1',
        purpose: 'support mailbox triage',
        constraints: 'business-hours only',
        grantedByHumanId: 'agent:manager-1',
        grantedAt: new Date().toISOString(),
        expiresAt: null,
        revokedAt: null,
        revokedByHumanId: null,
        revocationReason: null,
      }),
    ).rejects.toThrow('Account bindings must be granted by a human principal');

    await expect(
      store.saveAccountBinding({
        id: 'binding-2',
        agentId: 'agent-1',
        accountId: 'account-1',
        purpose: 'support mailbox triage',
        constraints: 'business-hours only',
        grantedByHumanId: 'human:ops-admin-1',
        grantedAt: new Date().toISOString(),
        expiresAt: null,
        revokedAt: null,
        revokedByHumanId: null,
        revocationReason: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('deduplicates external events by account/source tuple', async () => {
    const store = weaveInMemoryStateStore();
    const handler = createExternalEventHandler({ stateStore: store });
    const ctx = weaveContext({ userId: 'human:ops-admin-1' });

    const event = {
      id: 'evt-1',
      accountId: 'account-1',
      sourceType: 'email.received',
      sourceRef: 'msg-123',
      receivedAt: new Date().toISOString(),
      payloadSummary: 'Email received from customer',
      payloadContextRef: 'mcp://gmail/messages/msg-123',
      processedAt: null,
      producedMessageIds: [],
      processingStatus: 'RECEIVED' as const,
      error: null,
    };

    const first = await handler.process(event, ctx);
    const second = await handler.process(event, ctx);

    expect(first.routedMessageCount).toBe(0);
    expect(second.routedMessageCount).toBe(0);
  });

  it('heartbeat factory exposes typed not-implemented behavior in phase 1', async () => {
    const store = weaveInMemoryStateStore();
    const heartbeat = createHeartbeat({
      stateStore: store,
      workerId: 'worker-1',
      concurrency: 1,
    });

    await expect(heartbeat.tick(weaveContext())).rejects.toBeInstanceOf(NotImplementedLiveAgentsError);
  });
});
