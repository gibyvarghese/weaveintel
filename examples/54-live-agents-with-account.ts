/**
 * Example 54 - live-agents with account
 *
 * Run: npx tsx examples/54-live-agents-with-account.ts
 */

import type { AccessTokenResolver } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createActionExecutor,
  createHeartbeat,
  createMcpAccountSessionProvider,
  weaveInMemoryStateStore,
  type AgentContract,
  type AttentionPolicy,
  type LiveAgent,
  type Mesh,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const now = '2025-06-03T09:00:00.000Z';
  const mcpCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let transportCreateCount = 0;

  const mesh: Mesh = {
    id: 'mesh-account',
    tenantId: 'tenant-live-agents-account',
    name: 'Customer Inbox Mesh',
    charter: 'Manage customer email workflow through account-bound MCP access.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-account-alice',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Customer Operations Agent',
    contractVersionId: 'contract-account-alice-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const contract: AgentContract = {
    id: 'contract-account-alice-v1',
    agentId: agent.id,
    version: 1,
    persona: 'You handle inbox triage and customer updates.',
    objectives: 'Read account inbox events and send customer responses.',
    successIndicators: 'Messages are handled through the authorized account only.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    accountBindingRefs: ['account-gmail-1'],
    attentionPolicyRef: 'with-account',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1200,
        actionTokensMax: 1200,
        handoffTokensMax: 600,
        reportTokensMax: 600,
        monthlyCompressionUsdCap: 5,
      },
      defaultsProfile: 'operational',
    },
    createdAt: now,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(contract);
  await store.saveAccount({
    id: 'account-gmail-1',
    meshId: mesh.id,
    provider: 'gmail',
    accountIdentifier: 'support@example.com',
    description: 'Shared customer support inbox account.',
    mcpServerRef: {
      url: 'fixture://gmail',
      serverType: 'HTTP',
      discoveryHint: 'gmail.list, gmail.read, gmail.send',
    },
    credentialVaultRef: 'vault://gmail-support',
    upstreamScopesDescription: 'Read + send only.',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: now,
    revokedAt: null,
  });
  await store.saveAccountBinding({
    id: 'binding-account-gmail-1',
    agentId: agent.id,
    accountId: 'account-gmail-1',
    purpose: 'Handle customer replies',
    constraints: 'No refunds in outbound emails.',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: now,
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });

  const { client, server } = weaveFakeTransport();
  const mcpServer = weaveMCPServer({ name: 'gmail-account-fixture', version: '1.0.0' });
  mcpServer.addTool(
    {
      name: 'gmail.list',
      description: 'List inbox message ids.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string' },
        },
        required: ['folder'],
      },
    },
    async (_ctx, args) => {
      mcpCalls.push({ tool: 'gmail.list', args });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: ['msg-1001'] }),
          },
        ],
      };
    },
  );
  mcpServer.addTool(
    {
      name: 'gmail.read',
      description: 'Read a message body.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
    async (_ctx, args) => {
      mcpCalls.push({ tool: 'gmail.read', args });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ subject: 'Shipment delay', body: 'Can I get an updated ETA?' }),
          },
        ],
      };
    },
  );
  mcpServer.addTool(
    {
      name: 'gmail.send',
      description: 'Send a reply email.',
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
      mcpCalls.push({ tool: 'gmail.send', args });
      return {
        content: [
          { type: 'text', text: 'sent' },
          { type: 'resource', uri: 'gmail://messages/outbound-1' },
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

  const session = await sessionProvider.getSession({
    account: (await store.loadAccount('account-gmail-1'))!,
    agent,
    ctx: weaveContext({ userId: 'human:ops-admin-1' }),
  });
  await session.callTool(weaveContext({ userId: 'human:ops-admin-1' }), {
    name: 'gmail.list',
    arguments: { folder: 'inbox' },
  });
  await session.callTool(weaveContext({ userId: 'human:ops-admin-1' }), {
    name: 'gmail.read',
    arguments: { id: 'msg-1001' },
  });

  await store.saveHeartbeatTick({
    id: 'tick-account-1',
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

  const attentionPolicy: AttentionPolicy = {
    key: 'with-account',
    async decide() {
      return {
        type: 'DraftMessage',
        to: { type: 'HUMAN', id: 'customer@example.com' },
        kind: 'REPLY',
        subject: 'Updated shipment ETA',
        bodySeed: 'Thanks for your patience. Your updated ETA is tomorrow by 6 PM UTC.',
      };
    },
  };

  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-account-1',
    concurrency: 1,
    attentionPolicy,
    actionExecutor: createActionExecutor({ sessionProvider }),
    now: () => now,
  });

  await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));

  const outbound = await store.listOutboundActionRecords(agent.id);
  const delivered = await store.listMessagesForRecipient('HUMAN', 'customer@example.com');

  console.log('Live-agents with account example is wired and running.');
  console.log(`MCP calls: ${mcpCalls.map((call) => call.tool).join(', ')}`);
  console.log(`Outbound records: ${outbound.length}`);
  console.log(`Delivered status: ${delivered[0]?.status ?? 'n/a'}`);
  console.log(`Session pool transport creations: ${transportCreateCount}`);

  await sessionProvider.disconnectAll?.();
  await mcpServer.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
