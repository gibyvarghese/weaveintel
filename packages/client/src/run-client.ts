/**
 * @weaveintel/client — RunClient
 *
 * High-level client for interacting with the weaveIntel Run API.
 *
 * Browser-safe (no Node.js APIs).
 *
 * Responsibilities:
 *  - Start / cancel / list runs
 *  - Attach to a live run event stream (SSE), resuming from last-seen sequence
 *  - Post events into a running run
 *  - Auto-reconnect with bounded exponential backoff
 */

import type { EventTransport, FetchJsonTransport, AuthProvider } from './transport.js';
import { sseTransport, fetchJsonTransport } from './transport.js';
import type { RunEventEnvelope } from './reducer.js';
import { RUN_STREAM_CONFIG_DEFAULTS, reconnectBackoffMs, isTerminalRunEventKind } from '@weaveintel/core';

export type { RunEventEnvelope };
export type { AuthProvider };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  status: RunStatus;
  principalId?: string;
  tenantId?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface StartRunInput {
  /** Idempotency key — callers should generate one per logical operation. */
  idempotencyKey: string;
  /** Surface hint (e.g. 'web', 'mobile', 'copilot'). */
  surface?: string;
  /** Arbitrary startup payload. */
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ListRunsFilter {
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export interface AttachOptions {
  /** Resume from this sequence (exclusive). Defaults to -1 (from beginning). */
  afterSequence?: number;
  /** Called for each parsed event envelope. */
  onEvent: (envelope: RunEventEnvelope) => void;
  /** Called if the stream closes with an error. */
  onError?: (err: Error) => void;
  /** Called when the stream ends (run is terminal). */
  onComplete?: () => void;
  /** AbortSignal to detach. */
  signal?: AbortSignal;
  /**
   * Max reconnect attempts before giving up. Defaults to the client's
   * configured value (server `run_stream_config.max_reconnects`, else 8).
   * Set to 0 to disable auto-reconnect.
   */
  maxReconnects?: number;
  /**
   * Reconnect backoff schedule (ms), indexed by attempt. Defaults to the
   * client's configured value (server `run_stream_config.backoff_ms`).
   */
  backoffMs?: number[];
}

// ---------------------------------------------------------------------------
// RunClient
// ---------------------------------------------------------------------------

export interface RunClient {
  startRun(input: StartRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(filter?: ListRunsFilter): Promise<RunRecord[]>;
  cancelRun(id: string): Promise<void>;
  /**
   * Attach to the SSE event stream for `runId`, starting from
   * `opts.afterSequence` (defaults to -1 = from beginning).
   * Auto-reconnects on disconnect with exponential backoff.
   * Call `abort()` on the returned controller to detach.
   */
  attach(runId: string, opts: AttachOptions): AbortController;
  /**
   * Post a client-originated event into a running run.
   */
  postEvent(runId: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CreateRunClientOptions {
  /**
   * Base URL of the weaveIntel API (e.g. `https://app.example.com`).
   * The client appends `/api/me/runs` paths automatically.
   */
  baseUrl: string;
  auth?: AuthProvider;
  /**
   * Inject a custom SSE transport (useful in tests or non-browser environments).
   * Defaults to `sseTransport({ auth })`.
   */
  sse?: EventTransport;
  /**
   * Inject a custom JSON transport (useful in tests).
   * Defaults to `fetchJsonTransport({ baseUrl, auth })`.
   */
  json?: FetchJsonTransport;
  /**
   * Extra HTTP headers added to every request.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Reconnect / stream tuning. Defaults to `RUN_STREAM_CONFIG_DEFAULTS`. Hosts
   * should fetch the server's `GET /api/me/runs/config` (sourced from the
   * `run_stream_config` DB row) and pass it here so DB changes drive client
   * behaviour without a code change.
   */
  reconnect?: {
    maxReconnects?: number;
    backoffMs?: number[];
    stallTimeoutMs?: number;
  };
}

export function createRunClient(opts: CreateRunClientOptions): RunClient {
  const reconnectCfg = {
    maxReconnects: opts.reconnect?.maxReconnects ?? RUN_STREAM_CONFIG_DEFAULTS.maxReconnects,
    backoffMs: opts.reconnect?.backoffMs ?? RUN_STREAM_CONFIG_DEFAULTS.backoffMs,
    stallTimeoutMs: opts.reconnect?.stallTimeoutMs ?? RUN_STREAM_CONFIG_DEFAULTS.stallTimeoutMs,
  };
  const json = opts.json ?? fetchJsonTransport({
    baseUrl: opts.baseUrl,
    auth: opts.auth,
    extraHeaders: opts.extraHeaders,
  });
  const sse = opts.sse ?? sseTransport({
    auth: opts.auth,
    extraHeaders: opts.extraHeaders,
    stallTimeoutMs: reconnectCfg.stallTimeoutMs,
  });

  return {
    async startRun(input) {
      return json.post<RunRecord>('/api/me/runs', input, input.idempotencyKey);
    },

    async getRun(id) {
      return json.get<RunRecord>(`/api/me/runs/${id}`);
    },

    async listRuns(filter = {}) {
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      if (filter.offset !== undefined) params.set('offset', String(filter.offset));
      const qs = params.toString();
      const path = qs ? `/api/me/runs?${qs}` : '/api/me/runs';
      return (await json.get<RunRecord[]>(path)) ?? [];
    },

    async cancelRun(id) {
      await json.post<unknown>(`/api/me/runs/${id}/cancel`, {});
    },

    attach(runId, attachOpts) {
      const controller = new AbortController();
      const { signal, onEvent, onError, onComplete } = attachOpts;
      const maxReconnects = attachOpts.maxReconnects ?? reconnectCfg.maxReconnects;
      const backoff = attachOpts.backoffMs ?? reconnectCfg.backoffMs;

      // Cascade external signal into our controller.
      signal?.addEventListener('abort', () => controller.abort());

      let lastSeq = attachOpts.afterSequence ?? -1;
      let reconnectCount = 0;
      let terminal = false;

      const connect = () => {
        if (controller.signal.aborted || terminal) return;
        const url = `${opts.baseUrl.replace(/\/$/, '')}/api/me/runs/${runId}/events?after=${lastSeq}`;

        // Real reconnect (Phase 0): the transport's `onClose` drives the retry
        // decision. We resume from `lastSeq` and dedup across reconnects so the
        // replay→live handoff never double-delivers an event.
        sse.openStream(
          url,
          {
            onEvent: (rawEvent) => {
              if (controller.signal.aborted) return true; // stop
              try {
                const envelope = JSON.parse(rawEvent.data) as RunEventEnvelope;
                if (envelope.sequence <= lastSeq) return false; // dedup (resume overlap)
                lastSeq = envelope.sequence;
                reconnectCount = 0; // forward progress resets the backoff budget
                onEvent(envelope);
                if (isTerminalRunEventKind(envelope.kind)) {
                  terminal = true;
                  onComplete?.();
                  controller.abort();
                  return true; // stop
                }
              } catch {
                // Malformed event — ignore, keep the stream open.
              }
              return false;
            },
            onClose: ({ permanent }) => {
              if (controller.signal.aborted || terminal) return; // intentional end
              if (permanent) {
                onError?.(new Error('Run stream closed permanently (non-retryable)'));
                return;
              }
              if (maxReconnects <= 0) {
                onError?.(new Error('Run stream disconnected (auto-reconnect disabled)'));
                return;
              }
              if (reconnectCount >= maxReconnects) {
                onError?.(new Error(`Run stream disconnected after ${maxReconnects} reconnects`));
                return;
              }
              const delay = reconnectBackoffMs(reconnectCount, backoff);
              reconnectCount++;
              if (typeof setTimeout !== 'undefined') setTimeout(connect, delay);
              else connect();
            },
          },
          controller.signal,
        );
      };

      connect();
      return controller;
    },

    async postEvent(runId, payload) {
      await json.post<unknown>(`/api/me/runs/${runId}/events`, payload);
    },
  };
}
