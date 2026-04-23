/**
 * Example 44 - live-agents Phase 6 lease reclaim + multi-worker safety
 *
 * Run: npx tsx examples/44-live-agents-phase6.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createHeartbeat,
  type AgentContract,
  type AttentionPolicy,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function seedPhase6Data() {
  const store = weaveInMemoryStateStore();
  const baseNow = '2025-01-01T00:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-phase6',
    tenantId: 'tenant-phase6',
    name: 'Phase 6 Multi-worker Mesh',
    charter: 'Demonstrate stale-lease recovery and no double execution.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: baseNow,
  };

  const agent: LiveAgent = {
    id: 'agent-phase6-1',
    meshId: mesh.id,
    name: 'Phase 6 Agent',
    role: 'Coordinator',
    contractVersionId: 'contract-phase6-1',
    status: 'ACTIVE',
    createdAt: baseNow,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-phase6-1',
    agentId: agent.id,
    version: 1,
    persona: 'A resilient autonomous coordinator.',
    objectives: 'Recover stale work and avoid duplicate execution.',
    successIndicators: 'Each tick is handled at most once, even with multiple workers.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    accountBindingRefs: [],
    attentionPolicyRef: 'phase6-example',
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
    createdAt: baseNow,
  };

  const staleTick: HeartbeatTick = {
    id: 'tick-phase6-stale',
    agentId: agent.id,
    scheduledFor: baseNow,
    pickedUpAt: baseNow,
    completedAt: null,
    workerId: 'worker-crashed',
    leaseExpiresAt: '2025-01-01T00:00:05.000Z',
    actionChosen: null,
    actionOutcomeProse: null,
    actionOutcomeStatus: null,
    status: 'IN_PROGRESS',
  };

  const freshTick: HeartbeatTick = {
    id: 'tick-phase6-fresh',
    agentId: agent.id,
    scheduledFor: baseNow,
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
  await store.saveHeartbeatTick(staleTick);
  await store.saveHeartbeatTick(freshTick);

  return { store, agent };
}

async function main() {
  const { store } = await seedPhase6Data();
  const ctx = weaveContext({ userId: 'human:ops-admin-1' });
  let actionsExecuted = 0;

  const attentionPolicy: AttentionPolicy = {
    key: 'phase6-example',
    async decide() {
      return {
        type: 'NoopRest',
        nextTickAt: '2025-01-01T00:30:00.000Z',
      };
    },
  };

  const actionExecutor = {
    async execute() {
      actionsExecuted += 1;
      return {
        status: 'SUCCESS' as const,
        summaryProse: 'Handled by phase 6 worker.',
        artifacts: [],
      };
    },
  };

  const workerA = createHeartbeat({
    stateStore: store,
    workerId: 'worker-a',
    concurrency: 1,
    attentionPolicy,
    actionExecutor,
    now: () => '2025-01-01T00:01:00.000Z',
    runOptions: {
      leaseDurationMs: 10_000,
      runPollIntervalMs: 50,
    },
  });

  const workerB = createHeartbeat({
    stateStore: store,
    workerId: 'worker-b',
    concurrency: 1,
    attentionPolicy,
    actionExecutor,
    now: () => '2025-01-01T00:01:00.000Z',
    runOptions: {
      leaseDurationMs: 10_000,
      runPollIntervalMs: 50,
    },
  });

  const [resultA, resultB] = await Promise.all([workerA.tick(ctx), workerB.tick(ctx)]);

  const stale = await store.loadHeartbeatTick('tick-phase6-stale');
  const fresh = await store.loadHeartbeatTick('tick-phase6-fresh');

  console.log('Live-agents Phase 6 reclaim + multi-worker behavior is wired and running.');
  console.log(`Worker A processed: ${resultA.processed}`);
  console.log(`Worker B processed: ${resultB.processed}`);
  console.log(`Total executed actions: ${actionsExecuted}`);
  console.log(`Stale tick final status: ${stale?.status}`);
  console.log(`Stale tick worker: ${stale?.workerId}`);
  console.log(`Fresh tick final status: ${fresh?.status}`);
  console.log(`Fresh tick worker: ${fresh?.workerId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
