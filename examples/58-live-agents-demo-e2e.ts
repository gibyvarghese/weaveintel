/**
 * Example 58 - live-agents demo app end-to-end
 *
 * Run: npx tsx examples/58-live-agents-demo-e2e.ts
 */

import { createLiveAgentsDemo } from '@weaveintel/live-agents-demo';

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function main() {
  const port = 3620;
  const app = await createLiveAgentsDemo({ port });
  const now = '2025-06-11T10:00:00.000Z';

  try {
    await fetch(url(port, '/api/meshes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'mesh-demo-1',
        tenantId: 'tenant-demo',
        name: 'Demo Mesh',
        charter: 'End-to-end app demo mesh.',
        status: 'ACTIVE',
        dualControlRequiredFor: ['MESH_BRIDGE'],
        createdAt: now,
      }),
    });

    await fetch(url(port, '/api/agents'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'agent-demo-1',
        meshId: 'mesh-demo-1',
        name: 'Demo Agent',
        role: 'Coordinator',
        contractVersionId: 'contract-demo-1',
        status: 'ACTIVE',
        createdAt: now,
        archivedAt: null,
      }),
    });

    await fetch(url(port, '/api/contracts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'contract-demo-1',
        agentId: 'agent-demo-1',
        version: 1,
        persona: 'Demo persona',
        objectives: 'Process inbox message through heartbeat.',
        successIndicators: 'Message status becomes PROCESSED.',
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

    await fetch(url(port, '/api/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg-demo-1',
        meshId: 'mesh-demo-1',
        fromType: 'HUMAN',
        fromId: 'human:ops-admin-1',
        fromMeshId: null,
        toType: 'AGENT',
        toId: 'agent-demo-1',
        topic: null,
        kind: 'ASK',
        replyToMessageId: null,
        threadId: 'thread-demo-1',
        contextRefs: [],
        contextPacketRef: null,
        expiresAt: null,
        priority: 'NORMAL',
        status: 'PENDING',
        deliveredAt: null,
        readAt: null,
        processedAt: null,
        createdAt: now,
        subject: 'Demo question',
        body: 'Please process this demo message.',
      }),
    });

    await fetch(url(port, '/api/heartbeat/ticks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'tick-demo-1',
        agentId: 'agent-demo-1',
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

    const runResult = await fetch(url(port, '/api/heartbeat/run-once'), { method: 'POST' }).then((res) => res.json()) as { processed: number };
    const inbox = await fetch(url(port, '/api/agents/agent-demo-1/inbox')).then((res) => res.json()) as {
      messages: Array<{ status: string }>;
    };

    console.log('Live-agents demo app end-to-end example is wired and running.');
    console.log(`Heartbeat processed: ${runResult.processed}`);
    console.log(`Inbox count: ${inbox.messages.length}`);
    console.log(`First message status: ${inbox.messages[0]?.status ?? 'n/a'}`);
  } finally {
    await app.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
