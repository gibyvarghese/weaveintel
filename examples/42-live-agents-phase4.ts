/**
 * Example 42 — live-agents Phase 4 attention policy + heartbeat action execution
 *
 * Run: npx tsx examples/42-live-agents-phase4.ts
 */

import {
  createHeartbeat,
  type AgentContract,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  type Message,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const store = weaveInMemoryStateStore();
  const now = nowIso();

  const mesh: Mesh = {
    id: 'mesh-phase4',
    tenantId: 'tenant-phase4',
    name: 'Phase 4 Attention Mesh',
    charter: 'Demonstrate attention policy + heartbeat execution.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-phase4-alice',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Coordinator',
    contractVersionId: 'contract-phase4-alice-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-phase4-alice-v1',
    agentId: agent.id,
    version: 1,
    persona: 'Focused operations coordinator',
    objectives: 'Process inbox first, then work backlog.',
    successIndicators: 'No pending tasks or inbox items remain stale.',
    budget: {
      monthlyUsdCap: 100,
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
        attentionTokensMax: 1500,
        actionTokensMax: 1500,
        handoffTokensMax: 600,
        reportTokensMax: 600,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'standard',
    },
    createdAt: now,
  };

  const inbound: Message = {
    id: 'msg-phase4-1',
    meshId: mesh.id,
    fromType: 'HUMAN',
    fromId: 'human:ops-admin-1',
    fromMeshId: null,
    toType: 'AGENT',
    toId: agent.id,
    topic: 'daily-check',
    kind: 'ASK',
    replyToMessageId: null,
    threadId: 'thread-phase4-1',
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Daily check-in',
    body: 'Please summarize unresolved issues.',
  };

  const tick: HeartbeatTick = {
    id: 'tick-phase4-1',
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
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);
  await store.saveMessage(inbound);
  await store.saveHeartbeatTick(tick);

  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-phase4-1',
    concurrency: 1,
  });

  const result = await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));
  const updatedTick = await store.loadHeartbeatTick(tick.id);
  const updatedMessage = await store.loadMessage(inbound.id);

  console.log('Live-agents Phase 4 attention framework is wired and running.');
  console.log(`Tick processed count: ${result.processed}`);
  console.log(`Tick status: ${updatedTick?.status}`);
  console.log(`Chosen action: ${updatedTick?.actionChosen?.type ?? 'none'}`);
  console.log(`Message status: ${updatedMessage?.status}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
