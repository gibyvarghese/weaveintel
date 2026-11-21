// SPDX-License-Identifier: MIT
/**
 * Small helpers every adapter shares: reading a failed HTTP response into one
 * error shape, parsing JSON bodies, and reading a server-sent-event stream.
 *
 * In plain terms: providers disagree about how they say "wrong key" or "slow
 * down". This file turns each of those into the same few error codes, so the
 * caller (and the router's fallback) can react the same way to every provider.
 */

import { WeaveIntelError, type ErrorCode } from '@weaveintel/core';
import type { WireErrorOverride } from './types.js';

const MAX_RETRY_AFTER_MS = 120_000;

/** How long the provider asked us to wait, in milliseconds, if it said. */
export function retryAfterFrom(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms !== '' && Number.isFinite(Number(ms))) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(Number(ms))));
  }
  const s = headers.get('retry-after');
  if (s === null || s === '') return undefined;
  if (Number.isFinite(Number(s))) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(Number(s) * 1000)));
  const at = Date.parse(s);
  if (!Number.isNaN(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  return undefined;
}

/** Best-effort: pull the human-readable reason out of a provider's error body. */
export function providerMessage(bodyText: string): string {
  const text = bodyText.trim();
  if (text === '') return '';
  try {
    const body = JSON.parse(text) as unknown;
    const first = Array.isArray(body) ? (body[0] as unknown) : body;
    if (first && typeof first === 'object') {
      const o = first as Record<string, unknown>;
      const e = o['error'];
      if (e && typeof e === 'object') {
        const m = (e as Record<string, unknown>)['message'];
        if (typeof m === 'string' && m !== '') return m;
      }
      if (typeof e === 'string' && e !== '') return e;
      for (const k of ['message', 'Message', 'detail', 'error_description']) {
        const v = o[k];
        if (typeof v === 'string' && v !== '') return v;
      }
    }
  } catch {
    /* not JSON: fall through to the raw text */
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function codeForStatus(status: number): { code: ErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH_FAILED', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 408 || status === 504) return { code: 'TIMEOUT', retryable: true };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'PROVIDER_ERROR', retryable: true };
  if (status === 400 || status === 422 || status === 413) return { code: 'INVALID_INPUT', retryable: false };
  return { code: 'PROVIDER_ERROR', retryable: false };
}

/** Turn a failed HTTP response into the library's one error shape. */
export function httpFailure(
  provider: string,
  status: number,
  headers: Headers,
  bodyText: string,
  override?: WireErrorOverride,
): WeaveIntelError {
  const base = codeForStatus(status);
  const code: ErrorCode = override?.code ?? base.code;
  const retryable = override?.retryable ?? (override?.code ? code === 'RATE_LIMITED' || code === 'TIMEOUT' : base.retryable);
  const reason = override?.message ?? providerMessage(bodyText);
  const retryAfterMs = code === 'RATE_LIMITED' ? retryAfterFrom(headers) : undefined;
  return new WeaveIntelError({
    code,
    message: `${provider} answered ${status}${reason ? `: ${reason}` : ''}`,
    provider,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    details: { status },
  });
}

/** Parse a body the provider said was JSON. A body that is not is a protocol error. */
export function parseJsonBody<T = Record<string, unknown>>(provider: string, text: string): T {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object') throw new Error('not an object');
    return value as T;
  } catch {
    throw new WeaveIntelError({
      code: 'PROTOCOL_ERROR',
      message: `${provider} sent a reply that could not be read (it was not the expected JSON).`,
      provider,
      retryable: false,
    });
  }
}

/** A reply that parsed but lacks what the wire format promises. */
export function malformed(provider: string, what: string): WeaveIntelError {
  return new WeaveIntelError({
    code: 'PROTOCOL_ERROR',
    message: `${provider} sent a reply that could not be read (${what}).`,
    provider,
    retryable: false,
  });
}

/**
 * Read a server-sent-event body and yield each event's `data:` payload.
 * Stops at `[DONE]`. Multi-line data fields are joined with a newline, as the
 * SSE specification says.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += '\n\n';
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          if (data.length > 0) {
            const payload = data.join('\n');
            data = [];
            if (payload === '[DONE]') return;
            yield payload;
          }
          continue;
        }
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
