import { WeaveIntelError, parseRetryAfterMs } from '@weaveintel/core';
import {
  createResilientCallable,
  PROVIDER_RESILIENCE_DEFAULTS,
  type ResilientCallable,
} from '@weaveintel/resilience';
import type { GoogleProviderOptions } from './google-types.js';
import { googleFetch, googleFetchStream } from './_fetch.js';

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_ENDPOINT_ID = 'google:rest';

const RESILIENCE_DEFAULTS = PROVIDER_RESILIENCE_DEFAULTS;

type RequestArgs = [
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
];

const requestCallables = new Map<string, ResilientCallable<RequestArgs, unknown>>();
const streamFetchCallables = new Map<
  string,
  ResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>>
>();

export function resolveApiKey(options?: GoogleProviderOptions): string {
  const key =
    options?.apiKey ??
    process.env['GEMINI_API_KEY'] ??
    process.env['GOOGLE_API_KEY'] ??
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (!key) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message:
        'Google API key not provided. Set GEMINI_API_KEY (or GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) or pass apiKey option.',
      provider: 'google',
    });
  }
  return key;
}

export function makeHeaders(options: GoogleProviderOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
  };
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
}

async function googleErrorFromResponse(res: Response): Promise<WeaveIntelError> {
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
    return new WeaveIntelError({
      code: 'RATE_LIMITED',
      message: `Google rate limited: ${String(errorMessage)}`,
      provider: 'google',
      retryable: true,
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: `Google auth failed: ${String(errorMessage)}`,
      provider: 'google',
    });
  }
  return new WeaveIntelError({
    code: 'PROVIDER_ERROR',
    message: `Google error (${res.status}): ${String(errorMessage)}`,
    provider: 'google',
    retryable: res.status >= 500,
    details: parsed,
  });
}

async function googleRequestRaw(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await googleFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });
  if (!res.ok) throw await googleErrorFromResponse(res);
  return res.json();
}

async function googleStreamFetchRaw(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await googleFetchStream(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });
  if (!res.ok) throw await googleErrorFromResponse(res);

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'No response body', provider: 'google' });
  }
  return reader;
}

async function* iterateGoogleStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Gemini SSE uses `data: {json}\n\n` — same shape as OpenAI but no [DONE].
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (!data) continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
}

function getRequestCallable(endpoint: string): ResilientCallable<RequestArgs, unknown> {
  let c = requestCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<RequestArgs, unknown>(googleRequestRaw, {
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
): ResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>> {
  let c = streamFetchCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>>(
      googleStreamFetchRaw,
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

export async function googleRequest(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return getRequestCallable(DEFAULT_ENDPOINT_ID)(url, body, headers, signal);
}

export async function* googleStreamRequest(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  // Initial fetch wrapped by resilience pipeline; iteration runs outside the
  // pipeline so streaming reads aren't bound by the per-call timeout.
  const reader = await getStreamFetchCallable(DEFAULT_ENDPOINT_ID)(url, body, headers, signal);
  yield* iterateGoogleStream(reader);
}
