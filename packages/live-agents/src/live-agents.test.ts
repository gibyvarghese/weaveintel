import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import {
  createExternalEventHandler,
  InvalidAccountBindingError,
  createHeartbeat,
  NotImplementedLiveAgentsError,
  weaveInMemoryStateStore,
} from './index.js';

describe('@weaveintel/live-agents phase 1 scaffold', () => {
  it('enforces human-only account bindings', async () => {
    const store = weaveInMemoryStateStore();
    const now = new Date().toISOString();

    await store.saveAgent({
      id: 'agent-1',
      meshId: 'mesh-1',
      name: 'Alice',
      role: 'Researcher',
      contractVersionId: 'contract-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAccount({
      id: 'account-1',
      meshId: 'mesh-1',
      provider: 'gmail',
      accountIdentifier: 'alice@example.com',
      description: 'Alice support inbox',
      mcpServerRef: { url: 'https://mcp.example.com/gmail', serverType: 'HTTP', discoveryHint: null },
      credentialVaultRef: 'vault://alice',
      upstreamScopesDescription: 'read/send',
      ownerHumanId: 'human:ops-admin-1',
      status: 'ACTIVE',
      createdAt: now,
      revokedAt: null,
    });

    await expect(
      store.saveAccountBinding({
        id: 'binding-1',
        agentId: 'agent-1',
        accountId: 'account-1',
        purpose: 'support mailbox triage',
        constraints: 'business-hours only',
        grantedByHumanId: 'agent:manager-1',
        grantedAt: now,
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
        grantedAt: now,
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

  it('supports phase 2 mesh/team/delegation CRUD and message flow', async () => {
    const store = weaveInMemoryStateStore();
    const now = new Date().toISOString();

    await store.saveMesh({
      id: 'mesh-1',
      tenantId: 'tenant-1',
      name: 'Research Mesh',
      charter: 'Coordinate asynchronous research work.',
      status: 'ACTIVE',
      dualControlRequiredFor: ['MESH_BRIDGE'],
      createdAt: now,
    });

    await store.saveAgent({
      id: 'agent-a',
      meshId: 'mesh-1',
      name: 'Alice',
      role: 'Manager',
      contractVersionId: 'contract-a',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-b',
      meshId: 'mesh-1',
      name: 'Bob',
      role: 'Researcher',
      contractVersionId: 'contract-b',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-c',
      meshId: 'mesh-1',
      name: 'Carol',
      role: 'Researcher',
      contractVersionId: 'contract-c',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });

    await store.saveTeam({
      id: 'team-1',
      meshId: 'mesh-1',
      name: 'Signals Team',
      charter: 'Collect and summarize demand signals.',
      leadAgentId: 'agent-a',
    });
    await store.saveTeamMembership({
      id: 'tm-1',
      teamId: 'team-1',
      agentId: 'agent-b',
      roleInTeam: 'Analyst',
      joinedAt: now,
      leftAt: null,
    });

    await store.saveDelegationEdge({
      id: 'edge-1',
      meshId: 'mesh-1',
      fromAgentId: 'agent-a',
      toAgentId: 'agent-b',
      relationship: 'DIRECTS',
      relationshipProse: 'Alice directs Bob on market analysis tasks.',
      effectiveFrom: now,
      effectiveTo: null,
    });

    await store.saveMessage({
      id: 'msg-1',
      meshId: 'mesh-1',
      fromType: 'AGENT',
      fromId: 'agent-a',
      fromMeshId: 'mesh-1',
      toType: 'AGENT',
      toId: 'agent-b',
      topic: 'weekly-briefing',
      kind: 'TASK',
      replyToMessageId: null,
      threadId: 'thread-1',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'HIGH',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: now,
      subject: 'Prepare weekly demand summary',
      body: 'Draft a summary of top customer demand signals by Friday.',
    });

    await store.saveMessage({
      id: 'msg-2',
      meshId: 'mesh-1',
      fromType: 'AGENT',
      fromId: 'agent-b',
      fromMeshId: 'mesh-1',
      toType: 'AGENT',
      toId: 'agent-a',
      topic: 'weekly-briefing',
      kind: 'REPLY',
      replyToMessageId: 'msg-1',
      threadId: 'thread-1',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: now,
      subject: 'Re: Prepare weekly demand summary',
      body: 'Acknowledged. I will deliver the first draft tomorrow.',
    });

    const delivered = await store.transitionMessageStatus('msg-1', 'DELIVERED', now);
    const read = await store.transitionMessageStatus('msg-1', 'READ', now);
    const processed = await store.transitionMessageStatus('msg-1', 'PROCESSED', now);

    expect(delivered?.deliveredAt).toBe(now);
    expect(read?.readAt).toBe(now);
    expect(processed?.processedAt).toBe(now);

    const inboxB = await store.listMessagesForRecipient('AGENT', 'agent-b');
    const thread = await store.listThreadMessages('thread-1');
    const edges = await store.listDelegationEdges('mesh-1');
    const teamsForBob = await store.listTeamsForAgent('agent-b');

    expect(inboxB).toHaveLength(1);
    expect(thread).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(teamsForBob.map((team) => team.id)).toEqual(['team-1']);
  });

  it('supports phase 2 backlog lifecycle transitions', async () => {
    const store = weaveInMemoryStateStore();
    const now = new Date().toISOString();

    await store.saveBacklogItem({
      id: 'bl-1',
      agentId: 'agent-b',
      priority: 'HIGH',
      status: 'PROPOSED',
      originType: 'MESSAGE',
      originRef: 'msg-1',
      blockedOnMessageId: null,
      blockedOnGrantRequestId: null,
      blockedOnPromotionRequestId: null,
      blockedOnAccountBindingRequestId: null,
      estimatedEffort: 'PT2H',
      deadline: null,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      title: 'Draft weekly demand summary',
      description: 'Analyze incoming demand data and create briefing notes.',
    });

    const accepted = await store.transitionBacklogItemStatus('bl-1', 'ACCEPTED', now);
    const started = await store.transitionBacklogItemStatus('bl-1', 'IN_PROGRESS', now);
    const completed = await store.transitionBacklogItemStatus('bl-1', 'COMPLETED', now);

    expect(accepted?.acceptedAt).toBe(now);
    expect(started?.startedAt).toBe(now);
    expect(completed?.completedAt).toBe(now);

    const backlog = await store.listBacklogForAgent('agent-b');
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.status).toBe('COMPLETED');
  });

  it('supports phase 3 account and binding lifecycle with active filtering', async () => {
    const store = weaveInMemoryStateStore();
    const now = new Date().toISOString();

    await store.saveAgent({
      id: 'agent-acc-1',
      meshId: 'mesh-acc-1',
      name: 'Alice',
      role: 'Researcher',
      contractVersionId: 'contract-acc-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAccount({
      id: 'account-acc-1',
      meshId: 'mesh-acc-1',
      provider: 'gmail',
      accountIdentifier: 'alice@example.com',
      description: 'Alice support inbox',
      mcpServerRef: { url: 'https://mcp.example.com/gmail', serverType: 'HTTP', discoveryHint: null },
      credentialVaultRef: 'vault://alice',
      upstreamScopesDescription: 'read/send',
      ownerHumanId: 'human:admin-1',
      status: 'ACTIVE',
      createdAt: now,
      revokedAt: null,
    });

    await store.saveAccountBinding({
      id: 'binding-acc-1',
      agentId: 'agent-acc-1',
      accountId: 'account-acc-1',
      purpose: 'Handle support inbox',
      constraints: 'Escalate refunds',
      grantedByHumanId: 'human:admin-1',
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    });

    const activeBefore = await store.listActiveAccountBindingsForAgent('agent-acc-1', now);
    expect(activeBefore).toHaveLength(1);

    await store.revokeAccountBinding('binding-acc-1', 'human:admin-2', 'Offboarded account', now);
    const activeAfterBindingRevoke = await store.listActiveAccountBindingsForAgent('agent-acc-1', now);
    expect(activeAfterBindingRevoke).toHaveLength(0);

    await store.saveAccountBinding({
      id: 'binding-acc-2',
      agentId: 'agent-acc-1',
      accountId: 'account-acc-1',
      purpose: 'Temporary restoration',
      constraints: 'Read-only',
      grantedByHumanId: 'human:admin-1',
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    });

    await store.transitionAccountStatus('account-acc-1', 'REVOKED', now);
    const activeAfterAccountRevoke = await store.listActiveAccountBindingsForAgent('agent-acc-1', now);
    expect(activeAfterAccountRevoke).toHaveLength(0);
  });

  it('rejects invalid bindings and enforces human-only request resolution', async () => {
    const store = weaveInMemoryStateStore();
    const now = new Date().toISOString();

    await store.saveAgent({
      id: 'agent-bind-1',
      meshId: 'mesh-bind-1',
      name: 'Bob',
      role: 'Researcher',
      contractVersionId: 'contract-bind-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });

    await expect(
      store.saveAccountBinding({
        id: 'binding-missing-account',
        agentId: 'agent-bind-1',
        accountId: 'missing-account',
        purpose: 'Should fail',
        constraints: 'N/A',
        grantedByHumanId: 'human:admin-1',
        grantedAt: now,
        expiresAt: null,
        revokedAt: null,
        revokedByHumanId: null,
        revocationReason: null,
      }),
    ).rejects.toBeInstanceOf(InvalidAccountBindingError);

    await store.saveAccountBindingRequest({
      id: 'abr-1',
      meshId: 'mesh-bind-1',
      agentId: 'agent-bind-1',
      accountId: null,
      requestedByType: 'AGENT',
      requestedById: 'agent-bind-1',
      status: 'OPEN',
      resolvedByHumanId: null,
      resolvedAccountBindingId: null,
      createdAt: now,
      resolvedAt: null,
      expiresAt: null,
      purposeProse: 'Need account access for support triage.',
      reasonProse: 'Cannot process inbox without account.',
      resolutionReasonProse: null,
      evidenceRefs: ['msg-1'],
    });

    await expect(
      store.resolveAccountBindingRequest('abr-1', 'REJECTED', 'agent:manager-1', now, 'Only humans may resolve.'),
    ).rejects.toThrow('Account bindings must be granted by a human principal');

    const resolved = await store.resolveAccountBindingRequest(
      'abr-1',
      'REJECTED',
      'human:admin-1',
      now,
      'Deferred until audited inbox account is provisioned.',
    );
    expect(resolved?.status).toBe('REJECTED');
    expect(resolved?.resolvedByHumanId).toBe('human:admin-1');
  });
});
