/**
 * Example 53 - live-agents research team
 *
 * Run: npx tsx examples/53-live-agents-research-team.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createActionExecutor,
  weaveInMemoryStateStore,
  type AgentContract,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';

function contractForAgent(args: {
  id: string;
  agentId: string;
  persona: string;
  objectives: string;
  roleAuthority?: boolean;
}): AgentContract {
  return {
    id: args.id,
    agentId: args.agentId,
    version: 1,
    persona: args.persona,
    objectives: args.objectives,
    successIndicators: 'Research progress is shared and traceable.',
    budget: {
      monthlyUsdCap: 80,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: args.roleAuthority
      ? {
        mayIssueKinds: ['AUTHORITY_EXTENSION', 'COLLEAGUE_INTRODUCTION'],
        scopePredicate: 'agents in same mesh',
        maxBudgetIncreaseUsd: null,
        requiresEvidence: false,
        dualControl: false,
      }
      : null,
    contractAuthority: null,
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'research-team',
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
      defaultsProfile: 'knowledge-worker',
    },
    createdAt: '2025-06-02T09:00:00.000Z',
  };
}

async function main() {
  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const now = '2025-06-02T09:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-research-team',
    tenantId: 'tenant-live-agents-research-team',
    name: 'Research Mesh',
    charter: 'Coordinate asynchronous research tasks and evidence handoffs.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const manager: LiveAgent = {
    id: 'agent-manager',
    meshId: mesh.id,
    name: 'Carol',
    role: 'Research Manager',
    contractVersionId: 'contract-manager-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const teamAgents: LiveAgent[] = [
    manager,
    {
      id: 'agent-researcher-a',
      meshId: mesh.id,
      name: 'Alice',
      role: 'Researcher',
      contractVersionId: 'contract-researcher-a-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-researcher-b',
      meshId: mesh.id,
      name: 'Bob',
      role: 'Researcher',
      contractVersionId: 'contract-researcher-b-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-writer',
      meshId: mesh.id,
      name: 'Dana',
      role: 'Writer',
      contractVersionId: 'contract-writer-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
  ];

  await store.saveMesh(mesh);
  for (const agent of teamAgents) {
    await store.saveAgent(agent);
  }

  await store.saveContract(contractForAgent({
    id: 'contract-manager-v1',
    agentId: manager.id,
    persona: 'Research manager prioritizing evidence-backed decisions.',
    objectives: 'Delegate and remove blockers.',
    roleAuthority: true,
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-researcher-a-v1',
    agentId: 'agent-researcher-a',
    persona: 'Market researcher focused on primary sources.',
    objectives: 'Collect verified source material.',
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-researcher-b-v1',
    agentId: 'agent-researcher-b',
    persona: 'Competitive intelligence researcher.',
    objectives: 'Map competitor signal changes.',
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-writer-v1',
    agentId: 'agent-writer',
    persona: 'Technical writer synthesizing findings.',
    objectives: 'Publish concise weekly updates.',
  }));

  await store.saveDelegationEdge({
    id: 'edge-manager-a',
    meshId: mesh.id,
    fromAgentId: manager.id,
    toAgentId: 'agent-researcher-a',
    relationship: 'DIRECTS',
    relationshipProse: 'Carol directs Alice on customer evidence collection.',
    effectiveFrom: now,
    effectiveTo: null,
  });
  await store.saveDelegationEdge({
    id: 'edge-manager-b',
    meshId: mesh.id,
    fromAgentId: manager.id,
    toAgentId: 'agent-researcher-b',
    relationship: 'DIRECTS',
    relationshipProse: 'Carol directs Bob on competitor analysis.',
    effectiveFrom: now,
    effectiveTo: null,
  });

  await store.saveBacklogItem({
    id: 'bl-research-a',
    agentId: 'agent-researcher-a',
    priority: 'HIGH',
    status: 'BLOCKED',
    originType: 'MANAGER',
    originRef: manager.id,
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
    title: 'Gather restricted source notes',
    description: 'Need authority extension to access protected source index.',
  });

  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  await executor.execute(
    {
      type: 'RequestCapability',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Need temporary authority to access restricted source index.',
        reasonProse: 'Current role cannot retrieve required source evidence.',
        evidenceMessageIds: [],
      },
    },
    {
      tickId: 'tick-research-team-1',
      nowIso: '2025-06-02T09:05:00.000Z',
      stateStore: store,
      agent: teamAgents[1]!,
      activeBindings: [],
    },
    ctx,
  );

  await executor.execute(
    {
      type: 'IssueGrant',
      recipientAgentId: 'agent-researcher-a',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Temporary authority for restricted source lookup.',
        scopeProse: 'Applies to source-index tasks only.',
        durationHint: 'PT4H',
        reasonProse: 'Approved by manager to unblock critical research task.',
      },
    },
    {
      tickId: 'tick-research-team-2',
      nowIso: '2025-06-02T09:10:00.000Z',
      stateStore: store,
      agent: manager,
      activeBindings: [],
    },
    ctx,
  );

  await store.transitionBacklogItemStatus('bl-research-a', 'IN_PROGRESS', '2025-06-02T09:11:00.000Z');

  const grantRequests = await store.listGrantRequests(mesh.id);
  const grants = await store.listCapabilityGrantsForRecipient('AGENT', 'agent-researcher-a');
  const backlog = await store.listBacklogForAgent('agent-researcher-a');

  console.log('Live-agents research team example is wired and running.');
  console.log(`Agents in mesh: ${(await store.listAgents(mesh.id)).length}`);
  console.log(`Grant requests: ${grantRequests.length}`);
  console.log(`Active grants for Alice: ${grants.length}`);
  console.log(`Alice backlog state: ${backlog[0]?.status ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
