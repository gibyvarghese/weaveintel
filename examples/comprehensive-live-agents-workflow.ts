/// <reference types="node" />

/**
 * Comprehensive Live-Agents Workflow Example
 *
 * Run: npx tsx examples/comprehensive-live-agents-workflow.ts
 *
 * Scenario:
 * - Research mesh prepares a handoff
 * - Compliance mesh reviews the handoff via a cross-mesh bridge
 * - Legal mesh receives an escalation via a second bridge
 * - Account binding and MCP delivery are used for outbound updates
 * - Compression maintainer produces compressed context for long-running agents
 */

import type { AccessTokenResolver } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createActionExecutor,
  createCompressionMaintainer,
  createHeartbeat,
  createMcpAccountSessionProvider,
  weaveInMemoryStateStore,
  type AgentContract,
  type AttentionPolicy,
  type CrossMeshBridge,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = '2025-06-20T09:00:00.000Z';

  const researchMesh: Mesh = {
    id: 'mesh-research',
    tenantId: 'tenant-live-agents-comprehensive',
    name: 'Research Mesh',
    charter: 'Collect findings and produce evidence-backed handoffs.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const complianceMesh: Mesh = {
    id: 'mesh-compliance',
    tenantId: researchMesh.tenantId,
    name: 'Compliance Mesh',
    charter: 'Validate evidence quality and policy fit.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const legalMesh: Mesh = {
    id: 'mesh-legal',
    tenantId: researchMesh.tenantId,
    name: 'Legal Mesh',
    charter: 'Issue final legal sign-off and escalation responses.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  await store.saveMesh(researchMesh);
  await store.saveMesh(complianceMesh);
  await store.saveMesh(legalMesh);

  const researcher: LiveAgent = {
    id: 'agent-researcher',
    meshId: researchMesh.id,
    name: 'Alice',
    role: 'Research Analyst',
    contractVersionId: 'contract-researcher-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const reviewer: LiveAgent = {
    id: 'agent-reviewer',
    meshId: complianceMesh.id,
    name: 'Bob',
    role: 'Compliance Reviewer',
    contractVersionId: 'contract-reviewer-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const counsel: LiveAgent = {
    id: 'agent-counsel',
    meshId: legalMesh.id,
    name: 'Carol',
    role: 'Legal Counsel',
    contractVersionId: 'contract-counsel-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  await store.saveAgent(researcher);
  await store.saveAgent(reviewer);
  await store.saveAgent(counsel);

  const baseContract = (id: string, agentId: string, objectives: string): AgentContract => ({
    id,
    agentId,
    version: 1,
    persona: 'Operate within policy and produce clear, auditable outcomes.',
    objectives,
    successIndicators: 'Work is processed asynchronously with traceable artifacts.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    accountBindingRefs: [],
    attentionPolicyRef: 'comprehensive-policy',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [
        { id: 'rolling-conversation-summary' },
        { id: 'episodic-memory' },
        { id: 'contract-anchored-weighting' },
      ],
      budgets: {
        attentionTokensMax: 180,
        actionTokensMax: 1200,
        handoffTokensMax: 600,
        reportTokensMax: 600,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'operational',
    },
    createdAt: now,
  });

  await store.saveContract(baseContract('contract-researcher-v1', researcher.id, 'Generate research handoffs.'));
  await store.saveContract(baseContract('contract-reviewer-v1', reviewer.id, 'Review and escalate findings.'));
  await store.saveContract(baseContract('contract-counsel-v1', counsel.id, 'Assess legal publication risk.'));

  const researchToCompliance: CrossMeshBridge = {
    id: 'bridge-research-compliance',
    fromMeshId: researchMesh.id,
    toMeshId: complianceMesh.id,
    allowedAgentPairs: [{ fromAgentId: researcher.id, toAgentId: reviewer.id }],
    allowedTopics: ['research-handoff'],
    rateLimitPerHour: 20,
    authorisedByType: 'HUMAN',
    authorisedById: 'human:ops-admin-1',
    coAuthorisedByType: null,
    coAuthorisedById: null,
    effectiveFrom: now,
    effectiveTo: null,
    revokedAt: null,
    purposeProse: 'Research findings handoff.',
    constraintsProse: 'Only research-handoff topic allowed.',
  };

  const complianceToLegal: CrossMeshBridge = {
    id: 'bridge-compliance-legal',
    fromMeshId: complianceMesh.id,
    toMeshId: legalMesh.id,
    allowedAgentPairs: [{ fromAgentId: reviewer.id, toAgentId: counsel.id }],
    allowedTopics: ['legal-escalation'],
    rateLimitPerHour: 20,
    authorisedByType: 'HUMAN',
    authorisedById: 'human:ops-admin-1',
    coAuthorisedByType: null,
    coAuthorisedById: null,
    effectiveFrom: now,
    effectiveTo: null,
    revokedAt: null,
    purposeProse: 'Compliance escalations to legal.',
    constraintsProse: 'Only legal-escalation topic allowed.',
  };

  await store.saveCrossMeshBridge(researchToCompliance);
  await store.saveCrossMeshBridge(complianceToLegal);

  await store.saveMessage({
    id: 'msg-research-handoff',
    meshId: researchMesh.id,
    fromType: 'AGENT',
    fromId: researcher.id,
    fromMeshId: researchMesh.id,
    toType: 'AGENT',
    toId: reviewer.id,
    topic: 'research-handoff',
    kind: 'CONTEXT_HANDOFF',
    replyToMessageId: null,
    threadId: 'thread-research-handoff',
    contextRefs: ['artifact://finding/2025-06-20'],
    contextPacketRef: 'packet://handoff/research-2025-06-20',
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Validated finding package',
    body: 'Please perform compliance review on attached evidence packet.',
  });

  await store.saveMessage({
    id: 'msg-legal-escalation',
    meshId: complianceMesh.id,
    fromType: 'AGENT',
    fromId: reviewer.id,
    fromMeshId: complianceMesh.id,
    toType: 'AGENT',
    toId: counsel.id,
    topic: 'legal-escalation',
    kind: 'ESCALATION',
    replyToMessageId: null,
    threadId: 'thread-legal-escalation',
    contextRefs: ['artifact://compliance/review-2025-06-20'],
    contextPacketRef: 'packet://handoff/compliance-2025-06-20',
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Escalation for legal review',
    body: 'Potential publication risk needs legal sign-off.',
  });

  await store.saveAccount({
    id: 'account-gmail-ops',
    meshId: complianceMesh.id,
    provider: 'gmail',
    accountIdentifier: 'compliance@example.com',
    description: 'Compliance outbound updates mailbox.',
    mcpServerRef: {
      url: 'fixture://gmail-comprehensive',
      serverType: 'HTTP',
      discoveryHint: 'gmail.send',
    },
    credentialVaultRef: 'vault://compliance-gmail',
    upstreamScopesDescription: 'send-only',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: now,
    revokedAt: null,
  });

  await store.saveAccountBinding({
    id: 'binding-reviewer-gmail',
    agentId: reviewer.id,
    accountId: 'account-gmail-ops',
    purpose: 'Send compliance review updates.',
    constraints: 'No external recipients outside company domain.',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: now,
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });

  const { client, server } = weaveFakeTransport();
  const mcpServer = weaveMCPServer({ name: 'gmail-fixture', version: '1.0.0' });
  mcpServer.addTool(
    {
      name: 'gmail.send',
      description: 'Send a message.',
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
    async () => ({
      content: [
        { type: 'text', text: 'sent' },
        { type: 'resource', uri: 'gmail://messages/comprehensive-1' },
      ],
    }),
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
        return client;
      },
    },
  });

  const reviewerPolicy: AttentionPolicy = {
    key: 'reviewer-outbound-update',
    async decide() {
      return {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: 'ops-lead@example.com' },
        kind: 'REPORT',
        subject: 'Compliance review complete',
        bodySeed: 'Compliance review has completed. Escalation has been sent to legal.',
      };
    },
  };

  await store.saveHeartbeatTick({
    id: 'tick-reviewer-1',
    agentId: reviewer.id,
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
    workerId: 'worker-comprehensive-1',
    concurrency: 1,
    attentionPolicy: reviewerPolicy,
    actionExecutor: createActionExecutor({ sessionProvider }),
    now: () => now,
  });

  await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));

  const compressionEvents: Array<{ agentId: string; profile: string; artefactCount: number }> = [];
  const maintainer = createCompressionMaintainer({
    stateStore: store,
    runOnce: true,
    agentIds: [researcher.id, reviewer.id, counsel.id],
    onCompressed(payload) {
      compressionEvents.push({
        agentId: payload.agentId,
        profile: payload.profile,
        artefactCount: payload.artefactCount,
      });
    },
  });
  await maintainer.run(weaveContext({ tenantId: researchMesh.tenantId }));

  const reviewerInbox = await store.listMessagesForRecipient('AGENT', reviewer.id);
  const legalInbox = await store.listMessagesForRecipient('AGENT', counsel.id);
  const outbound = await store.listOutboundActionRecords(reviewer.id);

  console.log('Comprehensive live-agents workflow example completed.');
  console.log(`Reviewer inbox messages: ${reviewerInbox.length}`);
  console.log(`Legal inbox messages: ${legalInbox.length}`);
  console.log(`Outbound records (reviewer): ${outbound.length}`);
  console.log(`Compression runs: ${compressionEvents.length}`);

  await sessionProvider.disconnectAll?.();
  await mcpServer.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
