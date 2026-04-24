/**
 * @weaveintel/provider-openai — Shared HTTP helpers and configuration
 *
 * Reusable fetch utilities for all OpenAI API adapters.
 */

import { WeaveIntelError } from '@weaveintel/core';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  defaultHeaders?: Record<string, string>;
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30_000;

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

export function parseRetryAfterMs(retryAfterHeader: string | null | undefined, fallbackMs = 60_000): number {
  if (!retryAfterHeader) return fallbackMs;
  const asNumber = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asNumber * 1000));
  }
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asDate - Date.now()));
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, fallbackMs));
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

export async function openaiRequest(
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
