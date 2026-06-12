/**
 * Transport layer — abstracts SSE and JSON-fetch so they can be swapped
 * in tests or non-browser environments.
 *
 * NOTE: No Node.js imports — this module must stay browser-safe.
 */

import type { RunEventEnvelope } from './run-client.js';

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

export interface EventTransport {
  /**
   * Open an SSE stream to `url`.
   * @param url    Full URL to connect to.
   * @param onEvent  Called with each parsed SSE event.
   * @param signal   AbortSignal to cancel the stream.
   */
  openStream(url: string, onEvent: StreamHandler, signal?: AbortSignal): void;
}

/**
 * Production SSE transport using the browser `fetch` + `ReadableStream`.
 *
 * Auto-reconnects on disconnect, resuming from the last-seen sequence via
 * the `after` query parameter.  The caller drives reconnect logic by
 * calling `openStream` again with an updated URL.
 */
export function sseTransport(opts: {
  auth?: AuthProvider;
  extraHeaders?: Record<string, string>;
}): EventTransport {
  return {
    openStream(url, onEvent, signal) {
      void (async () => {
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
        } catch {
          return; // network error / aborted
        }
        if (!resp.ok || !resp.body) return;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        // Parse SSE line-by-line
        while (!signal?.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          let dataLines: string[] = [];
          let currentEvent: string | undefined;

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            } else if (line === '') {
              if (dataLines.length > 0) {
                const stop = onEvent({
                  data: dataLines.join('\n'),
                  ...(currentEvent !== undefined ? { event: currentEvent } : {}),
                });
                if (stop) { reader.cancel(); return; }
              }
              dataLines = [];
              currentEvent = undefined;
            }
          }
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
    openStream(_, onEvent, signal) {
      for (const ev of events) {
        if (signal?.aborted) break;
        const stop = onEvent(ev);
        if (stop) break;
      }
    },
  };
}

export type { RunEventEnvelope };
