/**
 * Transport layer — abstracts SSE and JSON-fetch so they can be swapped
 * in tests or non-browser environments.
 *
 * NOTE: No Node.js imports — this module must stay browser-safe.
 *
 * Phase 0: `sseTransport` is now the single, rich SSE reader for the platform.
 * It exposes a lifecycle seam (`onOpen` / `onClose` / `onError`), a stall
 * timeout, and a permanent-vs-transient close signal so `run-client.attach()`
 * can actually reconnect, and so `@weaveintel/api-client` can delegate to it
 * instead of hand-rolling its own reader.
 */
// no-raw-fetch: allow (reason: browser-safe client SDK transport — uses the browser
// fetch + ReadableStream for SSE; exempt like ui-client.ts / ui/api.ts)

import { RUN_STREAM_CONFIG_DEFAULTS, type RunEventEnvelope } from '@weaveintel/core';
import { parseSseStream } from './sse-parser.js';

/** Auth token or header factory, injected by the host app. */
export type AuthProvider =
  | string
  | (() => string)
  | (() => Promise<string>);

async function resolveAuth(auth?: AuthProvider): Promise<string | undefined> {
  if (auth === undefined) return undefined;
  if (typeof auth === 'string') return auth;
  return auth();
}

// ---------------------------------------------------------------------------
// EventTransport — SSE streaming
// ---------------------------------------------------------------------------

/** A single event received over the stream. */
export interface StreamEvent {
  /** Raw `data:` field value. */
  data: string;
  /** Optional `event:` field value. */
  event?: string;
}

/**
 * Called for every incoming SSE event until `cancel()` is called or the
 * stream closes. Return `true` to signal the caller should stop.
 */
export type StreamHandler = (event: StreamEvent) => boolean | void;

/** Information about why a stream closed. */
export interface StreamCloseInfo {
  /**
   * `true` when the open failed with a permanent client error (4xx) — the
   * caller MUST NOT reconnect. `false` for graceful end / network drop / stall,
   * where the caller MAY reconnect.
   */
  permanent: boolean;
}

/** Lifecycle callbacks for a single `openStream` call. */
export interface StreamLifecycle {
  /** Per parsed SSE event. Return `true` to stop reading. */
  onEvent: StreamHandler;
  /** Fired once when the response is open and readable. */
  onOpen?: () => void;
  /** Fired exactly once when the stream ends (any reason). */
  onClose?: (info: StreamCloseInfo) => void;
  /** Fired when opening or reading throws (before `onClose`). */
  onError?: (err: Error) => void;
}

export interface EventTransport {
  /**
   * Open an SSE stream to `url`.
   * @param url    Full URL to connect to.
   * @param life   Lifecycle callbacks (`onEvent` required).
   * @param signal AbortSignal to cancel the stream.
   */
  openStream(url: string, life: StreamLifecycle, signal?: AbortSignal): void;
}

export interface SseTransportOptions {
  auth?: AuthProvider;
  extraHeaders?: Record<string, string>;
  /**
   * Tear down a stream that delivers no bytes within this window (ms) so the
   * caller can reconnect rather than hang forever. 0 disables the timeout.
   * Defaults to the platform stall timeout.
   */
  stallTimeoutMs?: number;
}

/**
 * Production SSE transport using the browser `fetch` + `ReadableStream`.
 *
 * Single read pass; reconnection is the caller's responsibility (driven by the
 * `onClose` signal). On a 4xx open failure `onClose` reports `permanent: true`
 * so the caller stops retrying; on network drop / stall / graceful end it
 * reports `permanent: false`.
 */
export function sseTransport(opts: SseTransportOptions): EventTransport {
  const stallTimeoutMs = opts.stallTimeoutMs ?? RUN_STREAM_CONFIG_DEFAULTS.stallTimeoutMs;

  return {
    openStream(url, life, signal) {
      void (async () => {
        let closed = false;
        const close = (permanent: boolean) => {
          if (closed) return;
          closed = true;
          life.onClose?.({ permanent });
        };

        const token = await resolveAuth(opts.auth);
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...opts.extraHeaders,
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let resp: Response;
        try {
          resp = await fetch(url, { headers, signal });
        } catch (err) {
          if (!signal?.aborted) life.onError?.(err instanceof Error ? err : new Error(String(err)));
          close(false); // network error / aborted ⇒ transient
          return;
        }

        if (!resp.ok || !resp.body) {
          life.onError?.(new Error(`stream open failed → ${resp.status}`));
          // 4xx ⇒ permanent (endpoint gone / forbidden): do not reconnect.
          // 5xx / no-body ⇒ transient: caller may reconnect.
          close(resp.status >= 400 && resp.status < 500);
          return;
        }

        life.onOpen?.();

        // Single SSE byte→event decoder (shared with the reference UI app). The
        // generator owns the reader + buffering + stall timeout; we apply the
        // run-transport policy (early-stop on `onEvent` → true) by breaking the
        // loop, which cancels the reader via the generator's `return` path.
        try {
          for await (const ev of parseSseStream(resp.body, { signal, stallTimeoutMs })) {
            const stop = life.onEvent(ev);
            if (stop === true) break;
          }
        } catch (err) {
          if (!signal?.aborted) life.onError?.(err instanceof Error ? err : new Error(String(err)));
        } finally {
          close(false); // graceful end / drop / stall / early-stop ⇒ transient
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// fetchJsonTransport — request/response helpers
// ---------------------------------------------------------------------------

export interface FetchJsonTransport {
  /**
   * `GET` a JSON resource; returns `null` on 404.
   */
  get<T>(path: string, signal?: AbortSignal): Promise<T | null>;
  /**
   * `POST` a JSON body; returns the parsed response body.
   */
  post<T>(path: string, body: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<T>;
  /**
   * `DELETE` a resource; returns the parsed response body.
   */
  del<T>(path: string, signal?: AbortSignal): Promise<T>;
}

export function fetchJsonTransport(opts: {
  baseUrl: string;
  auth?: AuthProvider;
  extraHeaders?: Record<string, string>;
}): FetchJsonTransport {
  async function buildHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await resolveAuth(opts.auth);
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...opts.extraHeaders, ...extra };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  function fullUrl(path: string): string {
    return opts.baseUrl.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }

  return {
    async get<T>(path: string, signal?: AbortSignal): Promise<T | null> {
      const resp = await fetch(fullUrl(path), { headers: await buildHeaders(), signal });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`GET ${path} → ${resp.status}`);
      return resp.json() as Promise<T>;
    },

    async post<T>(path: string, body: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<T> {
      const extra: Record<string, string> = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
      const resp = await fetch(fullUrl(path), {
        method: 'POST',
        headers: await buildHeaders(extra),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw new Error(`POST ${path} → ${resp.status}`);
      return resp.json() as Promise<T>;
    },

    async del<T>(path: string, signal?: AbortSignal): Promise<T> {
      const resp = await fetch(fullUrl(path), { method: 'DELETE', headers: await buildHeaders(), signal });
      if (!resp.ok) throw new Error(`DELETE ${path} → ${resp.status}`);
      return resp.json() as Promise<T>;
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only: in-memory transport that replays pre-canned events
// ---------------------------------------------------------------------------

export function mockSseTransport(events: StreamEvent[]): EventTransport {
  return {
    openStream(_, life, signal) {
      life.onOpen?.();
      for (const ev of events) {
        if (signal?.aborted) break;
        const stop = life.onEvent(ev);
        if (stop === true) break;
      }
      life.onClose?.({ permanent: false });
    },
  };
}

export type { RunEventEnvelope };
