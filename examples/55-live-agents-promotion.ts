/**
 * Example 55 - live-agents promotion
 *
 * Run: npx tsx examples/55-live-agents-promotion.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createActionExecutor,
  weaveInMemoryStateStore,
  type AgentContract,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const now = '2025-06-04T09:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-promotion',
    tenantId: 'tenant-live-agents-promotion',
    name: 'Delivery Mesh',
    charter: 'Promote high-performing operators through explicit contract updates.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const manager: LiveAgent = {
    id: 'agent-promotion-manager',
    meshId: mesh.id,
    name: 'Morgan',
    role: 'Manager',
    contractVersionId: 'contract-promotion-manager-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const worker: LiveAgent = {
    id: 'agent-promotion-worker',
    meshId: mesh.id,
    name: 'Riley',
    role: 'Operator',
    contractVersionId: 'contract-promotion-worker-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const managerContract: AgentContract = {
    id: 'contract-promotion-manager-v1',
    agentId: manager.id,
    version: 1,
    persona: 'A manager responsible for role growth decisions.',
    objectives: 'Review and apply promotions safely.',
    successIndicators: 'Valid promotions produce new contract versions.',
    budget: {
      monthlyUsdCap: 120,
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
      scopePredicate: 'agents in same mesh',
      requiresEvidence: false,
    },
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'promotion-manager',
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

  const workerContract: AgentContract = {
    id: 'contract-promotion-worker-v1',
    agentId: worker.id,
    version: 1,
    persona: 'Delivery operator focused on reliability.',
    objectives: 'Run delivery workflows and mentor peers.',
    successIndicators: 'SLA and mentorship goals are consistently met.',
    budget: {
      monthlyUsdCap: 120,
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
    attentionPolicyRef: 'promotion-worker',
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
  await store.saveAgent(manager);
  await store.saveAgent(worker);
  await store.saveContract(managerContract);
  await store.saveContract(workerContract);

  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  await executor.execute(
    {
      type: 'RequestPromotion',
      targetRole: 'Senior Operator',
      reasonProse: 'Delivered consistently and mentored new operators for 2 quarters.',
      evidenceMessageIds: ['msg-prom-1', 'msg-prom-2'],
    },
    {
      tickId: 'tick-promotion-1',
      nowIso: '2025-06-04T09:05:00.000Z',
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
        objectives: 'Lead delivery operations and coach operators.',
        successIndicators: 'SLA remains above target and onboarding quality improves.',
      },
      reasonProse: 'Promotion approved after role review and evidence check.',
    },
    {
      tickId: 'tick-promotion-2',
      nowIso: '2025-06-04T09:10:00.000Z',
      stateStore: store,
      agent: manager,
      activeBindings: [],
    },
    ctx,
  );

  const requests = await store.listPromotionRequests(mesh.id);
  const promotions = await store.listPromotionsForAgent(worker.id);
  const updatedAgent = await store.loadAgent(worker.id);
  const updatedContract = await store.loadLatestContractForAgent(worker.id);

  console.log('Live-agents promotion example is wired and running.');
  console.log(`Promotion requests: ${requests.length}`);
  console.log(`Promotions: ${promotions.length}`);
  console.log(`Updated role: ${updatedAgent?.role ?? 'n/a'}`);
  console.log(`Updated contract version: ${updatedContract?.version ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
