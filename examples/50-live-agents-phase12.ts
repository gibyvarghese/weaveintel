/**
 * Example 50 - live-agents Phase 12 cross-mesh bridges
 *
 * Run: npx tsx examples/50-live-agents-phase12.ts
 */

import {
  CrossMeshBridgeRequiredError,
  weaveInMemoryStateStore,
  type CrossMeshBridge,
  type Message,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = new Date().toISOString();

  await store.saveMesh({
    id: 'mesh-alpha',
    tenantId: 'tenant-phase12',
    name: 'Alpha Mesh',
    charter: 'Origin mesh for research tasks.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  });
  await store.saveMesh({
    id: 'mesh-beta',
    tenantId: 'tenant-phase12',
    name: 'Beta Mesh',
    charter: 'Destination mesh for execution tasks.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  });

  await store.saveAgent({
    id: 'agent-alpha',
    meshId: 'mesh-alpha',
    name: 'Alice',
    role: 'Research Coordinator',
    contractVersionId: 'contract-alpha',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });
  await store.saveAgent({
    id: 'agent-beta',
    meshId: 'mesh-beta',
    name: 'Bob',
    role: 'Execution Coordinator',
    contractVersionId: 'contract-beta',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });

  const crossMeshMessage: Message = {
    id: 'msg-phase12-cross-1',
    meshId: 'mesh-alpha',
    fromType: 'AGENT',
    fromId: 'agent-alpha',
    fromMeshId: 'mesh-alpha',
    toType: 'AGENT',
    toId: 'agent-beta',
    topic: 'handoff',
    kind: 'CONTEXT_HANDOFF',
    replyToMessageId: null,
    threadId: 'thread-phase12-cross-1',
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: 'Cross mesh handoff',
    body: 'Please continue this workflow in mesh-beta.',
  };

  let blockedWithoutBridge = false;
  try {
    await store.saveMessage(crossMeshMessage);
  } catch (error) {
    if (error instanceof CrossMeshBridgeRequiredError) {
      blockedWithoutBridge = true;
    } else {
      throw error;
    }
  }

  const bridge: CrossMeshBridge = {
    id: 'bridge-phase12-1',
    fromMeshId: 'mesh-alpha',
    toMeshId: 'mesh-beta',
    allowedAgentPairs: [{ fromAgentId: 'agent-alpha', toAgentId: 'agent-beta' }],
    allowedTopics: ['handoff'],
    rateLimitPerHour: null,
    authorisedByType: 'HUMAN',
    authorisedById: 'human:ops-admin-1',
    coAuthorisedByType: null,
    coAuthorisedById: null,
    effectiveFrom: now,
    effectiveTo: null,
    revokedAt: null,
    purposeProse: 'Allow project handoffs from alpha mesh to beta mesh.',
    constraintsProse: 'Only handoff topic and approved agent pair are allowed.',
  };
  await store.saveCrossMeshBridge(bridge);

  await store.saveMessage({ ...crossMeshMessage, id: 'msg-phase12-cross-2', threadId: 'thread-phase12-cross-2' });

  const inbox = await store.listMessagesForRecipient('AGENT', 'agent-beta');

  console.log('Live-agents Phase 12 cross-mesh bridges are wired and running.');
  console.log(`Blocked without bridge: ${blockedWithoutBridge}`);
  console.log(`Inbox size for agent-beta: ${inbox.length}`);
  console.log(`Contains bridged message: ${inbox.some((message) => message.id === 'msg-phase12-cross-2')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
