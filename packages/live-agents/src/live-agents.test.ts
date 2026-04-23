import { describe, expect, it } from 'vitest';
import type { AccessTokenResolver } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  BreakGlassPolicyViolationError,
  ContractAuthorityViolationError,
  createActionExecutor,
  createCompressionMaintainer,
  createExternalEventHandler,
  GrantAuthorityViolationError,
  createLiveAgentsRuntime,
  createMcpAccountSessionProvider,
  InvalidAccountBindingError,
  NoAuthorisedAccountError,
  SelfPromotionForbiddenError,
  SelfGrantForbiddenError,
  createHeartbeat,
  type AttentionAction,
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

  it('heartbeat processes scheduled tick with standard-v1 attention policy', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';

    await store.saveAgent({
      id: 'agent-hb-1',
      meshId: 'mesh-hb-1',
      name: 'Heartbeat Agent',
      role: 'Coordinator',
      contractVersionId: 'contract-hb-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-hb-1',
      agentId: 'agent-hb-1',
      version: 1,
      persona: 'Coordinate work',
      objectives: 'Process inbox first',
      successIndicators: 'No pending inbox items',
      budget: {
        monthlyUsdCap: 50,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveMessage({
      id: 'msg-hb-1',
      meshId: 'mesh-hb-1',
      fromType: 'HUMAN',
      fromId: 'human:admin-1',
      fromMeshId: null,
      toType: 'AGENT',
      toId: 'agent-hb-1',
      topic: null,
      kind: 'ASK',
      replyToMessageId: null,
      threadId: 'thread-hb-1',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: now,
      subject: 'Please process this',
      body: 'Run the next step.',
    });
    await store.saveHeartbeatTick({
      id: 'tick-hb-1',
      agentId: 'agent-hb-1',
      scheduledFor: now,
      pickedUpAt: null,
      completedAt: null,
      workerId: 'scheduler',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });

    const heartbeat = createHeartbeat({
      stateStore: store,
      workerId: 'worker-1',
      concurrency: 1,
      now: () => now,
    });

    const result = await heartbeat.tick(weaveContext());
    const tick = await store.loadHeartbeatTick('tick-hb-1');
    const message = await store.loadMessage('msg-hb-1');

    expect(result.processed).toBe(1);
    expect(tick?.status).toBe('COMPLETED');
    expect(tick?.actionChosen?.type).toBe('ProcessMessage');
    expect(message?.status).toBe('PROCESSED');
  });

  it('action executor supports all phase 4 action variants', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-exec-1',
      meshId: 'mesh-exec-1',
      name: 'Executor Agent',
      role: 'Operator',
      contractVersionId: 'contract-exec-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-exec-2',
      meshId: 'mesh-exec-1',
      name: 'Recipient Agent',
      role: 'Operator',
      contractVersionId: 'contract-exec-2',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-exec-1',
      agentId: 'agent-exec-1',
      version: 1,
      persona: 'Executor persona',
      objectives: 'Execute action variants',
      successIndicators: 'All action variants are routable',
      budget: {
        monthlyUsdCap: 50,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: {
        mayIssueKinds: ['BUDGET_INCREASE', 'WORKING_HOURS_OVERRIDE', 'AUTHORITY_EXTENSION', 'COLLEAGUE_INTRODUCTION', 'MESH_BRIDGE'],
        scopePredicate: 'same mesh collaborators',
        maxBudgetIncreaseUsd: 100,
        requiresEvidence: false,
        dualControl: false,
      },
      contractAuthority: {
        canIssueContracts: true,
        canIssuePromotions: true,
        scopePredicate: 'same mesh collaborators',
        requiresEvidence: false,
      },
      breakGlass: {
        allowedCapabilityKinds: ['AUTHORITY_EXTENSION', 'MESH_BRIDGE'],
        maxDurationMinutes: 60,
        requiredEmergencyConditionsDescription: 'incident emergency outage',
      },
      accountBindingRefs: ['account-exec-1'],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveContract({
      id: 'contract-exec-2',
      agentId: 'agent-exec-2',
      version: 1,
      persona: 'Recipient persona',
      objectives: 'Receive promotions',
      successIndicators: 'Can transition contracts safely',
      budget: {
        monthlyUsdCap: 50,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveBacklogItem({
      id: 'bl-exec-1',
      agentId: 'agent-exec-1',
      priority: 'NORMAL',
      status: 'ACCEPTED',
      originType: 'SELF',
      originRef: null,
      blockedOnMessageId: null,
      blockedOnGrantRequestId: null,
      blockedOnPromotionRequestId: null,
      blockedOnAccountBindingRequestId: null,
      estimatedEffort: 'PT1H',
      deadline: null,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      title: 'Do work',
      description: 'Work item',
    });
    await store.saveMessage({
      id: 'msg-exec-1',
      meshId: 'mesh-exec-1',
      fromType: 'HUMAN',
      fromId: 'human:admin-1',
      fromMeshId: null,
      toType: 'AGENT',
      toId: 'agent-exec-1',
      topic: null,
      kind: 'ASK',
      replyToMessageId: null,
      threadId: 'thread-exec-1',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: now,
      subject: 'Question',
      body: 'Please answer',
    });
    await store.saveAccount({
      id: 'account-exec-1',
      meshId: 'mesh-exec-1',
      provider: 'github',
      accountIdentifier: 'org/repo',
      description: 'Repo account',
      mcpServerRef: { url: 'https://mcp.example.com/github', serverType: 'HTTP', discoveryHint: null },
      credentialVaultRef: 'vault://github',
      upstreamScopesDescription: 'repo',
      ownerHumanId: 'human:admin-1',
      status: 'ACTIVE',
      createdAt: now,
      revokedAt: null,
    });
    await store.saveAccountBinding({
      id: 'binding-exec-1',
      agentId: 'agent-exec-1',
      accountId: 'account-exec-1',
      purpose: 'repo access',
      constraints: 'safe writes',
      grantedByHumanId: 'human:admin-1',
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    });

    const actions: AttentionAction[] = [
      { type: 'ProcessMessage', messageId: 'msg-exec-1' } as const,
      { type: 'ContinueTask', backlogItemId: 'bl-exec-1' } as const,
      { type: 'StartTask', backlogItemId: 'bl-exec-1' } as const,
      {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: null },
        kind: 'REPORT' as const,
        subject: 'Update',
        bodySeed: 'Body',
      },
      {
        type: 'RequestCapability',
        capability: {
          kindHint: 'AUTHORITY_EXTENSION' as const,
          descriptionProse: 'Need authority',
          reasonProse: 'Blocked',
          evidenceMessageIds: ['msg-exec-1'],
        },
      },
      { type: 'RequestAccountBinding', account: 'account-exec-1', purposeProse: 'Need access' },
      {
        type: 'RequestPromotion',
        targetRole: 'Senior Operator',
        reasonProse: 'Consistent delivery',
        evidenceMessageIds: ['msg-exec-1'],
      },
      {
        type: 'IssueGrant',
        recipientAgentId: 'agent-exec-2',
        capability: {
          kindHint: 'BUDGET_INCREASE' as const,
          descriptionProse: 'Increase budget',
          scopeProse: 'Sprint',
          durationHint: 'P1W',
          reasonProse: 'Scale throughput',
        },
      },
      {
        type: 'IssuePromotion',
        recipientAgentId: 'agent-exec-2',
        newContractDraft: {
          role: 'Senior Operator',
          objectives: 'Run delivery',
          successIndicators: 'SLA met',
        },
        reasonProse: 'Promotion approved',
      },
      { type: 'EscalateToHuman', reasonProse: 'Need human decision', optionsProse: 'Approve or defer' },
      {
        type: 'InvokeBreakGlass',
        capability: {
          kindHint: 'AUTHORITY_EXTENSION' as const,
          descriptionProse: 'Emergency bridge',
          reasonProse: 'Incident emergency outage',
          evidenceMessageIds: ['msg-exec-1'],
        },
        emergencyReasonProse: 'Critical incident emergency outage affecting customers',
      },
      { type: 'EmitEpisodicMarker', summaryProse: 'Checkpointed run', tags: ['phase4'] },
      { type: 'RequestCompressionRefresh' as const },
      { type: 'CheckpointAndRest', nextTickAt: '2025-01-01T00:15:00.000Z' },
      { type: 'NoopRest', nextTickAt: '2025-01-01T00:20:00.000Z' },
    ];

    for (const action of actions) {
      const output = await executor.execute(
        action,
        {
          tickId: 'tick-exec-1',
          nowIso: now,
          stateStore: store,
          agent: {
            id: 'agent-exec-1',
            meshId: 'mesh-exec-1',
            name: 'Executor Agent',
            role: 'Operator',
            contractVersionId: 'contract-exec-1',
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          },
          activeBindings: [
            {
              id: 'binding-exec-1',
              agentId: 'agent-exec-1',
              accountId: 'account-exec-1',
              purpose: 'repo access',
              constraints: 'safe writes',
              grantedByHumanId: 'human:admin-1',
              grantedAt: now,
              expiresAt: null,
              revokedAt: null,
              revokedByHumanId: null,
              revocationReason: null,
            },
          ],
        },
        weaveContext(),
      );
      expect(output.status).toMatch(/SUCCESS|PARTIAL/);
    }
  });

  it('phase 5 delivers external draft messages through a pooled MCP account session', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const deliveries: Array<Record<string, unknown>> = [];
    let transportCreateCount = 0;

    const { client, server } = weaveFakeTransport();
    const mcpServer = weaveMCPServer({ name: 'gmail-fixture', version: '1.0.0' });
    mcpServer.addTool(
      {
        name: 'gmail.send',
        description: 'Send an email through Gmail.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      async (_ctx, args) => {
        deliveries.push(args);
        return {
          content: [
            { type: 'text', text: 'sent fixture email' },
            { type: 'resource', uri: `gmail://messages/${deliveries.length}` },
          ],
        };
      },
    );
    await mcpServer.start(server);

    const tokenResolver: AccessTokenResolver = {
      async resolve() {
        return 'fixture-token';
      },
      async revoke() {
        return;
      },
    };

    const sessionProvider = createMcpAccountSessionProvider({
      tokenResolver,
      transportFactory: {
        async createTransport() {
          transportCreateCount += 1;
          return client;
        },
      },
    });
    const executor = createActionExecutor({ sessionProvider });

    await store.saveAgent({
      id: 'agent-mcp-1',
      meshId: 'mesh-mcp-1',
      name: 'Mailer',
      role: 'Coordinator',
      contractVersionId: 'contract-mcp-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAccount({
      id: 'account-mcp-1',
      meshId: 'mesh-mcp-1',
      provider: 'gmail',
      accountIdentifier: 'mailer@example.com',
      description: 'Fixture Gmail account',
      mcpServerRef: { url: 'fixture://gmail', serverType: 'HTTP', discoveryHint: 'gmail send fixture' },
      credentialVaultRef: 'vault://mailer',
      upstreamScopesDescription: 'send only',
      ownerHumanId: 'human:admin-1',
      status: 'ACTIVE',
      createdAt: now,
      revokedAt: null,
    });
    await store.saveAccountBinding({
      id: 'binding-mcp-1',
      agentId: 'agent-mcp-1',
      accountId: 'account-mcp-1',
      purpose: 'Send customer updates',
      constraints: 'Low-risk transactional mail only',
      grantedByHumanId: 'human:admin-1',
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    });

    const baseContext = {
      tickId: 'tick-mcp-1',
      nowIso: now,
      stateStore: store,
      agent: {
        id: 'agent-mcp-1',
        meshId: 'mesh-mcp-1',
        name: 'Mailer',
        role: 'Coordinator',
        contractVersionId: 'contract-mcp-1',
        status: 'ACTIVE' as const,
        createdAt: now,
        archivedAt: null,
      },
      activeBindings: [
        {
          id: 'binding-mcp-1',
          agentId: 'agent-mcp-1',
          accountId: 'account-mcp-1',
          purpose: 'Send customer updates',
          constraints: 'Low-risk transactional mail only',
          grantedByHumanId: 'human:admin-1',
          grantedAt: now,
          expiresAt: null,
          revokedAt: null,
          revokedByHumanId: null,
          revocationReason: null,
        },
      ],
    };

    await executor.execute(
      {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: 'customer@example.com' },
        kind: 'REPORT',
        subject: 'Status update',
        bodySeed: 'Your request is complete.',
      },
      baseContext,
      weaveContext({ userId: 'human:admin-1' }),
    );

    await executor.execute(
      {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: 'customer@example.com' },
        kind: 'REPORT',
        subject: 'Follow-up',
        bodySeed: 'Please let us know if you need anything else.',
      },
      { ...baseContext, tickId: 'tick-mcp-2' },
      weaveContext({ userId: 'human:admin-1' }),
    );

    const outboundRecords = await store.listOutboundActionRecords('agent-mcp-1');
    const deliveredMessages = await store.listMessagesForRecipient('HUMAN', 'customer@example.com');

    expect(transportCreateCount).toBe(1);
    expect(deliveries).toEqual([
      {
        to: 'customer@example.com',
        subject: 'Status update',
        body: 'Your request is complete.',
      },
      {
        to: 'customer@example.com',
        subject: 'Follow-up',
        body: 'Please let us know if you need anything else.',
      },
    ]);
    expect(outboundRecords).toHaveLength(2);
    expect(outboundRecords.every((record) => record.status === 'SENT' && record.mcpToolName === 'gmail.send')).toBe(true);
    expect(deliveredMessages.every((message) => message.status === 'DELIVERED')).toBe(true);

    await sessionProvider.disconnectAll?.();
    await mcpServer.stop();
  });

  it('phase 5 rejects external delivery when no authorised account is bound', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const tokenResolver: AccessTokenResolver = {
      async resolve() {
        return 'fixture-token';
      },
      async revoke() {
        return;
      },
    };

    const executor = createActionExecutor({
      sessionProvider: createMcpAccountSessionProvider({
        tokenResolver,
        transportFactory: {
          async createTransport() {
            throw new Error('transport should not be created without an authorised account');
          },
        },
      }),
    });

    await expect(
      executor.execute(
        {
          type: 'DraftMessage',
          to: { type: 'HUMAN', id: 'customer@example.com' },
          kind: 'REPORT',
          subject: 'Status update',
          bodySeed: 'Your request is complete.',
        },
        {
          tickId: 'tick-mcp-missing',
          nowIso: now,
          stateStore: store,
          agent: {
            id: 'agent-mcp-missing',
            meshId: 'mesh-mcp-missing',
            name: 'Mailer',
            role: 'Coordinator',
            contractVersionId: 'contract-mcp-missing',
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          },
          activeBindings: [],
        },
        weaveContext({ userId: 'human:admin-1' }),
      ),
    ).rejects.toBeInstanceOf(NoAuthorisedAccountError);
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

  it('phase 6 reclaims stale in-progress ticks when lease expires', async () => {
    const store = weaveInMemoryStateStore();
    const staleNow = '2025-01-01T00:00:00.000Z';
    const reclaimNow = '2025-01-01T00:01:00.000Z';

    await store.saveHeartbeatTick({
      id: 'tick-lease-reclaim-1',
      agentId: 'agent-lease-reclaim-1',
      scheduledFor: staleNow,
      pickedUpAt: staleNow,
      completedAt: null,
      workerId: 'worker-old',
      leaseExpiresAt: '2025-01-01T00:00:10.000Z',
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'IN_PROGRESS',
    });

    const claimed = await store.claimNextTicks('worker-new', reclaimNow, 1, 5_000);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.workerId).toBe('worker-new');
    expect(claimed[0]?.status).toBe('IN_PROGRESS');
    expect(claimed[0]?.leaseExpiresAt).not.toBeNull();
    expect(Date.parse(claimed[0]?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.parse(reclaimNow));
  });

  it('phase 6 avoids double-execution with two workers sharing the same store', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    let executed = 0;

    await store.saveAgent({
      id: 'agent-mw-1',
      meshId: 'mesh-mw-1',
      name: 'Multi Worker Agent',
      role: 'Coordinator',
      contractVersionId: 'contract-mw-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-mw-1',
      agentId: 'agent-mw-1',
      version: 1,
      persona: 'Coordinator',
      objectives: 'Run exactly once.',
      successIndicators: 'Single execution across workers',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      accountBindingRefs: [],
      attentionPolicyRef: 'phase6-multi-worker',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveHeartbeatTick({
      id: 'tick-mw-1',
      agentId: 'agent-mw-1',
      scheduledFor: now,
      pickedUpAt: null,
      completedAt: null,
      workerId: 'scheduler',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });

    const attentionPolicy = {
      key: 'phase6-multi-worker',
      async decide() {
        return {
          type: 'NoopRest' as const,
          nextTickAt: '2025-01-01T00:05:00.000Z',
        };
      },
    };

    const actionExecutor = {
      async execute() {
        executed += 1;
        return {
          status: 'SUCCESS' as const,
          summaryProse: 'Executed once.',
          createdMessageIds: [],
          createdOutboundRecordIds: [],
          updatedBacklogItemIds: [],
          artifacts: [],
        };
      },
    };

    const worker1 = createHeartbeat({
      stateStore: store,
      workerId: 'worker-a',
      concurrency: 1,
      now: () => now,
      attentionPolicy,
      actionExecutor,
    });
    const worker2 = createHeartbeat({
      stateStore: store,
      workerId: 'worker-b',
      concurrency: 1,
      now: () => now,
      attentionPolicy,
      actionExecutor,
    });

    const [result1, result2] = await Promise.all([
      worker1.tick(weaveContext({ userId: 'human:admin-1' })),
      worker2.tick(weaveContext({ userId: 'human:admin-1' })),
    ]);

    const finalTick = await store.loadHeartbeatTick('tick-mw-1');
    expect(result1.processed + result2.processed).toBe(1);
    expect(executed).toBe(1);
    expect(finalTick?.status).toBe('COMPLETED');
  });

  it('phase 6 pauses agents when budget guardrail triggers', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';

    await store.saveAgent({
      id: 'agent-budget-1',
      meshId: 'mesh-budget-1',
      name: 'Budget Guardrail Agent',
      role: 'Coordinator',
      contractVersionId: 'contract-budget-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-budget-1',
      agentId: 'agent-budget-1',
      version: 1,
      persona: 'Coordinator',
      objectives: 'Respect budget limits',
      successIndicators: 'Pause when budget is exhausted',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 0,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveHeartbeatTick({
      id: 'tick-budget-1',
      agentId: 'agent-budget-1',
      scheduledFor: now,
      pickedUpAt: null,
      completedAt: null,
      workerId: 'scheduler',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });

    const heartbeat = createHeartbeat({
      stateStore: store,
      workerId: 'worker-budget-1',
      concurrency: 1,
      now: () => now,
    });

    const result = await heartbeat.tick(weaveContext({ userId: 'human:admin-1' }));
    const tick = await store.loadHeartbeatTick('tick-budget-1');
    const agent = await store.loadAgent('agent-budget-1');

    expect(result.processed).toBe(1);
    expect(tick?.status).toBe('SKIPPED');
    expect(tick?.actionOutcomeStatus).toBe('SKIPPED');
    expect(tick?.actionOutcomeProse).toContain('budget guardrail');
    expect(agent?.status).toBe('PAUSED');
  });

  it('phase 7 forbids self-grants outside break-glass', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';

    await store.saveAgent({
      id: 'agent-self-grant-1',
      meshId: 'mesh-self-grant-1',
      name: 'Self Grant Agent',
      role: 'Operator',
      contractVersionId: 'contract-self-grant-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-self-grant-1',
      agentId: 'agent-self-grant-1',
      version: 1,
      persona: 'Operator',
      objectives: 'Issue grants responsibly',
      successIndicators: 'No invalid grants',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: {
        mayIssueKinds: ['AUTHORITY_EXTENSION'],
        scopePredicate: 'same mesh',
        maxBudgetIncreaseUsd: null,
        requiresEvidence: false,
        dualControl: false,
      },
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    await expect(
      store.saveCapabilityGrant({
        id: 'grant-self-grant-1',
        meshId: 'mesh-self-grant-1',
        recipientType: 'AGENT',
        recipientId: 'agent-self-grant-1',
        issuerType: 'AGENT',
        issuerId: 'agent-self-grant-1',
        kind: 'AUTHORITY_EXTENSION',
        trigger: 'DELEGATE',
        grantedAt: now,
        expiresAt: null,
        revokedAt: null,
        revokedByType: null,
        revokedById: null,
        probation: false,
        probationUntil: null,
        descriptionProse: 'Self-grant attempt',
        scopeProse: 'self',
        reasonProse: 'unauthorized',
        revocationReasonProse: null,
        probationConditionsProse: null,
        limits: {},
        evidenceRefs: [],
      }),
    ).rejects.toBeInstanceOf(SelfGrantForbiddenError);
  });

  it('phase 7 enforces grant authority for IssueGrant action', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-issuer-1',
      meshId: 'mesh-phase7-1',
      name: 'Issuer',
      role: 'Operator',
      contractVersionId: 'contract-issuer-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-recipient-1',
      meshId: 'mesh-phase7-1',
      name: 'Recipient',
      role: 'Operator',
      contractVersionId: 'contract-recipient-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-issuer-1',
      agentId: 'agent-issuer-1',
      version: 1,
      persona: 'Issuer persona',
      objectives: 'Issue grants',
      successIndicators: 'Controlled grants only',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: {
        mayIssueKinds: ['COLLEAGUE_INTRODUCTION'],
        scopePredicate: 'same mesh only',
        maxBudgetIncreaseUsd: null,
        requiresEvidence: true,
        dualControl: false,
      },
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    await expect(
      executor.execute(
        {
          type: 'IssueGrant',
          recipientAgentId: 'agent-recipient-1',
          capability: {
            kindHint: 'AUTHORITY_EXTENSION',
            descriptionProse: 'Need extension',
            scopeProse: 'workflow scope',
            durationHint: null,
            reasonProse: 'No evidence attached',
          },
        },
        {
          tickId: 'tick-phase7-issuer-1',
          nowIso: now,
          stateStore: store,
          agent: {
            id: 'agent-issuer-1',
            meshId: 'mesh-phase7-1',
            name: 'Issuer',
            role: 'Operator',
            contractVersionId: 'contract-issuer-1',
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          },
          activeBindings: [],
        },
        weaveContext({ userId: 'human:admin-1' }),
      ),
    ).rejects.toBeInstanceOf(GrantAuthorityViolationError);
  });

  it('phase 7 break-glass creates invocation + grant and rejected review suspends agent', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-breakglass-1',
      meshId: 'mesh-breakglass-1',
      name: 'Responder',
      role: 'Operator',
      contractVersionId: 'contract-breakglass-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-breakglass-1',
      agentId: 'agent-breakglass-1',
      version: 1,
      persona: 'Incident responder',
      objectives: 'Handle emergencies',
      successIndicators: 'Safe emergency actions',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: {
        mayIssueKinds: ['AUTHORITY_EXTENSION'],
        scopePredicate: 'same mesh',
        maxBudgetIncreaseUsd: null,
        requiresEvidence: false,
        dualControl: false,
      },
      breakGlass: {
        allowedCapabilityKinds: ['AUTHORITY_EXTENSION'],
        maxDurationMinutes: 30,
        requiredEmergencyConditionsDescription: 'emergency outage',
      },
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    const result = await executor.execute(
      {
        type: 'InvokeBreakGlass',
        capability: {
          kindHint: 'AUTHORITY_EXTENSION',
          descriptionProse: 'Emergency authority extension',
          reasonProse: 'Need immediate mitigation rights',
          evidenceMessageIds: ['msg-incident-1'],
        },
        emergencyReasonProse: 'Customer-impacting emergency outage in production',
      },
      {
        tickId: 'tick-breakglass-1',
        nowIso: now,
        stateStore: store,
        agent: {
          id: 'agent-breakglass-1',
          meshId: 'mesh-breakglass-1',
          name: 'Responder',
          role: 'Operator',
          contractVersionId: 'contract-breakglass-1',
          status: 'ACTIVE',
          createdAt: now,
          archivedAt: null,
        },
        activeBindings: [],
      },
      weaveContext({ userId: 'human:admin-1' }),
    );

    expect(result.status).toBe('SUCCESS');
    const invocations = await store.listBreakGlassInvocations('agent-breakglass-1');
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    const grant = await store.loadCapabilityGrant(invocation.grantId);
    expect(grant?.trigger).toBe('BREAK_GLASS');

    await store.reviewBreakGlassInvocation(invocation.id, 'REJECTED', now);
    const updatedAgent = await store.loadAgent('agent-breakglass-1');
    expect(updatedAgent?.status).toBe('SUSPENDED');
  });

  it('phase 7 validates emergency-condition matching for break-glass', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-breakglass-2',
      meshId: 'mesh-breakglass-2',
      name: 'Responder',
      role: 'Operator',
      contractVersionId: 'contract-breakglass-2',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-breakglass-2',
      agentId: 'agent-breakglass-2',
      version: 1,
      persona: 'Incident responder',
      objectives: 'Handle emergencies',
      successIndicators: 'Safe emergency actions',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      breakGlass: {
        allowedCapabilityKinds: ['AUTHORITY_EXTENSION'],
        maxDurationMinutes: 30,
        requiredEmergencyConditionsDescription: 'critical outage',
      },
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    await expect(
      executor.execute(
        {
          type: 'InvokeBreakGlass',
          capability: {
            kindHint: 'AUTHORITY_EXTENSION',
            descriptionProse: 'Emergency authority extension',
            reasonProse: 'Need temporary rights',
            evidenceMessageIds: [],
          },
          emergencyReasonProse: 'minor maintenance window adjustment',
        },
        {
          tickId: 'tick-breakglass-2',
          nowIso: now,
          stateStore: store,
          agent: {
            id: 'agent-breakglass-2',
            meshId: 'mesh-breakglass-2',
            name: 'Responder',
            role: 'Operator',
            contractVersionId: 'contract-breakglass-2',
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          },
          activeBindings: [],
        },
        weaveContext({ userId: 'human:admin-1' }),
      ),
    ).rejects.toBeInstanceOf(BreakGlassPolicyViolationError);
  });

  it('phase 7 supports all active grant triggers in the state store', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const triggers = [
      'REQUEST',
      'DELEGATE',
      'SCOPE_CHANGE',
      'RECOMMENDATION',
      'PROBATION',
      'BREAK_GLASS',
      'ROLE_CHANGE',
      'SUCCESSION',
      'USER_INITIATED',
      'REFUSAL_REMEDIATION',
    ] as const;

    await store.saveAgent({
      id: 'agent-grant-target-1',
      meshId: 'mesh-grant-triggers-1',
      name: 'Target',
      role: 'Operator',
      contractVersionId: 'contract-grant-target-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });

    for (const [index, trigger] of triggers.entries()) {
      await store.saveCapabilityGrant({
        id: `grant-trigger-${index + 1}`,
        meshId: 'mesh-grant-triggers-1',
        recipientType: 'AGENT',
        recipientId: 'agent-grant-target-1',
        issuerType: 'HUMAN',
        issuerId: 'human:admin-1',
        kind: 'AUTHORITY_EXTENSION',
        trigger,
        grantedAt: now,
        expiresAt: null,
        revokedAt: null,
        revokedByType: null,
        revokedById: null,
        probation: trigger === 'PROBATION',
        probationUntil: trigger === 'PROBATION' ? '2025-01-02T00:00:00.000Z' : null,
        descriptionProse: `Grant for ${trigger}`,
        scopeProse: 'test scope',
        reasonProse: 'test reason',
        revocationReasonProse: null,
        probationConditionsProse: trigger === 'PROBATION' ? 'must satisfy review' : null,
        limits: {},
        evidenceRefs: [],
      });
    }

    const grants = await store.listCapabilityGrantsForRecipient('AGENT', 'agent-grant-target-1');
    expect(grants).toHaveLength(triggers.length);
    expect(new Set(grants.map((grant) => grant.trigger))).toEqual(new Set(triggers));
  });

  it('phase 8 self-request promotion creates promotion request record', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-promo-self-1',
      meshId: 'mesh-phase8-self-1',
      name: 'Worker',
      role: 'Operator',
      contractVersionId: 'contract-promo-self-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-promo-self-1',
      agentId: 'agent-promo-self-1',
      version: 1,
      persona: 'Worker persona',
      objectives: 'Grow role responsibly',
      successIndicators: 'Promotion requests are clear',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    const output = await executor.execute(
      {
        type: 'RequestPromotion',
        targetRole: 'Senior Operator',
        reasonProse: 'Delivered consistently for two quarters',
        evidenceMessageIds: ['msg-promo-evidence-1'],
      },
      {
        tickId: 'tick-promo-self-1',
        nowIso: now,
        stateStore: store,
        agent: {
          id: 'agent-promo-self-1',
          meshId: 'mesh-phase8-self-1',
          name: 'Worker',
          role: 'Operator',
          contractVersionId: 'contract-promo-self-1',
          status: 'ACTIVE',
          createdAt: now,
          archivedAt: null,
        },
        activeBindings: [],
      },
      weaveContext({ userId: 'human:admin-1' }),
    );

    expect(output.status).toBe('SUCCESS');
    const requests = await store.listPromotionRequests('mesh-phase8-self-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestedById).toBe('agent-promo-self-1');
    expect(requests[0]?.recipientId).toBe('agent-promo-self-1');
  });

  it('phase 8 manager-issued promotion creates new contract and promotion record', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-manager-1',
      meshId: 'mesh-phase8-issue-1',
      name: 'Manager',
      role: 'Manager',
      contractVersionId: 'contract-manager-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-worker-1',
      meshId: 'mesh-phase8-issue-1',
      name: 'Worker',
      role: 'Operator',
      contractVersionId: 'contract-worker-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });

    await store.saveContract({
      id: 'contract-manager-1',
      agentId: 'agent-manager-1',
      version: 1,
      persona: 'Manager persona',
      objectives: 'Manage growth',
      successIndicators: 'Safe role transitions',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: {
        canIssueContracts: true,
        canIssuePromotions: true,
        scopePredicate: 'same mesh',
        requiresEvidence: false,
      },
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveContract({
      id: 'contract-worker-1',
      agentId: 'agent-worker-1',
      version: 1,
      persona: 'Worker persona',
      objectives: 'Deliver operator tasks',
      successIndicators: 'Steady delivery',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    const output = await executor.execute(
      {
        type: 'IssuePromotion',
        recipientAgentId: 'agent-worker-1',
        newContractDraft: {
          role: 'Senior Operator',
          objectives: 'Lead operator workflows',
          successIndicators: 'Team throughput improves',
        },
        reasonProse: 'Consistent delivery and mentoring contributions',
      },
      {
        tickId: 'tick-promo-issue-1',
        nowIso: now,
        stateStore: store,
        agent: {
          id: 'agent-manager-1',
          meshId: 'mesh-phase8-issue-1',
          name: 'Manager',
          role: 'Manager',
          contractVersionId: 'contract-manager-1',
          status: 'ACTIVE',
          createdAt: now,
          archivedAt: null,
        },
        activeBindings: [],
      },
      weaveContext({ userId: 'human:admin-1' }),
    );

    expect(output.status).toBe('SUCCESS');
    const worker = await store.loadAgent('agent-worker-1');
    expect(worker?.role).toBe('Senior Operator');

    const promotions = await store.listPromotionsForAgent('agent-worker-1');
    expect(promotions).toHaveLength(1);
    expect(promotions[0]?.issuedById).toBe('agent-manager-1');

    const latestContract = await store.loadLatestContractForAgent('agent-worker-1');
    expect(latestContract?.version).toBe(2);
    expect(latestContract?.objectives).toBe('Lead operator workflows');
  });

  it('phase 8 forbids self-issued promotions', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';

    await store.saveAgent({
      id: 'agent-self-promo-1',
      meshId: 'mesh-phase8-selfpromo-1',
      name: 'Self Promoter',
      role: 'Operator',
      contractVersionId: 'contract-self-promo-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-self-promo-1',
      agentId: 'agent-self-promo-1',
      version: 1,
      persona: 'Operator persona',
      objectives: 'Operate',
      successIndicators: 'Stable operations',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: {
        canIssueContracts: true,
        canIssuePromotions: true,
        scopePredicate: 'self',
        requiresEvidence: false,
      },
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    await expect(
      store.savePromotion({
        id: 'promotion-self-1',
        agentId: 'agent-self-promo-1',
        fromContractVersionId: 'contract-self-promo-1',
        toContractVersionId: 'contract-self-promo-2',
        trigger: 'USER_INITIATED',
        issuedByType: 'AGENT',
        issuedById: 'agent-self-promo-1',
        issuedAt: now,
        scopeDeltaSummaryProse: 'Self promote',
        evidenceRefs: [],
      }),
    ).rejects.toBeInstanceOf(SelfPromotionForbiddenError);
  });

  it('phase 8 enforces issuer contract authority for promotions', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-01-01T00:00:00.000Z';
    const executor = createActionExecutor();

    await store.saveAgent({
      id: 'agent-noauthority-1',
      meshId: 'mesh-phase8-noauthority-1',
      name: 'No Authority',
      role: 'Operator',
      contractVersionId: 'contract-noauthority-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveAgent({
      id: 'agent-target-1',
      meshId: 'mesh-phase8-noauthority-1',
      name: 'Target',
      role: 'Operator',
      contractVersionId: 'contract-target-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-noauthority-1',
      agentId: 'agent-noauthority-1',
      version: 1,
      persona: 'No authority persona',
      objectives: 'Operate only',
      successIndicators: 'No unauthorized actions',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveContract({
      id: 'contract-target-1',
      agentId: 'agent-target-1',
      version: 1,
      persona: 'Target persona',
      objectives: 'Operate',
      successIndicators: 'Steady',
      budget: {
        monthlyUsdCap: 100,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 1000,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });

    await expect(
      executor.execute(
        {
          type: 'IssuePromotion',
          recipientAgentId: 'agent-target-1',
          newContractDraft: {
            role: 'Senior Operator',
            objectives: 'Lead',
            successIndicators: 'Faster delivery',
          },
          reasonProse: 'No authority but trying to promote',
        },
        {
          tickId: 'tick-promo-noauthority-1',
          nowIso: now,
          stateStore: store,
          agent: {
            id: 'agent-noauthority-1',
            meshId: 'mesh-phase8-noauthority-1',
            name: 'No Authority',
            role: 'Operator',
            contractVersionId: 'contract-noauthority-1',
            status: 'ACTIVE',
            createdAt: now,
            archivedAt: null,
          },
          activeBindings: [],
        },
        weaveContext({ userId: 'human:admin-1' }),
      ),
    ).rejects.toBeInstanceOf(ContractAuthorityViolationError);
  });
});

describe('@weaveintel/live-agents phase 9 compression maintainer', () => {
  it('initializes runtime with default compression toolkit', () => {
    const runtime = createLiveAgentsRuntime();
    expect(runtime.compressors.size).toBe(10);
    expect(runtime.compressors.has('rolling-conversation-summary')).toBe(true);
  });

  it('runs compression and emits callback payload for active agents', async () => {
    const store = weaveInMemoryStateStore();
    const now = '2025-03-01T00:00:00.000Z';

    await store.saveMesh({
      id: 'mesh-phase9-1',
      tenantId: 'tenant-1',
      name: 'Phase9 Mesh',
      charter: 'Validate compression maintainer',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    });
    await store.saveAgent({
      id: 'agent-phase9-1',
      meshId: 'mesh-phase9-1',
      name: 'Phase9 Agent',
      role: 'Operator',
      contractVersionId: 'contract-phase9-1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    });
    await store.saveContract({
      id: 'contract-phase9-1',
      agentId: 'agent-phase9-1',
      version: 1,
      persona: 'Compress context',
      objectives: 'Maintain concise active context',
      successIndicators: 'Context remains within token budget',
      budget: {
        monthlyUsdCap: 50,
        perActionUsdCap: 5,
      },
      workingHoursSchedule: {
        timezone: 'UTC',
        cronActive: '* * * * *',
      },
      grantAuthority: null,
      contractAuthority: null,
      breakGlass: null,
      accountBindingRefs: [],
      attentionPolicyRef: 'standard-v1',
      reviewCadence: 'P1D',
      contextPolicy: {
        compressors: [],
        weighting: [{ id: 'episodic-memory' }, { id: 'contract-anchored-weighting' }],
        budgets: {
          attentionTokensMax: 120,
          actionTokensMax: 1000,
          handoffTokensMax: 500,
          reportTokensMax: 500,
          monthlyCompressionUsdCap: 10,
        },
        defaultsProfile: 'standard',
      },
      createdAt: now,
    });
    await store.saveMessage({
      id: 'msg-phase9-1',
      meshId: 'mesh-phase9-1',
      fromType: 'HUMAN',
      fromId: 'human:ops-admin-1',
      fromMeshId: null,
      toType: 'AGENT',
      toId: 'agent-phase9-1',
      topic: null,
      kind: 'REPORT',
      replyToMessageId: null,
      threadId: 'thread-phase9-1',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: now,
      subject: 'Daily update',
      body: 'Escalation has been resolved and SLA recovered.',
    });

    const observed: Array<{ agentId: string; profile: string; rendered: string; artefactCount: number }> = [];
    const maintainer = createCompressionMaintainer({
      stateStore: store,
      runOnce: true,
      agentIds: ['agent-phase9-1'],
      onCompressed(payload) {
        observed.push(payload);
      },
    });

    await maintainer.run(weaveContext({ tenantId: 'tenant-1' }));

    expect(observed).toHaveLength(1);
    expect(observed[0]?.agentId).toBe('agent-phase9-1');
    expect(observed[0]?.profile).toBe('standard');
    expect(observed[0]?.artefactCount).toBe(2);
    expect(observed[0]?.rendered.length).toBeGreaterThan(0);
  });
});
