/**
 * Example 46 - live-agents Phase 8 promotions workflow
 *
 * Run: npx tsx examples/46-live-agents-phase8.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createActionExecutor,
  type AgentContract,
  type LiveAgent,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const now = '2025-01-01T00:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-phase8',
    tenantId: 'tenant-phase8',
    name: 'Phase 8 Promotions Mesh',
    charter: 'Demonstrate promotion requests and manager-issued promotions.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const manager: LiveAgent = {
    id: 'agent-phase8-manager',
    meshId: mesh.id,
    name: 'Manager',
    role: 'Manager',
    contractVersionId: 'contract-phase8-manager-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const worker: LiveAgent = {
    id: 'agent-phase8-worker',
    meshId: mesh.id,
    name: 'Worker',
    role: 'Operator',
    contractVersionId: 'contract-phase8-worker-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const managerContract: AgentContract = {
    id: 'contract-phase8-manager-v1',
    agentId: manager.id,
    version: 1,
    persona: 'A manager who controls promotions responsibly.',
    objectives: 'Approve promotions based on evidence and role fit.',
    successIndicators: 'Promotion transitions are auditable and policy-compliant.',
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
      scopePredicate: 'agents in this mesh',
      requiresEvidence: false,
    },
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'phase8-manager',
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
  };

  const workerContract: AgentContract = {
    id: 'contract-phase8-worker-v1',
    agentId: worker.id,
    version: 1,
    persona: 'An operator focused on reliable delivery.',
    objectives: 'Handle operator responsibilities and request advancement when justified.',
    successIndicators: 'Clear evidence-backed promotion requests.',
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
    attentionPolicyRef: 'phase8-worker',
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
  };

  await store.saveMesh(mesh);
  await store.saveAgent(manager);
  await store.saveAgent(worker);
  await store.saveContract(managerContract);
  await store.saveContract(workerContract);

  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  await executor.execute(
    {
      type: 'RequestPromotion',
      targetRole: 'Senior Operator',
      reasonProse: 'Sustained delivery and mentoring outcomes over two quarters.',
      evidenceMessageIds: ['msg-phase8-evidence-1', 'msg-phase8-evidence-2'],
    },
    {
      tickId: 'tick-phase8-request',
      nowIso: '2025-01-01T00:05:00.000Z',
      stateStore: store,
      agent: worker,
      activeBindings: [],
    },
    ctx,
  );

  await executor.execute(
    {
      type: 'IssuePromotion',
      recipientAgentId: worker.id,
      newContractDraft: {
        role: 'Senior Operator',
        objectives: 'Lead cross-team delivery coordination and mentor operators.',
        successIndicators: 'Improved SLA attainment and onboarding outcomes.',
      },
      reasonProse: 'Promotion approved after review of delivery and leadership evidence.',
    },
    {
      tickId: 'tick-phase8-issue',
      nowIso: '2025-01-01T00:10:00.000Z',
      stateStore: store,
      agent: manager,
      activeBindings: [],
    },
    ctx,
  );

  const promotionRequests = await store.listPromotionRequests(mesh.id);
  const promotions = await store.listPromotionsForAgent(worker.id);
  const workerAfter = await store.loadAgent(worker.id);
  const workerContractAfter = await store.loadLatestContractForAgent(worker.id);

  console.log('Live-agents Phase 8 promotions workflow is wired and running.');
  console.log(`Promotion requests: ${promotionRequests.length}`);
  console.log(`Promotions issued: ${promotions.length}`);
  console.log(`Worker current role: ${workerAfter?.role}`);
  console.log(`Worker current contract version: ${workerContractAfter?.version ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
