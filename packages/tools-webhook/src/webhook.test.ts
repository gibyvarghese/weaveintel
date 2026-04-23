import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createWebhookMCPServer, type WebhookAdapter } from './webhook.js';

function fixtureAdapter(): WebhookAdapter {
  return {
    async post(_creds, url, body) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, url, body }) };
    },
    async subscribe(target) { return { subscribed: true, target }; },
  };
}

describe('@weaveintel/tools-webhook (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createWebhookMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { webhookBearerToken: 'token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 2 webhook tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createWebhookMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(2);
  });

  it('webhook.post returns response envelope', async () => {
    const result = await callTool('webhook.post', { url: 'https://example.com/hook', body: { hello: 'world' } });
    expect(JSON.parse(result.content[0]!.text).status).toBe(200);
  });

  it('webhook.subscribe returns subscribed status', async () => {
    const result = await callTool('webhook.subscribe', { target: 'orders.created' });
    expect(JSON.parse(result.content[0]!.text).subscribed).toBe(true);
  });

  it('enforces webhook host allow-list', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createWebhookMCPServer({
      adapter: fixtureAdapter(),
      security: { allowedHosts: ['hooks.example.com'] },
    });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);

    await expect(
      mc.callTool(weaveContext(), {
        name: 'webhook.post',
        arguments: {
          url: 'https://not-allowed.example.com/hook',
          body: { ok: true },
        },
      }),
    ).rejects.toThrow('not in allow list');
  });

  it('refreshes bearer token and retries once on 401', async () => {
    const attempts: string[] = [];
    const adapter: WebhookAdapter = {
      async post(creds) {
        const token = creds.bearerToken ?? '';
        attempts.push(token);
        if (token === 'fresh-token') {
          return { status: 200, headers: {}, body: 'ok' };
        }
        return { status: 401, headers: {}, body: 'unauthorized' };
      },
      async subscribe(target) {
        return { subscribed: true, target };
      },
    };

    const { client, server: transport } = weaveFakeTransport();
    const server = createWebhookMCPServer({
      adapter,
      tokenProvider: {
        async getToken() {
          return 'stale-token';
        },
        async refreshToken() {
          return 'fresh-token';
        },
      },
    });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);

    const result = await mc.callTool(
      weaveContext({ metadata: { webhookAuthType: 'bearer' } }),
      {
        name: 'webhook.post',
        arguments: {
          url: 'https://hooks.example.com/hook',
          body: { ok: true },
        },
      },
    );

    const first = result.content[0];
    if (!first || first.type !== 'text') {
      throw new Error('Expected text content');
    }
    expect(JSON.parse(first.text).status).toBe(200);
    expect(attempts).toEqual(['stale-token', 'fresh-token']);
  });
});
