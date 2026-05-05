/**
 * HTTP client with auth, retry, rate limiting, and response transforms
 *
 * Retry / circuit / signal-bus is delegated to `@weaveintel/resilience` so
 * tools-http endpoints share their resilience state with the rest of the
 * platform (one circuit breaker per endpoint name, process-wide).
 */
import { readResponseTextLimited, validateOutboundUrl } from '@weaveintel/tools';
import { runResilient } from '@weaveintel/resilience';
import { WeaveIntelError, parseRetryAfterMs } from '@weaveintel/core';
import type { HttpEndpointConfig, HttpRequestOptions, HttpResponse } from './types.js';

/* ---------- Auth helpers ---------- */

function applyAuth(headers: Record<string, string>, config: HttpEndpointConfig): Record<string, string> {
  const out = { ...headers };
  switch (config.authType) {
    case 'api_key': {
      const key = config.authConfig?.['headerName'] ?? 'X-API-Key';
      const val = config.authConfig?.['apiKey'] ?? '';
      out[key] = val;
      break;
    }
    case 'bearer':
      out['Authorization'] = `Bearer ${config.authConfig?.['token'] ?? ''}`;
      break;
    case 'basic': {
      const user = config.authConfig?.['username'] ?? '';
      const pass = config.authConfig?.['password'] ?? '';
      out['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      break;
    }
    case 'oauth2':
      out['Authorization'] = `Bearer ${config.authConfig?.['accessToken'] ?? ''}`;
      break;
  }
  return out;
}

/* ---------- Retry wrapper ---------- */

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/* ---------- Rate limiter ---------- */

const rateBuckets = new Map<string, { tokens: number; lastRefill: number; rpm: number; lastSeen: number }>();
const RATE_BUCKET_TTL_MS = 15 * 60_000;
const RATE_BUCKET_MAX_SIZE = 1_000;

function sweepRateBuckets(now: number): void {
  if (rateBuckets.size <= RATE_BUCKET_MAX_SIZE) return;
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.lastSeen > RATE_BUCKET_TTL_MS) {
      rateBuckets.delete(key);
    }
  }
}

function checkRate(name: string, rpm: number): void {
  const now = Date.now();
  sweepRateBuckets(now);
  let bucket = rateBuckets.get(name);
  if (!bucket) {
    bucket = { tokens: rpm, lastRefill: now, rpm, lastSeen: now };
    rateBuckets.set(name, bucket);
  }
  bucket.lastSeen = now;
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 60_000) {
    bucket.tokens = rpm;
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) throw new Error(`Rate limit exceeded for "${name}" (${rpm} req/min)`);
  bucket.tokens--;
}

/* ---------- Response transform ---------- */

function applyTransform(body: string, transform?: string): string {
  if (!transform) return body;
  try {
    const data = JSON.parse(body);
    // Simple JSONPath-like extraction: e.g. "data.items"
    const parts = transform.split('.');
    let result: unknown = data;
    for (const p of parts) {
      if (result && typeof result === 'object') result = (result as Record<string, unknown>)[p];
      else break;
    }
    return JSON.stringify(result);
  } catch {
    return body;
  }
}

/* ---------- Body template ---------- */

function applyTemplate(template: string | undefined, input: Record<string, unknown>): string | undefined {
  if (!template) return undefined;
  let result = template;
  for (const [k, v] of Object.entries(input)) {
    result = result.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  return result;
}

/* ---------- HTTP client ---------- */

export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const start = Date.now();
  const parsedUrl = await validateOutboundUrl(options.url, {
    allowedHosts: options.allowedHosts,
    blockedHosts: options.blockedHosts,
    allowPrivateNetwork: options.allowPrivateNetwork,
  });
  const controller = new AbortController();
  const timeoutId = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
  const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  try {
    const resp = await fetch(parsedUrl.toString(), {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
      signal: controller.signal,
    });
    const body = await readResponseTextLimited(resp, maxResponseBytes, controller.signal);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return { status: resp.status, statusText: resp.statusText, headers, body, latencyMs: Date.now() - start };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Execute an HTTP request using a configured endpoint, with auth, retry, and rate limiting.
 */
export async function executeEndpoint(
  config: HttpEndpointConfig,
  input: Record<string, unknown>,
): Promise<HttpResponse> {
  if (config.rateLimit) checkRate(config.name, config.rateLimit.requestsPerMinute);

  const url = String(input['url'] ?? config.baseUrl);
  const method = String(input['method'] ?? config.method ?? 'GET');
  const baseHeaders: Record<string, string> = { ...(config.headers ?? {}) };
  const authedHeaders = applyAuth(baseHeaders, config);
  const body = applyTemplate(config.bodyTemplate, input) ?? (input['body'] ? JSON.stringify(input['body']) : undefined);

  const fn = async () => {
    const response = await httpRequest({
      url,
      method,
      headers: authedHeaders,
      body,
      timeout: config.timeout ?? 30_000,
      allowedHosts: config.allowedHosts,
      blockedHosts: config.blockedHosts,
      allowPrivateNetwork: config.allowPrivateNetwork,
      maxResponseBytes: config.maxResponseBytes,
    });
    if (isRetryableStatus(response.status)) {
      // Throw a retryable WeaveIntelError so the resilience pipeline retries.
      // Carry the response in `details` so the terminal-failure unwrap below
      // can recover the last response (preserves prior contract).
      const retryAfterHeader = response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? parseRetryAfterMs(retryAfterHeader) : undefined;
      throw new WeaveIntelError({
        code: response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
        message: `HTTP ${response.status} ${response.statusText}`,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        details: { httpResponse: response },
      });
    }
    return response;
  };
  const retries = config.retryCount ?? 0;
  const delay = config.retryDelayMs ?? 1000;

  // Delegate retry / circuit / signal-bus to the shared resilience pipeline.
  // Endpoint key is `tools-http:<config.name>` so each configured endpoint
  // gets its own process-wide circuit breaker. On terminal failure with an
  // HttpStatusError, we unwrap the response (preserves prior contract that
  // exhausted retries return the last response rather than throwing).
  let response: HttpResponse;
  try {
    response = await runResilient(fn, {
      endpoint: `tools-http:${config.name}`,
      retry: {
        maxAttempts: retries + 1,
        baseDelayMs: delay,
        maxDelayMs: 30_000,
        jitter: true,
      },
    });
  } catch (err) {
    const httpResponse = (err as WeaveIntelError)?.details?.['httpResponse'] as HttpResponse | undefined;
    if (httpResponse) {
      response = httpResponse;
    } else {
      throw err;
    }
  }
  response.body = applyTransform(response.body, config.responseTransform);
  return response;
}
