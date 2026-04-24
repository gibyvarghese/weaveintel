/**
 * HTTP client with auth, retry, rate limiting, and response transforms
 */
import { readResponseTextLimited, validateOutboundUrl } from '@weaveintel/tools';
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

class HttpStatusError extends Error {
  constructor(public readonly response: HttpResponse) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = 'HttpStatusError';
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return true;
  if (err instanceof Error && /rate limit exceeded/i.test(err.message)) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return err instanceof TypeError;
}

function computeRetryDelayMs(baseDelayMs: number, attemptIndex: number): number {
  const exponential = baseDelayMs * (2 ** attemptIndex);
  const jitterFactor = 0.7 + Math.random() * 0.6;
  return Math.min(30_000, Math.round(exponential * jitterFactor));
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || i >= retries) {
        if (err instanceof HttpStatusError) return err.response as T;
        throw err;
      }
      const backoffMs = computeRetryDelayMs(delayMs, i);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
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
      throw new HttpStatusError(response);
    }
    return response;
  };
  const retries = config.retryCount ?? 0;
  const delay = config.retryDelayMs ?? 1000;

  const response = await withRetry(fn, retries, delay);
  response.body = applyTransform(response.body, config.responseTransform);
  return response;
}
