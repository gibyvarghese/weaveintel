/**
 * Example 39 — live-agents Phase 1 scaffold
 *
 * Run: npx tsx examples/39-live-agents-phase1.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createExternalEventHandler,
  weaveInMemoryStateStore,
  type Account,
  type AgentContract,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';
import { createNoopCompressor, weaveWorkingMemory } from '@weaveintel/memory';

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const store = weaveInMemoryStateStore();
  const ctx = weaveContext({ userId: 'human:ops-admin-1', tenantId: 'tenant-demo' });

  const mesh: Mesh = {
    id: 'mesh-1',
    tenantId: 'tenant-demo',
    name: 'Customer Operations Mesh',
    charter: 'Handle customer support asynchronously with accountable account bindings.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: nowIso(),
  };

  const agent: LiveAgent = {
    id: 'agent-1',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Researcher',
    contractVersionId: 'contract-1',
    status: 'ACTIVE',
    createdAt: nowIso(),
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-1',
    agentId: agent.id,
    version: 1,
    persona: 'You are Alice, a careful support researcher.',
    objectives: 'Triage incoming support requests and prepare evidence-backed replies.',
    successIndicators: 'Fast triage, clear summaries, escalation when blocked.',
    budget: { monthlyUsdCap: 100, perActionUsdCap: 5 },
    workingHoursSchedule: { timezone: 'UTC', cronActive: '0 8 * * 1-5' },
    accountBindingRefs: ['binding-1'],
    attentionPolicyRef: 'standard-v1',
    reviewCadence: '0 9 * * 1',
    contextPolicy: {
      compressors: [{ id: 'noop', onDemand: true }],
      weighting: [{ id: 'noop' }],
      budgets: {
        attentionTokensMax: 2048,
        actionTokensMax: 4096,
        handoffTokensMax: 2048,
        reportTokensMax: 2048,
        monthlyCompressionUsdCap: 5,
      },
      defaultsProfile: 'standard',
    },
    createdAt: nowIso(),
  };

  const account: Account = {
    id: 'account-1',
    meshId: mesh.id,
    provider: 'gmail',
    accountIdentifier: 'alice-support@example.com',
    description: 'Support mailbox account for customer operations',
    mcpServerRef: {
      url: 'https://mcp.example.com/gmail',
      serverType: 'HTTP',
      discoveryHint: 'Gmail operations: list, read, send',
    },
    credentialVaultRef: 'vault://credentials/alice-support-gmail',
    upstreamScopesDescription: 'Read + send only. No delete permission.',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: nowIso(),
    revokedAt: null,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);
  await store.saveAccount(account);
  await store.saveAccountBinding({
    id: 'binding-1',
    agentId: agent.id,
    accountId: account.id,
    purpose: 'Handle support triage inbox',
    constraints: 'Escalate refund requests to human',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: nowIso(),
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });

  const activeBindings = await store.listActiveAccountBindingsForAgent(agent.id, nowIso());

  const workingMemory = weaveWorkingMemory();
  await workingMemory.patch(ctx, agent.id, [
    { op: 'set', key: 'focus', value: 'customer-escalation-triage' },
    { op: 'set', key: 'nextAction', value: 'summarize new inbound messages' },
  ]);

  const compressor = createNoopCompressor();
  const artefact = await compressor.compress({
    agentId: agent.id,
    messages: [
      {
        id: 'msg-1',
        type: 'conversation',
        content: 'Customer asked for urgent shipment update.',
        metadata: {},
        createdAt: nowIso(),
      },
    ],
  }, ctx);

  const eventHandler = createExternalEventHandler({ stateStore: store });
  await eventHandler.process({
    id: 'event-1',
    accountId: account.id,
    sourceType: 'email.received',
    sourceRef: 'gmail-message-1',
    receivedAt: nowIso(),
    payloadSummary: 'New customer email asking about delayed shipment.',
    payloadContextRef: 'mcp://gmail/messages/gmail-message-1',
    processedAt: null,
    producedMessageIds: [],
    processingStatus: 'RECEIVED',
    error: null,
  }, ctx);

  const storedEvent = await store.findExternalEvent(account.id, 'email.received', 'gmail-message-1');

  console.log('Live-agents Phase 1 scaffold is wired and running.');
  console.log(`Mesh: ${mesh.name}`);
  console.log(`Agent: ${agent.name} (${agent.role})`);
  console.log(`Active bindings: ${activeBindings.length}`);
  console.log(`Compression artefact: ${artefact.id}`);
  console.log(`Stored event: ${storedEvent?.id ?? 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
