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
  /**
   * Collaboration Phase 1 — send a presence heartbeat for a run ("I'm watching").
   * Identity is server-derived from auth; `displayName` is a cosmetic label.
   * Pass `{ leave: true }` to leave. Returns the current participant snapshot.
   */
  setPresence(runId: string, body: { presence?: string; displayName?: string; cursor?: Record<string, unknown>; leave?: boolean }): Promise<{ participants: unknown[] }>;
  /**
   * Collaboration Phase 2 — share a run (owner only). Mints an invite token
   * (default role `viewer`) and returns it ONCE plus the share URL.
   */
  shareRun(runId: string, body?: { role?: 'viewer' | 'collaborator'; expiresInMs?: number; maxUses?: number }): Promise<{ sessionId: string; token: string; tokenId: string; role: string; url: string; expiresAt: number | null }>;
  /** Collaboration Phase 2 — join a shared run via an invite token. */
  joinSession(token: string): Promise<{ runId: string; sessionId: string; role: string }>;
  /**
   * Collaboration Phase 2 / CVE-2026-53843 — remove a member from a shared run
   * (owner only). The server immediately force-closes the removed member's live
   * stream(s). Returns how many streams were closed.
   */
  removeMember(runId: string, userId: string): Promise<{ removed: boolean; streamsClosed: number }>;
  /** Collaboration Phase 2 — end sharing entirely (owner only); closes all guest streams. */
  endShare(runId: string): Promise<{ ended: boolean; streamsClosed: number }>;
  /**
   * Collaboration Phase 3 — durably subscribe to a run ("notify me when it
   * finishes, even if I close the tab"). `inapp` is always included. Idempotent.
   */
  subscribeRun(runId: string, channels?: Array<'inapp' | 'email' | 'push' | 'webhook'>): Promise<{ subscribed: boolean; runId: string; channels: string[] }>;
  /** Collaboration Phase 3 — cancel a run subscription (idempotent). */
  unsubscribeRun(runId: string): Promise<{ subscribed: boolean }>;
  /** Collaboration Phase 3 — am I subscribed to this run? (drives the bell toggle). */
  getSubscription(runId: string): Promise<{ subscribed: boolean; channels: string[] }>;
  /** Collaboration Phase 3 — the in-app notification feed + unread badge count. */
  listNotifications(opts?: { unreadOnly?: boolean; limit?: number }): Promise<{ items: unknown[]; unreadCount: number }>;
  /** Collaboration Phase 3 — mark every in-app notification read. */
  markAllNotificationsRead(): Promise<{ read: number }>;
  /**
   * Collaboration Phase 4 — add a review comment, anchored to a run part
   * (`anchor.partId`, e.g. `tool-3`; '' = run-level). Optional `parentId` makes
   * it a reply; `mentions` are user ids (validated + notified server-side).
   */
  addComment(runId: string, input: { body: string; anchor: { partId: string; createdAtSeq: number; subRange?: unknown }; parentId?: string; mentions?: string[] }): Promise<{ comment: unknown }>;
  /** Collaboration Phase 4 — list all comments on a run (with viewer capabilities). */
  listComments(runId: string): Promise<{ comments: unknown[]; role: string }>;
  /** Collaboration Phase 4 — edit a comment (author only). */
  editComment(runId: string, commentId: string, body: string, mentions?: string[]): Promise<{ comment: unknown }>;
  /** Collaboration Phase 4 — soft-delete a comment (author; owner moderates). */
  deleteComment(runId: string, commentId: string): Promise<{ deleted: boolean }>;
  /** Collaboration Phase 4 — resolve a comment thread. */
  resolveThread(runId: string, threadId: string): Promise<{ resolved: boolean }>;
  /** Collaboration Phase 4 — reopen a resolved thread. */
  reopenThread(runId: string, threadId: string): Promise<{ reopened: boolean }>;
  /** Collaboration Phase 4 — add a structured score / annotation to a run or part. */
  addAnnotation(runId: string, input: { name: string; dataType?: 'numeric' | 'categorical' | 'boolean' | 'text'; value?: number; stringValue?: string; comment?: string; partId?: string; source?: string }): Promise<{ annotation: unknown }>;
  /** Collaboration Phase 4 — list annotations + a per-name summary. */
  listAnnotations(runId: string): Promise<{ annotations: unknown[]; summary: unknown[] }>;
  /** Collaboration Phase 4 — mint a public, read-only share link (owner only). */
  createRunPublicShare(runId: string, opts?: { expiresInMs?: number }): Promise<{ id: string; token: string; url: string; expiresAt: number | null }>;
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
      // The server returns `{ runs: [...] }`; tolerate a bare array too.
      const body = await json.get<RunRecord[] | { runs?: RunRecord[] }>(path);
      if (Array.isArray(body)) return body;
      if (body && Array.isArray(body.runs)) return body.runs;
      return [];
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
                // Ephemeral events (Collaboration Phase 1 presence) carry
                // `sequence: -1` — they are NOT journaled and must bypass the
                // resume-overlap dedup (which would always drop a negative
                // sequence). Deliver them without advancing the resume cursor.
                if (envelope.sequence < 0) {
                  reconnectCount = 0;
                  onEvent(envelope);
                  // CVE-2026-53843 — the server force-closed us because access
                  // was revoked. Treat like a terminal stop: do NOT reconnect
                  // (every retry would just 404), and surface completion so the
                  // consumer can show "no longer have access".
                  if (envelope.kind === 'access.revoked') {
                    terminal = true;
                    onComplete?.();
                    controller.abort();
                    return true; // stop
                  }
                  return false;
                }
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

    async setPresence(runId, body) {
      return json.post<{ participants: unknown[] }>(`/api/me/runs/${runId}/presence`, body);
    },

    async shareRun(runId, body = {}) {
      return json.post(`/api/me/runs/${runId}/share`, body);
    },

    async joinSession(token) {
      return json.post('/api/me/sessions/join', { token });
    },

    async removeMember(runId, userId) {
      return json.post(`/api/me/runs/${runId}/members/remove`, { userId });
    },

    async endShare(runId) {
      return json.post(`/api/me/runs/${runId}/share/end`, {});
    },

    async subscribeRun(runId, channels) {
      return json.post(`/api/me/runs/${runId}/subscribe`, channels ? { channels } : {});
    },
    async unsubscribeRun(runId) {
      return json.post(`/api/me/runs/${runId}/unsubscribe`, {});
    },
    async getSubscription(runId) {
      return (await json.get<{ subscribed: boolean; channels: string[] }>(`/api/me/runs/${runId}/subscription`)) ?? { subscribed: false, channels: [] };
    },
    async listNotifications(listOpts) {
      const qs = new URLSearchParams();
      if (listOpts?.unreadOnly) qs.set('unread', '1');
      if (typeof listOpts?.limit === 'number') qs.set('limit', String(listOpts.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return (await json.get<{ items: unknown[]; unreadCount: number }>(`/api/me/notifications${suffix}`)) ?? { items: [], unreadCount: 0 };
    },
    async markAllNotificationsRead() {
      return json.post('/api/me/notifications/read-all', {});
    },

    async addComment(runId, input) {
      return json.post(`/api/me/runs/${runId}/comments`, input);
    },
    async listComments(runId) {
      return (await json.get<{ comments: unknown[]; role: string }>(`/api/me/runs/${runId}/comments`)) ?? { comments: [], role: 'viewer' };
    },
    async editComment(runId, commentId, body, mentions) {
      return json.post(`/api/me/runs/${runId}/comments/${commentId}/edit`, mentions ? { body, mentions } : { body });
    },
    async deleteComment(runId, commentId) {
      return json.post(`/api/me/runs/${runId}/comments/${commentId}/delete`, {});
    },
    async resolveThread(runId, threadId) {
      return json.post(`/api/me/runs/${runId}/threads/${threadId}/resolve`, {});
    },
    async reopenThread(runId, threadId) {
      return json.post(`/api/me/runs/${runId}/threads/${threadId}/reopen`, {});
    },
    async addAnnotation(runId, input) {
      return json.post(`/api/me/runs/${runId}/annotations`, input);
    },
    async listAnnotations(runId) {
      return (await json.get<{ annotations: unknown[]; summary: unknown[] }>(`/api/me/runs/${runId}/annotations`)) ?? { annotations: [], summary: [] };
    },
    async createRunPublicShare(runId, shareOpts) {
      return json.post(`/api/me/runs/${runId}/public-share`, shareOpts ?? {});
    },
  };
}
