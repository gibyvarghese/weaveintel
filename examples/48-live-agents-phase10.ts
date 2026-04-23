import { weaveContext } from '@weaveintel/core';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { createWebhookMCPServer, type WebhookAdapter } from '../packages/tools-webhook/src/index.js';
import { createFilewatchMCPServer, type FilewatchAdapter } from '../packages/tools-filewatch/src/index.js';

const webhookFixtureAdapter: WebhookAdapter = {
  async post(_creds, url, body) {
    return { status: 200, headers: { 'x-demo': 'phase10' }, body: JSON.stringify({ ok: true, url, body }) };
  },
  async subscribe(target) {
    return { subscribed: true, target };
  },
};

const filewatchFixtureAdapter: FilewatchAdapter = {
  async list() {
    return [{ path: '/workspace/notes.txt', isDirectory: false, size: 12, mtimeMs: Date.now() }];
  },
  async read() {
    return 'hello phase 10';
  },
  async write(_creds, _path, content) {
    return { writtenBytes: content.length };
  },
  async subscribe(_creds, p) {
    return { subscribed: true, path: p };
  },
};

async function callMcpServer(
  serverFactory: () => { start: (transport: unknown) => Promise<void> },
  ctxMetadata: Record<string, unknown>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { client, server: transport } = weaveFakeTransport();
  const server = serverFactory();
  await server.start(transport);
  const clientApi = weaveMCPClient();
  await clientApi.connect(client);
  const ctx = weaveContext({ metadata: ctxMetadata });
  const result = await clientApi.callTool(ctx, { name: toolName, arguments: args }) as { content?: Array<{ type: string; text: string }> };
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const webhookResult = await callMcpServer(
    () => createWebhookMCPServer({ adapter: webhookFixtureAdapter }),
    { webhookBearerToken: 'demo-token' },
    'webhook.post',
    { url: 'https://example.test/hook', body: { event: 'order.created', id: 'ord-1' } },
  );

  const fileRead = await callMcpServer(
    () => createFilewatchMCPServer({ adapter: filewatchFixtureAdapter }),
    { filewatchBasePath: '/workspace' },
    'filewatch.read',
    { path: 'notes.txt' },
  );

  const fileWrite = await callMcpServer(
    () => createFilewatchMCPServer({ adapter: filewatchFixtureAdapter }),
    { filewatchBasePath: '/workspace' },
    'filewatch.write',
    { path: 'notes.txt', content: 'updated phase 10 example' },
  );

  console.log('Phase 10 MCP demo');
  console.log(JSON.stringify({ webhookResult, fileRead, fileWrite }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
