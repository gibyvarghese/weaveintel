/**
 * Example 47 - live-agents Phase 9 context compression maintainer
 *
 * Run: npx tsx examples/47-live-agents-phase9.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createCompressionMaintainer,
  type AgentContract,
  type LiveAgent,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const start = '2025-04-01T09:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-phase9',
    tenantId: 'tenant-phase9',
    name: 'Phase 9 Compression Mesh',
    charter: 'Demonstrate profile-aware context compression for live agents.',
    status: 'ACTIVE',
    dualControlRequiredFor: [],
    createdAt: start,
  };

  const agent: LiveAgent = {
    id: 'agent-phase9',
    meshId: mesh.id,
    name: 'Context Steward',
    role: 'Operational Coordinator',
    contractVersionId: 'contract-phase9-v1',
    status: 'ACTIVE',
    createdAt: start,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-phase9-v1',
    agentId: agent.id,
    version: 1,
    persona: 'Compresses operating context for reliable handoff and execution.',
    objectives: 'Maintain concise context packs while preserving key incidents and state.',
    successIndicators: 'Useful summaries inside configured token budgets.',
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
        monthlyCompressionUsdCap: 12,
      },
      defaultsProfile: 'operational',
    },
    createdAt: start,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);

  for (let day = 1; day <= 30; day += 1) {
    const dayIso = new Date(Date.parse(start) + day * 24 * 60 * 60 * 1000).toISOString();
    const kind = day % 7 === 0 ? 'REPORT' : 'ASK';

    await store.saveMessage({
      id: `msg-phase9-${day}`,
      meshId: mesh.id,
      fromType: 'HUMAN',
      fromId: 'human:ops-admin-1',
      fromMeshId: null,
      toType: 'AGENT',
      toId: agent.id,
      topic: null,
      kind,
      replyToMessageId: null,
      threadId: 'thread-phase9',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt: dayIso,
      subject: `Day ${day} status`,
      body: day % 5 === 0
        ? 'Escalation lane updated and SLA risk mitigated.'
        : 'Routine triage and scheduling updates completed.',
    });
  }

  const snapshots: Array<{ profile: string; rendered: string; artefactCount: number }> = [];
  const maintainer = createCompressionMaintainer({
    stateStore: store,
    runOnce: true,
    agentIds: [agent.id],
    onCompressed(payload) {
      snapshots.push({
        profile: payload.profile,
        rendered: payload.rendered,
        artefactCount: payload.artefactCount,
      });
    },
  });

  await maintainer.run(weaveContext({ tenantId: mesh.tenantId }));

  const snapshot = snapshots[0];
  console.log('Live-agents Phase 9 compression maintainer is wired and running.');
  console.log(`Compression profile: ${snapshot?.profile ?? 'n/a'}`);
  console.log(`Produced artefacts: ${snapshot?.artefactCount ?? 0}`);
  console.log(`Rendered context preview:\n${snapshot?.rendered.slice(0, 320) ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
