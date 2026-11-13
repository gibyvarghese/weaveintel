// SPDX-License-Identifier: MIT
/**
 * The endpoint over real loopback HTTP, driven by the official SDK client (which speaks 2025-11-25), so
 * the old version is proven to keep working against the new handler, plus the Node adapter's own limits.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { weaveContext } from '@weaveintel/core';
import { mcpText } from './jsonrpc.js';
import { weaveMcpEndpoint, urlElicitationRequired, type McpEndpointOptions } from './endpoint.js';
import { MCP_MANIFEST_META_KEY } from './manifest.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A host that verifies its bearer (here: a fixed test token) and hands the endpoint only what it verified. */
async function host(
  over: Partial<McpEndpointOptions> = {},
  opts: { maxBodyBytes?: number } = {},
): Promise<string> {
  const ep = weaveMcpEndpoint({
    serverInfo: { name: 'http-test', version: '1.0.0' },
    contextFactory: (request) => {
      if (!request.authInfo) throw new Error('no verified caller');
      return weaveContext({ userId: String(request.authInfo.clientId), signal: request.signal });
    },
    tools: [
      {
        tool: { name: 'whoami', description: 'Who you are.', inputSchema: { type: 'object' } },
        scopes: ['profile'],
        handler: async ({ ctx }) => mcpText(String(ctx.userId)),
      },
      {
        tool: {
          name: 'incident_comment',
          description: 'Comment.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
        scopes: ['itsm.write'],
        handler: async () => mcpText('done'),
      },
    ],
    resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource/mcp',
    ...over,
  });
  server = createServer((req, res) => {
    const auth = req.headers['authorization'];
    const scopes = String(req.headers['x-test-scopes'] ?? '')
      .split(' ')
      .filter(Boolean);
    const authInfo =
      auth === 'Bearer good' ? { token: 'good', clientId: 'person-1', scopes } : undefined;
    void ep.serve(req, res, {
      ...(authInfo ? { authInfo } : {}),
      ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}/mcp`;
}

async function sdkClient(url: string, scopes: string): Promise<Client> {
  const client = new Client({ name: 'sdk-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: 'Bearer good', 'x-test-scopes': scopes } },
    }),
  );
  return client;
}

describe('weaveMcpEndpoint over HTTP with the SDK client (2025-11-25)', () => {
  it('connects, lists only scoped tools with the manifest hash, and calls one', async () => {
    const client = await sdkClient(await host(), 'profile');
    expect(client.getServerVersion()).toMatchObject({ name: 'http-test' });
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['whoami']);
    expect((listed._meta as Record<string, unknown>)[MCP_MANIFEST_META_KEY]).toBeDefined();
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'person-1' }]);
    await client.close();
  });

  it('a confirm hook reaches the SDK client as its UrlElicitationRequired error', async () => {
    const url = await host({
      confirm: async () =>
        urlElicitationRequired({
          elicitationId: 'ch_9',
          url: 'https://tenant.example/confirm/ch_9',
          message: 'Confirm.',
        }),
    });
    const client = await sdkClient(url, 'itsm.write');
    const err = await client
      .callTool({ name: 'incident_comment', arguments: { id: 'x' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.UrlElicitationRequired);
    expect((err as McpError).data).toMatchObject({
      elicitations: [{ mode: 'url', elicitationId: 'ch_9' }],
    });
    await client.close();
  });

  it('NEGATIVE: a call without the scope reaches the SDK client as a 403', async () => {
    const client = await sdkClient(await host(), 'profile');
    const err = await client
      .callTool({ name: 'incident_comment', arguments: {} })
      .catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe(403);
    expect(String(err)).toMatch(/insufficient_scope/);
    await client.close();
  });

  it('NEGATIVE: no bearer is a 401 with the resource metadata challenge', async () => {
    const url = await host();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('weaveMcpEndpoint Node adapter', () => {
  it('2026-07-28 over HTTP: discover then call', async () => {
    const url = await host();
    const h = {
      'content-type': 'application/json',
      authorization: 'Bearer good',
      'x-test-scopes': 'profile',
      'mcp-protocol-version': '2026-07-28',
    };
    const d = await fetch(url, {
      method: 'POST',
      headers: { ...h, 'mcp-method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
    });
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toMatch(/application\/json/);
    expect(
      ((await d.json()) as { result: { supportedVersions: string[] } }).result.supportedVersions,
    ).toContain('2026-07-28');
    const c = await fetch(url, {
      method: 'POST',
      headers: { ...h, 'mcp-method': 'tools/call', 'mcp-name': 'whoami' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
    expect(((await c.json()) as { result: Record<string, unknown> }).result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'person-1' }],
    });
  });
  it('NEGATIVE: a body over the limit is 413 and is not parsed', async () => {
    const url = await host({}, { maxBodyBytes: 64 });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { pad: 'x'.repeat(200) },
      }),
    });
    expect(res.status).toBe(413);
  });
  it('NEGATIVE: a body that is not JSON is 400 with a parse error', async () => {
    const url = await host();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
  it('a notification is 202 with no body', async () => {
    const url = await host();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer good',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});
