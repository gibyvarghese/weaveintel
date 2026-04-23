/**
 * @weaveintel/provider-anthropic — Shared HTTP helpers and configuration
 *
 * Reusable fetch utilities for all Anthropic API adapters.
 * Uses x-api-key header (not Bearer) and requires anthropic-version header.
 */

import { WeaveIntelError } from '@weaveintel/core';

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

export function parseRetryAfterMs(retryAfterHeader: string | null | undefined, fallbackMs = 60_000): number {
  if (!retryAfterHeader) return fallbackMs;
  const asNumber = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
    return Math.max(0, asNumber * 1000);
  }
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return fallbackMs;
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
  const url = `${baseUrl}${path}`;
  const fetchOpts: RequestInit = {
    method,
    headers,
    signal,
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
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
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
    reader.releaseLock();
  }
}
