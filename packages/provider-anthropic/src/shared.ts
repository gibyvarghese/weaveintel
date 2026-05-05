/**
 * @weaveintel/provider-anthropic — Shared HTTP helpers and configuration
 *
 * Reusable fetch utilities for all Anthropic API adapters.
 * Uses x-api-key header (not Bearer) and requires anthropic-version header.
 *
 * Resilience: every outbound request flows through a process-wide
 * `@weaveintel/resilience` callable keyed by endpoint id, so one upstream 429
 * pauses the shared token bucket for every in-process caller.
 */

import { WeaveIntelError, parseRetryAfterMs as coreParseRetryAfterMs } from '@weaveintel/core';
import { createResilientCallable, type ResilientCallable } from '@weaveintel/resilience';

// ─── Provider options ────────────────────────────────────────

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  apiVersion?: string;
  betaFeatures?: string[];
  defaultHeaders?: Record<string, string>;
}

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// ─── Auth & headers ──────────────────────────────────────────

export function resolveApiKey(options?: AnthropicProviderOptions): string {
  const key = options?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!key) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: 'Anthropic API key not provided. Set ANTHROPIC_API_KEY or pass apiKey option.',
      provider: 'anthropic',
    });
  }
  return key;
}

export function makeHeaders(
  options: AnthropicProviderOptions,
  apiKey: string,
  extraBeta?: string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': options.apiVersion ?? DEFAULT_API_VERSION,
    ...options.defaultHeaders,
  };
  const allBeta = [...(options.betaFeatures ?? []), ...(extraBeta ?? [])];
  if (allBeta.length > 0) {
    headers['anthropic-beta'] = allBeta.join(',');
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

// ─── Resilience pipeline (process-wide, endpoint-scoped) ────

const DEFAULT_ENDPOINT_ID = 'anthropic:rest';

const RESILIENCE_DEFAULTS = {
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
  circuit: { failureThreshold: 8, cooldownMs: 30_000 },
} as const;

type RequestArgs = [
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  method: 'POST' | 'GET' | 'DELETE',
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
    c = createResilientCallable<RequestArgs, unknown>(anthropicRequestRaw, {
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
      anthropicStreamFetchRaw,
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

// ─── HTTP helpers ────────────────────────────────────────────

export async function anthropicRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  method: 'POST' | 'GET' | 'DELETE' = 'POST',
): Promise<unknown> {
  const callable = getRequestCallable(DEFAULT_ENDPOINT_ID);
  return callable(baseUrl, path, body, headers, signal, method);
}

async function anthropicRequestRaw(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  method: 'POST' | 'GET' | 'DELETE' = 'POST',
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

    const errorObj = parsed['error'] as Record<string, unknown> | undefined;
    const errorMessage = errorObj?.['message'] ?? errorBody ?? `HTTP ${res.status}`;

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `Anthropic rate limited: ${String(errorMessage)}`,
        provider: 'anthropic',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `Anthropic auth failed: ${String(errorMessage)}`,
        provider: 'anthropic',
      });
    }
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `Anthropic error (${res.status}): ${String(errorMessage)}`,
      provider: 'anthropic',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

export async function anthropicGetRequest(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return anthropicRequest(baseUrl, path, undefined, headers, signal, 'GET');
}

export async function anthropicDeleteRequest(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return anthropicRequest(baseUrl, path, undefined, headers, signal, 'DELETE');
}

// ─── SSE stream (Anthropic format) ──────────────────────────

export interface AnthropicSSEEvent {
  event: string;
  data: unknown;
}

/**
 * Streams SSE events from Anthropic's Messages API.
 * Anthropic uses `event:` + `data:` lines. No `data: [DONE]` terminator;
 * the stream ends with `message_stop` event.
 */
export async function* anthropicStreamRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<AnthropicSSEEvent> {
  // Initial fetch (with possible 429/5xx) is wrapped by resilience pipeline.
  // Streaming iteration runs outside the pipeline so it isn't bound by the
  // per-call timeout.
  const callable = getStreamFetchCallable(DEFAULT_ENDPOINT_ID);
  const reader = await callable(baseUrl, path, body, headers, signal);
  yield* iterateAnthropicStream(reader);
}

async function anthropicStreamFetchRaw(
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
    const errorObj = parsed['error'] as Record<string, unknown> | undefined;
    const errorMessage = errorObj?.['message'] ?? errorBody ?? `HTTP ${res.status}`;

    if (res.status === 429) {
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `Anthropic stream rate limited: ${String(errorMessage)}`,
        provider: 'anthropic',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `Anthropic stream auth failed: ${String(errorMessage)}`,
        provider: 'anthropic',
      });
    }

    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `Anthropic stream error (${res.status}): ${String(errorMessage)}`,
      provider: 'anthropic',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: 'No response body',
      provider: 'anthropic',
    });
  }
  return reader;
}

async function* iterateAnthropicStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<AnthropicSSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let dataLines: string[] = [];

  const flushEvent = (): AnthropicSSEEvent | undefined => {
    if (dataLines.length === 0) {
      currentEvent = '';
      return undefined;
    }
    const dataStr = dataLines.join('\n');
    dataLines = [];
    try {
      const data = JSON.parse(dataStr) as Record<string, unknown>;
      const event = currentEvent || String(data['type'] ?? '');
      currentEvent = '';
      return { event, data };
    } catch {
      currentEvent = '';
      return undefined;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          const evt = flushEvent();
          if (evt) {
            yield evt;
          }
          continue;
        }

        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trimStart();
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    const trailing = flushEvent();
    if (trailing) {
      yield trailing;
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
