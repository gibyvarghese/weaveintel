/**
 * @weaveintel/tools-webhook — Generic outbound webhook MCP server
 * Sends HTTP requests to arbitrary endpoints. Optional auth via ctx.metadata.webhookBearerToken.
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface WebhookCredentials { bearerToken?: string; }

export interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookAdapter {
  post(creds: WebhookCredentials, url: string, body: unknown, headers?: Record<string, string>): Promise<WebhookResponse>;
  subscribe(target: string, secret?: string): Promise<{ subscribed: true; target: string }>;
}

function extractCredentials(ctx: ExecutionContext): WebhookCredentials {
  const token = ctx.metadata?.['webhookBearerToken'] as string | undefined;
  return { bearerToken: token };
}

export const liveWebhookAdapter: WebhookAdapter = {
  async post(creds, url, body, headers) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(creds.bearerToken ? { Authorization: `Bearer ${creds.bearerToken}` } : {}),
        ...(headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
    const text = await resp.text();
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: resp.status, headers: outHeaders, body: text };
  },
  async subscribe(target) { return { subscribed: true, target }; },
};

export interface WebhookMCPServerOptions { adapter?: WebhookAdapter; }

export function createWebhookMCPServer(opts: WebhookMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveWebhookAdapter;
  const server = weaveMCPServer(
    { name: 'webhook', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('webhook.post', 'Send outbound webhook HTTP POST', 'external-side-effect');
  describeT('webhook.subscribe', 'Register webhook subscription metadata', 'write');

  server.addTool({ name: 'webhook.post', description: 'POST JSON payload to a webhook endpoint.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, body: { type: 'object', additionalProperties: true }, headers: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['url'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const result = await adapter.post(creds, String(args['url']), args['body'], args['headers'] as Record<string, string> | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.addTool({ name: 'webhook.subscribe', description: 'Record intent to receive inbound webhooks.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, secret: { type: 'string' } }, required: ['target'] } }, async (_ctx, args) => {
    const result = await adapter.subscribe(String(args['target']), args['secret'] as string | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}
