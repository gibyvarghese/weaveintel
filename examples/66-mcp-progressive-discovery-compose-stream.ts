/**
 * Example 66 — Progressive discovery + composable MCP call chain + streaming
 */

import { weaveContext } from '@weaveintel/core';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveMCPServer } from '@weaveintel/mcp-server';

async function main(): Promise<void> {
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();

  const server = weaveMCPServer({ name: 'compose-stream-example', version: '1.0.0' });

  server.addTool(
    {
      name: 'search.query',
      description: 'Returns synthetic search text',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    async (_ctx, args) => ({
      content: [{ type: 'text', text: `RESULT(${String(args.query ?? '')})` }],
    }),
  );

  server.addTool(
    {
      name: 'summarize.text',
      description: 'Summarizes text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    async (_ctx, args) => ({
      content: [{ type: 'text', text: `SUMMARY(${String(args.text ?? '')})` }],
    }),
  );

  await server.start(serverTransport);

  const client = weaveMCPClient();
  await client.connect(clientTransport);

  const discovery = await client.discoverCapabilities?.({
    namespacePrefix: 'search',
    includeDetails: true,
  });
  console.log('discovery items:', discovery?.items.map((item) => `${item.kind}:${item.name}`));

  const ctx = weaveContext({ tenantId: 'tenant-a', userId: 'user-a' });
  const composed = await client.composeToolCalls?.(ctx, {
    id: 'compose-1',
    steps: [
      {
        id: 'step-search',
        toolName: 'search.query',
        arguments: { query: 'weaveintel mcp stateless edge' },
      },
      {
        id: 'step-summary',
        toolName: 'summarize.text',
        dependsOn: ['step-search'],
        inputFromStepId: 'step-search',
        inputPath: 'content.0.text',
        mergeInputAs: 'text',
      },
    ],
  });

  console.log('composed outputs:', composed?.outputsByStepId);

  if (client.streamToolCall) {
    console.log('stream events:');
    for await (const event of client.streamToolCall(ctx, {
      name: 'search.query',
      arguments: { query: 'stream me' },
    })) {
      console.log(`  ${event.type}`, event.message ?? '', event.output ?? '');
    }
  }

  await client.disconnect();
  await server.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
