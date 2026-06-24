/**
 * http.ts — the transport seam for @geneweave/api-client.
 *
 * {@link GeneweaveTransport} is a small, injectable interface: a `request`
 * method that returns the raw `{ status, body }` (so typed methods can branch
 * on 401 / 403 / 409 rather than having status codes swallowed), and an
 * `openStream` method for resumable SSE. Tests inject a fake transport; the
 * mobile app (M3) may inject an `EventSource`/`react-native-sse` stream while
 * reusing the default request path.
 *
 * {@link createHttpTransport} is the default implementation. It is built on the
 * global `fetch` (this is a browser/React-Native client SDK, exactly like
 * `@weaveintel/client`'s transport) and layers in:
 *   - `Authorization: Bearer` + `X-CSRF-Token` injected from the `TokenStore`;
 *   - a single transparent refresh-and-retry on `401` (via the host-supplied
 *     `refresh` strategy, e.g. re-minting through `POST /api/auth/token`);
 *   - structured `{ status, body }` results, never throwing on non-2xx.
 *
 * No React / React Native imports. The underlying `fetch` is injectable so the
 * package stays testable without a network.
 */

import { sseTransport } from '@weaveintel/client';
import type { TokenStore, AuthTokens } from './token-store.js';

/** A non-streaming HTTP response with parsed body and original status. */
export interface RawResponse {
  status: number;
  body: unknown;
  headers?: Headers;
}

/** Callbacks for a server-sent-event stream. */
export interface StreamHandlers {
  /** Called once per `data:` line, with the parsed JSON value. */
  onEvent: (value: unknown) => void;
  /** Called when the stream ends (graceful close or network drop). */
  onClose?: () => void;
  /** Called if opening or reading the stream throws. */
  onError?: (err: Error) => void;
}

/** Request descriptor for {@link GeneweaveTransport.request}. */
export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** When true, attach the `X-CSRF-Token` header (required on mutations). */
  csrf?: boolean;
  signal?: AbortSignal;
}

/** The injectable transport seam. */
export interface GeneweaveTransport {
  request(req: TransportRequest): Promise<RawResponse>;
  openStream(input: { path: string; signal?: AbortSignal }, handlers: StreamHandlers): void;
}

export interface CreateHttpTransportOptions {
  /** Base origin, e.g. `https://api.example.com`. */
  host: string;
  tokenStore: TokenStore;
  /**
   * Re-mints a session when a request gets a 401. Called at most once per
   * request; the returned tokens are persisted to the `TokenStore` and the
   * request is retried once. Return `null` (or throw) to give up — the caller
   * then surfaces an `AuthExpiredError`.
   */
  refresh?: () => Promise<AuthTokens | null>;
  /** Injectable fetch (defaults to the global). Keeps the package testable. */
  fetchImpl?: typeof fetch;
  /** Extra headers added to every request (e.g. a client version tag). */
  extraHeaders?: Record<string, string>;
}

function joinUrl(host: string, path: string): string {
  return host.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

async function parseBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHttpTransport(opts: CreateHttpTransportOptions): GeneweaveTransport {
  const doFetch: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createHttpTransport: no fetch implementation available — pass opts.fetchImpl');
  }

  async function buildHeaders(req: TransportRequest, tokens: AuthTokens | null): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...opts.extraHeaders };
    if (req.body !== undefined) h['Content-Type'] = 'application/json';
    if (tokens?.token) h['Authorization'] = `Bearer ${tokens.token}`;
    if (req.csrf && tokens?.csrfToken) h['X-CSRF-Token'] = tokens.csrfToken;
    if (req.idempotencyKey) h['Idempotency-Key'] = req.idempotencyKey;
    return h;
  }

  async function once(req: TransportRequest, tokens: AuthTokens | null): Promise<RawResponse> {
    const headers = await buildHeaders(req, tokens);
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    if (req.signal) init.signal = req.signal;
    const resp = await doFetch(joinUrl(opts.host, req.path), init);
    return { status: resp.status, body: await parseBody(resp), headers: resp.headers };
  }

  return {
    async request(req: TransportRequest): Promise<RawResponse> {
      const tokens = await opts.tokenStore.get();
      const first = await once(req, tokens);
      if (first.status !== 401 || !opts.refresh) return first;

      // Single transparent refresh-and-retry on 401.
      let refreshed: AuthTokens | null = null;
      try {
        refreshed = await opts.refresh();
      } catch {
        refreshed = null;
      }
      if (!refreshed) return first; // caller turns this into AuthExpiredError
      await opts.tokenStore.set(refreshed);
      return once(req, refreshed);
    },

    openStream(input, handlers): void {
      // Phase 0: delegate the SSE reader to `@weaveintel/client`'s `sseTransport`
      // — the single, hardened reader for the platform (lifecycle seam, stall
      // timeout, permanent-vs-transient classification). This package no longer
      // ships its own SSE parser; it only adds bearer auth + JSON/keepalive
      // shaping on top. The prior M-13 (no onClose on permanent 4xx) and M-14
      // (60s stall) behaviours are preserved by the base transport.
      const base = sseTransport({
        auth: async () => (await opts.tokenStore.get())?.token ?? '',
        ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
      });
      base.openStream(
        joinUrl(opts.host, input.path),
        {
          onEvent: (ev) => {
            if (ev.data === '' || ev.data.startsWith(':')) return; // keepalive comment
            try {
              handlers.onEvent(JSON.parse(ev.data));
            } catch {
              // Malformed event — skip, keep the stream open.
            }
          },
          ...(handlers.onError ? { onError: handlers.onError } : {}),
          onClose: ({ permanent }) => {
            // M-13: do NOT signal close on a permanent (4xx) open failure so the
            // caller does not reconnect into a dead endpoint.
            if (!permanent) handlers.onClose?.();
          },
        },
        input.signal,
      );
    },
  };
}
