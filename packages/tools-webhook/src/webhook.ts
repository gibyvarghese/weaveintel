/**
 * @weaveintel/tools-webhook — Generic outbound webhook MCP server
 * Sends HTTP requests to arbitrary endpoints. Optional auth via ctx.metadata.webhookBearerToken.
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import {
  weaveToolDescriptor as describeT,
  readResponseTextLimited,
  validateOutboundUrl,
} from '@weaveintel/tools';

export interface WebhookCredentials {
  authType?: 'none' | 'bearer' | 'basic' | 'api_key';
  bearerToken?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  apiKeyHeaderName?: string;
  extraHeaders?: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookAdapter {
  post(
    creds: WebhookCredentials,
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    options?: { timeoutMs?: number; maxResponseBytes?: number },
  ): Promise<WebhookResponse>;
  subscribe(target: string, secret?: string): Promise<{ subscribed: true; target: string }>;
}

export interface WebhookTokenProvider {
  getToken(ctx: ExecutionContext): Promise<string | null>;
  refreshToken(ctx: ExecutionContext): Promise<string | null>;
}

export interface WebhookSecurityOptions {
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowPrivateNetwork?: boolean;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

function extractCredentials(ctx: ExecutionContext, tokenProvider?: WebhookTokenProvider): Promise<WebhookCredentials> {
  const authType = (ctx.metadata?.['webhookAuthType'] as WebhookCredentials['authType'] | undefined) ?? 'bearer';
  const bearerToken = (ctx.metadata?.['webhookBearerToken'] as string | undefined) ?? undefined;
  const username = (ctx.metadata?.['webhookUsername'] as string | undefined) ?? undefined;
  const password = (ctx.metadata?.['webhookPassword'] as string | undefined) ?? undefined;
  const apiKey = (ctx.metadata?.['webhookApiKey'] as string | undefined) ?? undefined;
  const apiKeyHeaderName = (ctx.metadata?.['webhookApiKeyHeaderName'] as string | undefined) ?? 'X-API-Key';
  const extraHeaders = (ctx.metadata?.['webhookExtraHeaders'] as Record<string, string> | undefined) ?? undefined;

  if (authType !== 'bearer' || bearerToken || !tokenProvider) {
    return Promise.resolve({
      authType,
      bearerToken,
      username,
      password,
      apiKey,
      apiKeyHeaderName,
      extraHeaders,
    });
  }

  return tokenProvider.getToken(ctx).then((token) => ({
    authType,
    bearerToken: token ?? undefined,
    username,
    password,
    apiKey,
    apiKeyHeaderName,
    extraHeaders,
  }));
}

async function readResponseBodyLimited(resp: Response, maxBytes: number): Promise<string> {
  return readResponseTextLimited(resp, maxBytes);
}

export const liveWebhookAdapter: WebhookAdapter = {
  async post(creds, url, body, headers, options) {
    const timeoutMs = Math.max(1, options?.timeoutMs ?? 10_000);
    const maxResponseBytes = Math.max(1, options?.maxResponseBytes ?? 1_000_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const authHeaders: Record<string, string> = {};
    if (creds.authType === 'basic' && creds.username && creds.password) {
      authHeaders['Authorization'] = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
    }
    if (creds.authType === 'api_key' && creds.apiKey) {
      authHeaders[creds.apiKeyHeaderName ?? 'X-API-Key'] = creds.apiKey;
    }
    if ((creds.authType === 'bearer' || (!creds.authType && creds.bearerToken)) && creds.bearerToken) {
      authHeaders['Authorization'] = `Bearer ${creds.bearerToken}`;
    }

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...(creds.extraHeaders ?? {}),
          ...(headers ?? {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await readResponseBodyLimited(resp, maxResponseBytes);
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: resp.status, headers: outHeaders, body: text };
  },
  async subscribe(target) { return { subscribed: true, target }; },
};

export interface WebhookMCPServerOptions {
  adapter?: WebhookAdapter;
  tokenProvider?: WebhookTokenProvider;
  security?: WebhookSecurityOptions;
}

export function createWebhookMCPServer(opts: WebhookMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveWebhookAdapter;
  const security: WebhookSecurityOptions = {
    allowPrivateNetwork: false,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_000_000,
    ...(opts.security ?? {}),
  };
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
    const rawUrl = String(args['url']);
    const parsed = await validateOutboundUrl(rawUrl, {
      allowedHosts: security.allowedHosts,
      blockedHosts: security.blockedHosts,
      allowPrivateNetwork: security.allowPrivateNetwork,
    });
    const creds = await extractCredentials(ctx, opts.tokenProvider);
    let result = await adapter.post(
      creds,
      parsed.toString(),
      args['body'],
      args['headers'] as Record<string, string> | undefined,
      {
        timeoutMs: security.requestTimeoutMs,
        maxResponseBytes: security.maxResponseBytes,
      },
    );

    if (result.status === 401 && creds.authType === 'bearer' && opts.tokenProvider) {
      const refreshed = await opts.tokenProvider.refreshToken(ctx);
      if (refreshed) {
        const retryCreds: WebhookCredentials = { ...creds, bearerToken: refreshed };
        result = await adapter.post(
          retryCreds,
          parsed.toString(),
          args['body'],
          args['headers'] as Record<string, string> | undefined,
          {
            timeoutMs: security.requestTimeoutMs,
            maxResponseBytes: security.maxResponseBytes,
          },
        );
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.addTool({ name: 'webhook.subscribe', description: 'Record intent to receive inbound webhooks.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, secret: { type: 'string' } }, required: ['target'] } }, async (_ctx, args) => {
    const result = await adapter.subscribe(String(args['target']), args['secret'] as string | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}
