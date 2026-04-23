/**
 * Example 57 - live-agents compression
 *
 * Run: npx tsx examples/57-live-agents-compression.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createCompressionMaintainer,
  weaveInMemoryStateStore,
  type AgentContract,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const start = '2025-06-06T09:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-compression',
    tenantId: 'tenant-live-agents-compression',
    name: 'Operations Mesh',
    charter: 'Maintain high-signal compressed context for long-running operations.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: start,
  };

  const agent: LiveAgent = {
    id: 'agent-compression',
    meshId: mesh.id,
    name: 'Casey',
    role: 'Operations Coordinator',
    contractVersionId: 'contract-compression-v1',
    status: 'ACTIVE',
    createdAt: start,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-compression-v1',
    agentId: agent.id,
    version: 1,
    persona: 'You summarize long-running operations for reliable continuity.',
    objectives: 'Keep compressed context useful over a rolling 30-day window.',
    successIndicators: 'Compressed state remains concise and decision-relevant.',
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
    attentionPolicyRef: 'compression',
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
        actionTokensMax: 1000,
        handoffTokensMax: 500,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'operational',
    },
    createdAt: start,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);

  for (let day = 1; day <= 30; day += 1) {
    const createdAt = new Date(Date.parse(start) + day * 24 * 60 * 60 * 1000).toISOString();
    const kind = day % 6 === 0 ? 'REPORT' : 'ASK';
    const body = day % 5 === 0
      ? 'Escalation risk reduced after corrective action and stakeholder alignment.'
      : 'Routine operational triage and workflow updates completed.';

    await store.saveMessage({
      id: `msg-compression-${day}`,
      meshId: mesh.id,
      fromType: 'HUMAN',
      fromId: 'human:ops-admin-1',
      fromMeshId: null,
      toType: 'AGENT',
      toId: agent.id,
      topic: 'ops-daily',
      kind,
      replyToMessageId: null,
      threadId: 'thread-compression',
      contextRefs: [],
      contextPacketRef: null,
      expiresAt: null,
      priority: 'NORMAL',
      status: 'PENDING',
      deliveredAt: null,
      readAt: null,
      processedAt: null,
      createdAt,
      subject: `Operations day ${day}`,
      body,
    });
  }

  const outputs: Array<{ profile: string; artefactCount: number; rendered: string }> = [];
  const maintainer = createCompressionMaintainer({
    stateStore: store,
    runOnce: true,
    agentIds: [agent.id],
    onCompressed(payload) {
      outputs.push({
        profile: payload.profile,
        artefactCount: payload.artefactCount,
        rendered: payload.rendered,
      });
    },
  });

  await maintainer.run(weaveContext({ tenantId: mesh.tenantId }));

  const output = outputs[0];
  console.log('Live-agents compression example is wired and running.');
  console.log(`Compression profile: ${output?.profile ?? 'n/a'}`);
  console.log(`Artefact count: ${output?.artefactCount ?? 0}`);
  console.log(`Rendered context preview: ${(output?.rendered ?? 'n/a').slice(0, 220)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
