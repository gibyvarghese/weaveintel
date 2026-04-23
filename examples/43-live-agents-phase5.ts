/**
 * Example 43 — live-agents Phase 5 MCP-backed external delivery
 *
 * Run: npx tsx examples/43-live-agents-phase5.ts
 */

import type { AccessTokenResolver } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createActionExecutor,
  createHeartbeat,
  createMcpAccountSessionProvider,
  type AgentContract,
  type AttentionPolicy,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = '2025-01-01T00:00:00.000Z';
  const deliveries: Array<Record<string, unknown>> = [];
  let transportCreateCount = 0;

  const mesh: Mesh = {
    id: 'mesh-phase5',
    tenantId: 'tenant-phase5',
    name: 'Phase 5 MCP Mesh',
    charter: 'Demonstrate account-bound MCP delivery through heartbeat execution.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-phase5-alice',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Coordinator',
    contractVersionId: 'contract-phase5-alice-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-phase5-alice-v1',
    agentId: agent.id,
    version: 1,
    persona: 'A customer-communications coordinator.',
    objectives: 'Send timely external updates through the bound account.',
    successIndicators: 'External delivery succeeds with audit records and no duplicate sessions.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    accountBindingRefs: ['account-phase5-gmail'],
    attentionPolicyRef: 'standard-v1',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1500,
        actionTokensMax: 1500,
        handoffTokensMax: 600,
        reportTokensMax: 600,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'standard',
    },
    createdAt: now,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);
  await store.saveAccount({
    id: 'account-phase5-gmail',
    meshId: mesh.id,
    provider: 'gmail',
    accountIdentifier: 'alice@example.com',
    description: 'Fixture Gmail account for Alice.',
    mcpServerRef: {
      url: 'fixture://gmail',
      serverType: 'HTTP',
      discoveryHint: 'gmail.send fixture tool',
    },
    credentialVaultRef: 'vault://alice-gmail',
    upstreamScopesDescription: 'send only',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: now,
    revokedAt: null,
  });
  await store.saveAccountBinding({
    id: 'binding-phase5-gmail',
    agentId: agent.id,
    accountId: 'account-phase5-gmail',
    purpose: 'Send customer delivery notifications.',
    constraints: 'Low-risk transactional communication only.',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: now,
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });
  await store.saveHeartbeatTick({
    id: 'tick-phase5-1',
    agentId: agent.id,
    scheduledFor: now,
    pickedUpAt: null,
    completedAt: null,
    workerId: 'scheduler',
    leaseExpiresAt: null,
    actionChosen: null,
    actionOutcomeProse: null,
    actionOutcomeStatus: null,
    status: 'SCHEDULED',
  });

  const { client, server } = weaveFakeTransport();
  const mcpServer = weaveMCPServer({ name: 'gmail-fixture', version: '1.0.0' });
  mcpServer.addTool(
    {
      name: 'gmail.send',
      description: 'Send an email through Gmail.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    async (_ctx, args) => {
      deliveries.push(args);
      return {
        content: [
          { type: 'text', text: 'sent fixture email' },
          { type: 'resource', uri: 'gmail://messages/fixture-1' },
        ],
      };
    },
  );
  await mcpServer.start(server);

  const tokenResolver: AccessTokenResolver = {
    async resolve() {
      return 'fixture-token';
    },
    async revoke() {
      return;
    },
  };

  const sessionProvider = createMcpAccountSessionProvider({
    tokenResolver,
    transportFactory: {
      async createTransport() {
        transportCreateCount += 1;
        return client;
      },
    },
  });

  const attentionPolicy: AttentionPolicy = {
    key: 'phase5-demo',
    async decide() {
      return {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: 'customer@example.com' },
        kind: 'REPORT',
        subject: 'Your request is complete',
        bodySeed: 'The updated delivery plan has been applied successfully.',
      };
    },
  };

  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-phase5-1',
    concurrency: 1,
    attentionPolicy,
    actionExecutor: createActionExecutor({ sessionProvider }),
    now: () => now,
  });

  const result = await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));
  const updatedTick = await store.loadHeartbeatTick('tick-phase5-1');
  const outboundRecords = await store.listOutboundActionRecords(agent.id);
  const deliveredMessages = await store.listMessagesForRecipient('HUMAN', 'customer@example.com');

  console.log('Live-agents Phase 5 MCP integration is wired and running.');
  console.log(`Tick processed count: ${result.processed}`);
  console.log(`Tick status: ${updatedTick?.status}`);
  console.log(`Chosen action: ${updatedTick?.actionChosen?.type ?? 'none'}`);
  console.log(`Outbound records: ${outboundRecords.length}`);
  console.log(`Outbound status: ${outboundRecords[0]?.status ?? 'none'}`);
  console.log(`Delivered message status: ${deliveredMessages[0]?.status ?? 'none'}`);
  console.log(`Fixture deliveries: ${deliveries.length}`);
  console.log(`Session pool created transports: ${transportCreateCount}`);

  await sessionProvider.disconnectAll?.();
  await mcpServer.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
