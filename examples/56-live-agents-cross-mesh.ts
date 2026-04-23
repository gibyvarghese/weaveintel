/**
 * Example 56 - live-agents cross mesh
 *
 * Run: npx tsx examples/56-live-agents-cross-mesh.ts
 */

import {
  CrossMeshBridgeRequiredError,
  weaveInMemoryStateStore,
  type CrossMeshBridge,
  type Message,
  type Mesh,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = '2025-06-05T09:00:00.000Z';

  const meshAlpha: Mesh = {
    id: 'mesh-alpha',
    tenantId: 'tenant-live-agents-cross-mesh',
    name: 'Research Mesh',
    charter: 'Generates and validates initial findings.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const meshBeta: Mesh = {
    id: 'mesh-beta',
    tenantId: 'tenant-live-agents-cross-mesh',
    name: 'Writing Mesh',
    charter: 'Converts findings into operator-ready reports.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  await store.saveMesh(meshAlpha);
  await store.saveMesh(meshBeta);

  await store.saveAgent({
    id: 'agent-alpha',
    meshId: meshAlpha.id,
    name: 'Alex',
    role: 'Research Lead',
    contractVersionId: 'contract-alpha-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });
  await store.saveAgent({
    id: 'agent-beta',
    meshId: meshBeta.id,
    name: 'Blair',
    role: 'Writer Lead',
    contractVersionId: 'contract-beta-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });

  const handoff: Message = {
    id: 'msg-cross-1',
    meshId: meshAlpha.id,
    fromType: 'AGENT',
    fromId: 'agent-alpha',
    fromMeshId: meshAlpha.id,
    toType: 'AGENT',
    toId: 'agent-beta',
    topic: 'report-handoff',
    kind: 'CONTEXT_HANDOFF',
    replyToMessageId: null,
    threadId: 'thread-cross-1',
    contextRefs: ['artifact://handoff/report-2025-06-05'],
    contextPacketRef: 'packet://cross-mesh/handoff-2025-06-05',
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Research handoff for writing',
    body: 'Attached packet contains validated evidence and key conclusions for publication.',
  };

  let blockedWithoutBridge = false;
  try {
    await store.saveMessage(handoff);
  } catch (error) {
    if (error instanceof CrossMeshBridgeRequiredError) {
      blockedWithoutBridge = true;
    } else {
      throw error;
    }
  }

  const bridge: CrossMeshBridge = {
    id: 'bridge-alpha-beta-1',
    fromMeshId: meshAlpha.id,
    toMeshId: meshBeta.id,
    allowedAgentPairs: [{ fromAgentId: 'agent-alpha', toAgentId: 'agent-beta' }],
    allowedTopics: ['report-handoff'],
    rateLimitPerHour: 20,
    authorisedByType: 'HUMAN',
    authorisedById: 'human:ops-admin-1',
    coAuthorisedByType: null,
    coAuthorisedById: null,
    effectiveFrom: now,
    effectiveTo: null,
    revokedAt: null,
    purposeProse: 'Enable research-to-writing report handoffs.',
    constraintsProse: 'Only report-handoff topic allowed for this bridge.',
  };

  await store.saveCrossMeshBridge(bridge);
  await store.saveMessage({ ...handoff, id: 'msg-cross-2', threadId: 'thread-cross-2' });

  const inbox = await store.listMessagesForRecipient('AGENT', 'agent-beta');

  console.log('Live-agents cross mesh example is wired and running.');
  console.log(`Blocked without bridge: ${blockedWithoutBridge}`);
  console.log(`Inbox size after bridge: ${inbox.length}`);
  console.log(`Handoff packet ref: ${inbox[0]?.contextPacketRef ?? 'n/a'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
