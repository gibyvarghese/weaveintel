/**
 * Example 40 — live-agents Phase 2 core primitives
 *
 * Run: npx tsx examples/40-live-agents-phase2.ts
 */

import {
  type AgentContract,
  type BacklogItem,
  type LiveAgent,
  type Message,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';
import { weaveWorkingMemory } from '@weaveintel/memory';

function nowIso(): string {
  return new Date().toISOString();
}

function makeContract(id: string, agentId: string): AgentContract {
  return {
    id,
    agentId,
    version: 1,
    persona: `You are ${agentId}, a careful collaborator.`,
    objectives: 'Collaborate asynchronously and keep inbox-driven work moving.',
    successIndicators: 'Messages are handled on time and backlog stays clear.',
    budget: { monthlyUsdCap: 100, perActionUsdCap: 5 },
    workingHoursSchedule: { timezone: 'UTC', cronActive: '0 8 * * 1-5' },
    accountBindingRefs: [],
    attentionPolicyRef: 'standard-v1',
    reviewCadence: '0 9 * * 1',
    contextPolicy: {
      compressors: [{ id: 'noop', onDemand: true }],
      weighting: [{ id: 'contract-anchor' }],
      budgets: {
        attentionTokensMax: 2048,
        actionTokensMax: 4096,
        handoffTokensMax: 2048,
        reportTokensMax: 2048,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'standard',
    },
    createdAt: nowIso(),
  };
}

function taskMessage(meshId: string, createdAt: string): Message {
  return {
    id: 'msg-task-1',
    meshId,
    fromType: 'AGENT',
    fromId: 'agent-alice',
    fromMeshId: meshId,
    toType: 'AGENT',
    toId: 'agent-bob',
    topic: 'weekly-briefing',
    kind: 'TASK',
    replyToMessageId: null,
    threadId: 'thread-weekly-1',
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt,
    subject: 'Prepare weekly demand brief',
    body: 'Collect the top customer signals and draft a one-page summary.',
  };
}

async function main() {
  const stateStore = weaveInMemoryStateStore();
  const workingMemory = weaveWorkingMemory();
  const ctx = weaveContext({ userId: 'human:ops-admin-1', tenantId: 'tenant-phase2' });
  const now = nowIso();

  const mesh: Mesh = {
    id: 'mesh-phase2',
    tenantId: 'tenant-phase2',
    name: 'Phase 2 Demo Mesh',
    charter: 'Demonstrate live-agent core primitive lifecycle and message flow.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agents: LiveAgent[] = [
    {
      id: 'agent-alice',
      meshId: mesh.id,
      name: 'Alice',
      role: 'Manager',
      contractVersionId: 'contract-alice-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-bob',
      meshId: mesh.id,
      name: 'Bob',
      role: 'Researcher',
      contractVersionId: 'contract-bob-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-carol',
      meshId: mesh.id,
      name: 'Carol',
      role: 'Reviewer',
      contractVersionId: 'contract-carol-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
  ];

  await stateStore.saveMesh(mesh);
  for (const agent of agents) {
    await stateStore.saveAgent(agent);
    await stateStore.saveContract(makeContract(agent.contractVersionId, agent.id));
  }

  await stateStore.saveTeam({
    id: 'team-signals',
    meshId: mesh.id,
    name: 'Signals Team',
    charter: 'Analyze customer demand and summarize key trends.',
    leadAgentId: 'agent-alice',
  });
  await stateStore.saveTeamMembership({
    id: 'team-signals-bob',
    teamId: 'team-signals',
    agentId: 'agent-bob',
    roleInTeam: 'Analyst',
    joinedAt: now,
    leftAt: null,
  });

  await stateStore.saveDelegationEdge({
    id: 'edge-alice-bob',
    meshId: mesh.id,
    fromAgentId: 'agent-alice',
    toAgentId: 'agent-bob',
    relationship: 'DIRECTS',
    relationshipProse: 'Alice directs Bob on weekly demand summary tasks.',
    effectiveFrom: now,
    effectiveTo: null,
  });

  const task = taskMessage(mesh.id, now);
  await stateStore.saveMessage(task);
  await stateStore.transitionMessageStatus(task.id, 'DELIVERED', now);
  await stateStore.transitionMessageStatus(task.id, 'READ', now);

  const backlogItem: BacklogItem = {
    id: 'backlog-1',
    agentId: 'agent-bob',
    priority: 'HIGH',
    status: 'PROPOSED',
    originType: 'MESSAGE',
    originRef: task.id,
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
    description: 'Prepare briefing notes from customer demand signals.',
  };

  await stateStore.saveBacklogItem(backlogItem);
  await stateStore.transitionBacklogItemStatus(backlogItem.id, 'ACCEPTED', now);
  await stateStore.transitionBacklogItemStatus(backlogItem.id, 'IN_PROGRESS', now);

  await workingMemory.patch(ctx, 'agent-bob', [
    { op: 'set', key: 'currentThread', value: task.threadId },
    { op: 'set', key: 'focus', value: 'weekly-demand-briefing' },
  ]);

  await stateStore.saveMessage({
    id: 'msg-reply-1',
    meshId: mesh.id,
    fromType: 'AGENT',
    fromId: 'agent-bob',
    fromMeshId: mesh.id,
    toType: 'AGENT',
    toId: 'agent-alice',
    topic: 'weekly-briefing',
    kind: 'REPLY',
    replyToMessageId: task.id,
    threadId: task.threadId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: nowIso(),
    subject: 'Re: Prepare weekly demand brief',
    body: 'Acknowledged. Draft in progress and initial summary will be shared today.',
  });

  await stateStore.transitionBacklogItemStatus(backlogItem.id, 'COMPLETED', nowIso());
  await stateStore.transitionMessageStatus(task.id, 'PROCESSED', nowIso());

  const bobInbox = await stateStore.listMessagesForRecipient('AGENT', 'agent-bob');
  const thread = await stateStore.listThreadMessages(task.threadId);
  const bobBacklog = await stateStore.listBacklogForAgent('agent-bob');
  const bobTeams = await stateStore.listTeamsForAgent('agent-bob');

  console.log('Live-agents Phase 2 core primitives are wired and running.');
  console.log(`Mesh: ${mesh.name}`);
  console.log(`Agents: ${agents.map((agent) => agent.name).join(', ')}`);
  console.log(`Bob inbox items: ${bobInbox.length}`);
  console.log(`Thread messages: ${thread.length}`);
  console.log(`Bob backlog status: ${bobBacklog[0]?.status ?? 'none'}`);
  console.log(`Bob teams: ${bobTeams.map((team) => team.name).join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
