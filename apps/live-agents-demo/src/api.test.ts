import { afterEach, describe, expect, it } from 'vitest';
import { createLiveAgentsDemo } from './index.js';

let handle: Awaited<ReturnType<typeof createLiveAgentsDemo>> | null = null;

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

describe('@weaveintel/live-agents-demo API', () => {
  it('supports end-to-end create + tick + inbox flow', async () => {
    const port = 3611;
    handle = await createLiveAgentsDemo({ port });

    const now = '2025-06-10T10:00:00.000Z';

    await fetch(`${baseUrl(port)}/api/meshes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'mesh-api-1',
        tenantId: 'tenant-api',
        name: 'API Mesh',
        charter: 'Validate api integration',
        status: 'ACTIVE',
        dualControlRequiredFor: ['MESH_BRIDGE'],
        createdAt: now,
      }),
    });

    await fetch(`${baseUrl(port)}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'agent-api-1',
        meshId: 'mesh-api-1',
        name: 'Agent API',
        role: 'Coordinator',
        contractVersionId: 'contract-api-1',
        status: 'ACTIVE',
        createdAt: now,
        archivedAt: null,
      }),
    });

    await fetch(`${baseUrl(port)}/api/contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'contract-api-1',
        agentId: 'agent-api-1',
        version: 1,
        persona: 'Coordinator',
        objectives: 'Process pending inbox messages',
        successIndicators: 'Inbox is drained',
        budget: { monthlyUsdCap: 50, perActionUsdCap: 5 },
        workingHoursSchedule: { timezone: 'UTC', cronActive: '* * * * *' },
        accountBindingRefs: [],
        attentionPolicyRef: 'default',
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
      }),
    });

    await fetch(`${baseUrl(port)}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg-api-1',
        meshId: 'mesh-api-1',
        fromType: 'HUMAN',
        fromId: 'human:ops-admin-1',
        fromMeshId: null,
        toType: 'AGENT',
        toId: 'agent-api-1',
        topic: null,
        kind: 'ASK',
        replyToMessageId: null,
        threadId: 'thread-api-1',
        contextRefs: [],
        contextPacketRef: null,
        expiresAt: null,
        priority: 'NORMAL',
        status: 'PENDING',
        deliveredAt: null,
        readAt: null,
        processedAt: null,
        createdAt: now,
        subject: 'Process me',
        body: 'Please process this message.',
      }),
    });

    await fetch(`${baseUrl(port)}/api/heartbeat/ticks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'tick-api-1',
        agentId: 'agent-api-1',
        scheduledFor: now,
        pickedUpAt: null,
        completedAt: null,
        workerId: 'scheduler',
        leaseExpiresAt: null,
        actionChosen: null,
        actionOutcomeProse: null,
        actionOutcomeStatus: null,
        status: 'SCHEDULED',
      }),
    });

    const runResponse = await fetch(`${baseUrl(port)}/api/heartbeat/run-once`, { method: 'POST' });
    const runResult = await runResponse.json() as { processed: number };
    expect(runResult.processed).toBe(1);

    const inboxResponse = await fetch(`${baseUrl(port)}/api/agents/agent-api-1/inbox`);
    const inbox = await inboxResponse.json() as { messages: Array<{ status: string }> };
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.status).toBe('PROCESSED');
  });
});
