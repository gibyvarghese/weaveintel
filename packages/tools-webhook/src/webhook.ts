/**
 * @weaveintel/tools-webhook — Generic outbound webhook MCP server
 * Sends HTTP requests to arbitrary endpoints. Optional auth via ctx.metadata.webhookBearerToken.
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

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

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  const match172 = /^172\.(\d{1,3})\./.exec(host);
  if (match172) {
    const secondOctet = Number.parseInt(match172[1] ?? '0', 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

function validateWebhookUrl(url: string, opts: WebhookSecurityOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Webhook URL must use http or https');
  }

  const host = parsed.hostname.toLowerCase();
  if ((opts.allowPrivateNetwork ?? false) === false && isPrivateHost(host)) {
    throw new Error(`Webhook URL host is not allowed: ${host}`);
  }

  if ((opts.blockedHosts ?? []).map((h) => h.toLowerCase()).includes(host)) {
    throw new Error(`Webhook URL host is blocked: ${host}`);
  }

  const allowed = opts.allowedHosts ?? [];
  if (allowed.length > 0 && !allowed.map((h) => h.toLowerCase()).includes(host)) {
    throw new Error(`Webhook URL host is not in allow list: ${host}`);
  }

  return parsed;
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
  const len = resp.headers.get('content-length');
  if (len) {
    const size = Number.parseInt(len, 10);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`Webhook response exceeds max size of ${maxBytes} bytes`);
    }
  }

  const body = resp.body;
  if (!body) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Webhook response exceeds max size of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
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
    const parsed = validateWebhookUrl(rawUrl, security);
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
