/**
 * Example 67 — LiveAgents account session provider with stateless-friendly TTL,
 * progressive discovery, and streaming MCP progress passthrough.
 */

import { weaveContext } from '@weaveintel/core';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { createMcpAccountSessionProvider, type Account } from '@weaveintel/live-agents';

async function main(): Promise<void> {
  const { client, server } = weaveFakeTransport();

  const mcpServer = weaveMCPServer({ name: 'live-agent-mcp-example', version: '1.0.0' });
  mcpServer.addTool(
    {
      name: 'gmail.list_messages',
      description: 'List synthetic messages',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async () => ({
      content: [{ type: 'text', text: 'message-1\nmessage-2' }],
    }),
  );
  await mcpServer.start(server);

  const provider = createMcpAccountSessionProvider({
    tokenResolver: {
      async resolve() {
        return 'token-demo';
      },
      async revoke() {
        return;
      },
    },
    transportFactory: {
      async createTransport() {
        return client;
      },
    },
    sessionTtlMs: 1_000,
  });

  const account: Account = {
    id: 'acct-1',
    meshId: 'mesh-1',
    accountIdentifier: 'demo@example.com',
    credentialVaultRef: 'vault:acct-1',
    provider: 'gmail',
    description: 'Demo Gmail account',
    mcpServerRef: {
      url: 'memory://gmail-demo',
      serverType: 'HTTP',
      discoveryHint: 'demo',
    },
    upstreamScopesDescription: 'gmail.readonly',
    ownerHumanId: 'user-1',
    createdAt: new Date().toISOString(),
    status: 'ACTIVE',
    revokedAt: null,
  };

  const agent = {
    id: 'agent-1',
    meshId: 'mesh-1',
    name: 'Mail Agent',
    role: 'assistant',
    contractVersionId: 'contract-1',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    archivedAt: null,
  } as const;

  const ctx = weaveContext({ tenantId: 'mesh-1', userId: 'user-1' });
  const session = await provider.getSession({ account, agent, ctx });

  const discovered = await session.discoverCapabilities?.({ namespacePrefix: 'gmail' });
  console.log('discovered:', discovered?.items.map((item) => item.name));

  const result = await session.callTool(ctx, {
    name: 'gmail.list_messages',
    arguments: {},
  });
  console.log('call result:', result);

  if (session.streamToolCall) {
    for await (const event of session.streamToolCall(ctx, {
      name: 'gmail.list_messages',
      arguments: {},
    })) {
      console.log('stream event:', event.type, event.message ?? '');
    }
  }

  await provider.disconnectAll?.();
  await mcpServer.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
