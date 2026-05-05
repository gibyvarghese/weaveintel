/**
 * @weaveintel/provider-openai — Shared HTTP helpers and configuration
 *
 * Reusable fetch utilities for all OpenAI API adapters.
 *
 * Resilience: every outbound request is routed through a process-wide
 * `@weaveintel/resilience` callable keyed by endpoint id. This means a single
 * 429 from OpenAI will pause the token bucket for *every* in-process caller
 * — chats, agents, tools, evals — instead of each one independently retrying.
 */

import { WeaveIntelError, parseRetryAfterMs as coreParseRetryAfterMs } from '@weaveintel/core';
import { createResilientCallable, type ResilientCallable } from '@weaveintel/resilience';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  defaultHeaders?: Record<string, string>;
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export function resolveApiKey(options?: OpenAIProviderOptions): string {
  const key = options?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!key) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: 'OpenAI API key not provided. Set OPENAI_API_KEY or pass apiKey option.',
      provider: 'openai',
    });
  }
  return key;
}

export function makeHeaders(options: OpenAIProviderOptions, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...options.defaultHeaders,
  };
  if (options.organization) {
    headers['OpenAI-Organization'] = options.organization;
  }
  return headers;
}

export function makeMultipartHeaders(options: OpenAIProviderOptions, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...options.defaultHeaders,
  };
  if (options.organization) {
    headers['OpenAI-Organization'] = options.organization;
  }
  return headers;
}

/** @deprecated re-exported from `@weaveintel/core`. Import from there directly. */
export const parseRetryAfterMs = coreParseRetryAfterMs;

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

/**
 * Process-wide resilience grouping for OpenAI HTTP. All in-process callers
 * share one circuit breaker + token bucket here, so a single 429 backs off
 * the whole process instead of each caller hammering independently.
 *
 * Phase 2 uses a single endpoint id; Phase 3 will route per model so different
 * model quotas don't share state.
 */
const DEFAULT_ENDPOINT_ID = 'openai:rest';

const RESILIENCE_DEFAULTS = {
  // 1 auto-retry on transient/429. Heavy lifting comes from the shared token
  // bucket pause (so other in-process callers also back off on 429) and the
  // circuit breaker. Callers wanting more retries should wrap explicitly.
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
  circuit: { failureThreshold: 8, cooldownMs: 30_000 },
} as const;

type RequestArgs = [
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  method: 'POST' | 'GET' | 'DELETE' | 'PATCH',
];
type StreamFetchArgs = [
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
];

const requestCallables = new Map<string, ResilientCallable<RequestArgs, unknown>>();
const streamFetchCallables = new Map<
  string,
  ResilientCallable<StreamFetchArgs, ReadableStreamDefaultReader<Uint8Array>>
>();

function getRequestCallable(endpoint: string): ResilientCallable<RequestArgs, unknown> {
  let c = requestCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<RequestArgs, unknown>(openaiRequestRaw, {
      endpoint,
      retry: RESILIENCE_DEFAULTS.retry,
      circuit: RESILIENCE_DEFAULTS.circuit,
    });
    requestCallables.set(endpoint, c);
  }
  return c;
}

function getStreamFetchCallable(
  endpoint: string,
): ResilientCallable<StreamFetchArgs, ReadableStreamDefaultReader<Uint8Array>> {
  let c = streamFetchCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<StreamFetchArgs, ReadableStreamDefaultReader<Uint8Array>>(
      openaiStreamFetchRaw,
      {
        endpoint,
        retry: RESILIENCE_DEFAULTS.retry,
        circuit: RESILIENCE_DEFAULTS.circuit,
      },
    );
    streamFetchCallables.set(endpoint, c);
  }
  return c;
}

export async function openaiRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  method: 'POST' | 'GET' | 'DELETE' | 'PATCH' = 'POST',
): Promise<unknown> {
  const callable = getRequestCallable(DEFAULT_ENDPOINT_ID);
  return callable(baseUrl, path, body, headers, signal, method);
}

async function openaiRequestRaw(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  method: 'POST' | 'GET' | 'DELETE' | 'PATCH' = 'POST',
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const fetchOpts: RequestInit = {
    method,
    headers,
    signal: composeRequestSignal(signal),
  };
  if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
    fetchOpts.body = JSON.stringify(body);
  }

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(errorBody) as Record<string, unknown>;
    } catch {
      // not JSON
    }

    const errorMessage =
      (parsed['error'] as Record<string, unknown> | undefined)?.['message'] ??
      errorBody ??
      `HTTP ${res.status}`;

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `OpenAI rate limited: ${String(errorMessage)}`,
        provider: 'openai',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `OpenAI auth failed: ${String(errorMessage)}`,
        provider: 'openai',
      });
    }
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `OpenAI error (${res.status}): ${String(errorMessage)}`,
      provider: 'openai',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  // DELETE may return 204 No Content
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

export async function openaiGetRequest(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return openaiRequest(baseUrl, path, undefined, headers, signal, 'GET');
}

export async function openaiDeleteRequest(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return openaiRequest(baseUrl, path, undefined, headers, signal, 'DELETE');
}

export async function* openaiStreamRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  // The initial fetch (which can return 429 / 5xx / auth) is wrapped by the
  // resilience pipeline. Once we have a body, iteration runs outside the
  // pipeline so streaming reads aren't subject to the per-call timeout.
  const callable = getStreamFetchCallable(DEFAULT_ENDPOINT_ID);
  const reader = await callable(baseUrl, path, body, headers, signal);
  yield* iterateOpenAIStream(reader);
}

async function openaiStreamFetchRaw(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(errorBody) as Record<string, unknown>;
    } catch {
      // non-json payload
    }
    const errorMessage =
      (parsed['error'] as Record<string, unknown> | undefined)?.['message'] ??
      errorBody ??
      `HTTP ${res.status}`;

    if (res.status === 429) {
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `OpenAI stream rate limited: ${String(errorMessage)}`,
        provider: 'openai',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `OpenAI stream auth failed: ${String(errorMessage)}`,
        provider: 'openai',
      });
    }

    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `OpenAI stream error (${res.status}): ${String(errorMessage)}`,
      provider: 'openai',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  const reader = res.body?.getReader();
  if (!reader) throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'No response body', provider: 'openai' });
  return reader;
}

async function* iterateOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors on already closed streams.
    }
    reader.releaseLock();
  }
}
