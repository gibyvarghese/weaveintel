/**
 * Example 52 - live-agents basic
 *
 * Run: npx tsx examples/52-live-agents-basic.ts
 */

import {
  createActionExecutor,
  createHeartbeat,
  weaveInMemoryStateStore,
  type AgentContract,
  type AttentionPolicy,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = '2025-06-01T09:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-basic',
    tenantId: 'tenant-live-agents-basic',
    name: 'Support Mesh',
    charter: 'Coordinate async support tasks.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-basic-alice',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Support Coordinator',
    contractVersionId: 'contract-basic-alice-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-basic-alice-v1',
    agentId: agent.id,
    version: 1,
    persona: 'You are a careful support coordinator.',
    objectives: 'Prioritize and process inbound support requests.',
    successIndicators: 'Requests are acknowledged and processed quickly.',
    budget: {
      monthlyUsdCap: 50,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    accountBindingRefs: [],
    attentionPolicyRef: 'live-agents-basic',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1000,
        actionTokensMax: 1000,
        handoffTokensMax: 500,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 5,
      },
      defaultsProfile: 'standard',
    },
    createdAt: now,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);

  await store.saveMessage({
    id: 'msg-basic-1',
    meshId: mesh.id,
    fromType: 'HUMAN',
    fromId: 'human:ops-admin-1',
    fromMeshId: null,
    toType: 'AGENT',
    toId: agent.id,
    topic: null,
    kind: 'ASK',
    replyToMessageId: null,
    threadId: 'thread-basic-1',
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Can you prepare a customer response?',
    body: 'Customer requests a delivery ETA update.',
  });

  await store.saveHeartbeatTick({
    id: 'tick-basic-1',
    agentId: agent.id,
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

  const attentionPolicy: AttentionPolicy = {
    key: 'live-agents-basic',
    async decide() {
      return {
        type: 'ProcessMessage',
        messageId: 'msg-basic-1',
      };
    },
  };

  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-basic-1',
    concurrency: 1,
    attentionPolicy,
    actionExecutor: createActionExecutor(),
    now: () => now,
  });

  const result = await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));
  const tick = await store.loadHeartbeatTick('tick-basic-1');
  const message = await store.loadMessage('msg-basic-1');

  console.log('Live-agents basic example is wired and running.');
  console.log(`Processed ticks: ${result.processed}`);
  console.log(`Tick status: ${tick?.status ?? 'n/a'}`);
  console.log(`Chosen action: ${tick?.actionChosen?.type ?? 'n/a'}`);
  console.log(`Message status: ${message?.status ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
