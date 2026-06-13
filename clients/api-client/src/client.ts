/**
 * client.ts — createGeneweaveClient: the typed geneWeave `/api/me` client.
 *
 * Assembles the verified surface (auth, runs, catalog, tasks, reminders,
 * memories, devices, notification prefs/actions, conversations) on top of an
 * injectable {@link GeneweaveTransport}, validating every response at the
 * boundary with the {@link module:schemas} zod contracts. The run stream is
 * consumed through `@weaveintel/client`'s `streamReducer` with automatic,
 * zero-gap resume (reconnect resumes from the highest sequence already seen).
 *
 * Per-tenant configurability: each call to `createGeneweaveClient` is a fully
 * independent instance — host, token store, and outbox storage are all
 * injected, with no module-level singletons. A single device can therefore run
 * one client per tenant/host. The optional `namespace` isolates outbox storage
 * keys so those instances never collide.
 *
 * No React / React Native imports.
 */

import {
  streamReducer,
  emptyRunViewModel,
  createRunOutbox,
  MemoryStorage,
  type RunViewModel,
  type RunEventEnvelope as ReducerEnvelope,
  type OutboxStorage,
  type RunOutbox,
  type StartRunInput,
  type RunClient,
} from '@weaveintel/client';
import type { TokenStore, AuthTokens } from './token-store.js';
import { createHttpTransport, type GeneweaveTransport, type RawResponse, type TransportRequest } from './http.js';
import { AuthExpiredError, GeneweaveApiError, ManagedByOrgError, ResponseShapeError } from './errors.js';
import {
  AuthSessionSchema,
  MeUserSchema,
  RunRecordSchema,
  RunListSchema,
  PostEventResultSchema,
  CancelRunResultSchema,
  CatalogSchema,
  TenantThemeResponseSchema,
  TaskSchema,
  TaskListSchema,
  NotificationActionResultSchema,
  ReminderSchema,
  ReminderListSchema,
  RegisterDeviceResultSchema,
  NotificationPreferencesSchema,
  MemoriesSchema,
  CreatedMemorySchema,
  ConversationListSchema,
  ConversationPatchResultSchema,
  RunEventEnvelopeSchema,
  type AuthSession,
  type MeUser,
  type RunRecord,
  type RunStatus,
  type PostEventResult,
  type Catalog,
  type TenantThemeTokens,
  type Task,
  type NotificationAction,
  type NotificationActionResult,
  type Reminder,
  type DeviceChannel,
  type NotificationPreferences,
  type Memories,
  type CreatedMemory,
  type Conversation,
  type ConversationFilter,
  type RunEventEnvelope,
} from './schemas.js';
import type { z } from 'zod';

const TERMINAL_KINDS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000];

export interface CreateGeneweaveClientOptions {
  /** Base origin of the geneWeave server, e.g. `https://api.example.com`. */
  host: string;
  /** Where bearer + CSRF tokens are read from and written back to. */
  tokenStore: TokenStore;
  /**
   * Re-mints a session on a 401. Called at most once per request; the result
   * is persisted and the request retried once. Return `null` / throw to make
   * the call fail with {@link AuthExpiredError}.
   */
  refresh?: () => Promise<AuthTokens | null>;
  /** Inject a transport (tests, or a React-Native SSE transport in M3). */
  transport?: GeneweaveTransport;
  /** Inject fetch when using the default transport (keeps the package testable). */
  fetchImpl?: typeof fetch;
  /** Extra headers added to every request (e.g. an `X-Client-Version` tag). */
  extraHeaders?: Record<string, string>;
  /** Backing storage for the offline run outbox (defaults to in-memory). */
  outboxStorage?: OutboxStorage;
  /**
   * Namespace isolating this instance's outbox storage keys, so multiple
   * tenants/hosts can coexist on one device. Defaults to the host origin.
   */
  namespace?: string;
}

/** Options for {@link GeneweaveClient.attachRun}. */
export interface AttachRunOptions {
  /** Resume from this sequence (exclusive). Defaults to -1 (from the start). */
  afterSequence?: number;
  /** Called with each validated event envelope, in order. */
  onEvent?: (envelope: RunEventEnvelope) => void;
  /** Called with the accumulated view model after each applied event. */
  onModel?: (model: RunViewModel) => void;
  /** Called when the run reaches a terminal state, with the final view model. */
  onComplete?: (model: RunViewModel) => void;
  /** Called on a stream error (after reconnects are exhausted). */
  onError?: (err: Error) => void;
  /** Detach the stream when this signal aborts. */
  signal?: AbortSignal;
  /** Max reconnect attempts before giving up (default 8). 0 disables resume. */
  maxReconnects?: number;
}

export interface AttachHandle {
  /** Detach from the stream. Idempotent. */
  detach(): void;
}

export interface ListRunsFilter {
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

/** Filter + pagination for {@link GeneweaveClient.listConversations}. */
export interface ListConversationsFilter {
  query?: string;
  filter?: ConversationFilter;
  limit?: number;
  offset?: number;
}

/** The typed geneWeave client surface. */
export interface GeneweaveClient {
  /** The host this client targets. */
  readonly host: string;
  /** The offline run outbox (enqueue while offline, flush on reconnect). */
  readonly outbox: RunOutbox;

  // Auth
  authenticate(email: string, password: string): Promise<AuthSession>;
  getCurrentUser(): Promise<MeUser>;
  signOut(): Promise<void>;

  // Runs
  startRun(input: StartRunInput): Promise<RunRecord>;
  listRuns(filter?: ListRunsFilter): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | null>;
  cancelRun(id: string): Promise<RunStatus>;
  postEvent(runId: string, event: { kind?: string; payload?: Record<string, unknown> }): Promise<PostEventResult>;
  attachRun(runId: string, opts?: AttachRunOptions): AttachHandle;

  // Offline outbox
  enqueueRun(input: StartRunInput): Promise<string>;
  flushOutbox(): Promise<{ flushed: number; failed: number }>;

  // Catalog
  getCatalog(surface?: string): Promise<Catalog>;

  // Theme — per-tenant design tokens, or null when no override is configured.
  getTenantTheme(): Promise<TenantThemeTokens | null>;

  // Tasks
  listTasks(): Promise<Task[]>;
  createTask(input: { title: string; description?: string; dueAt?: string; actionable?: boolean; provenance?: Record<string, unknown> }): Promise<Task>;
  completeTask(taskId: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  resolveNotificationAction(input: { taskId: string; actionId: NotificationAction }): Promise<NotificationActionResult>;

  // Reminders
  listReminders(): Promise<Reminder[]>;
  createReminder(input: { label: string; fireAt?: string; rrule?: string; provenance?: Record<string, unknown> }): Promise<Reminder>;
  rescheduleReminder(reminderId: string, fireAt: string): Promise<Reminder>;
  deleteReminder(reminderId: string): Promise<void>;

  // Devices
  registerDevice(input: { channel: DeviceChannel; token: string; label?: string }): Promise<void>;
  removeDevice(token: string): Promise<void>;

  // Notification preferences
  getNotificationPreferences(): Promise<NotificationPreferences>;
  setNotificationPreferences(prefs: NotificationPreferences): Promise<void>;

  // Memories
  listMemories(): Promise<Memories>;
  createMemory(input: { content: string; kind?: string }): Promise<CreatedMemory>;
  correctMemory(id: string, input: { content: string; reason?: string }): Promise<CreatedMemory>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(): Promise<void>;

  // Conversations (SP2)
  listConversations(filter?: ListConversationsFilter): Promise<Conversation[]>;
  updateConversation(id: string, patch: { pinned?: boolean; archived?: boolean; title?: string }): Promise<Conversation>;
}

/** Wrap an outbox storage so its keys are isolated under `namespace`. */
function namespacedOutboxStorage(storage: OutboxStorage, namespace: string): OutboxStorage {
  const prefix = `${namespace}::`;
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
    async keys() {
      const all = await storage.keys();
      return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
  };
}

export function createGeneweaveClient(opts: CreateGeneweaveClientOptions): GeneweaveClient {
  const transport: GeneweaveTransport =
    opts.transport ??
    createHttpTransport({
      host: opts.host,
      tokenStore: opts.tokenStore,
      ...(opts.refresh ? { refresh: opts.refresh } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    });

  const namespace = opts.namespace ?? opts.host;
  const baseStorage = opts.outboxStorage ?? new MemoryStorage();
  const outbox = createRunOutbox({ storage: namespacedOutboxStorage(baseStorage, namespace) });

  /** Validate a successful body against a schema, or throw a typed error. */
  function parse<S extends z.ZodTypeAny>(schema: S, raw: RawResponse, req: { method: string; path: string }): z.infer<S> {
    const result = schema.safeParse(raw.body);
    if (!result.success) {
      throw new ResponseShapeError({ body: raw.body, issues: result.error.message, request: req });
    }
    return result.data;
  }

  /** Map a non-2xx response onto the typed error hierarchy. */
  function fail(raw: RawResponse, req: { method: string; path: string }): never {
    const b = raw.body as { error?: unknown; managedByOrg?: unknown } | null;
    if (raw.status === 401) throw new AuthExpiredError({ body: raw.body, request: req });
    if (raw.status === 403 && b && b.managedByOrg === true) {
      throw new ManagedByOrgError({ body: raw.body, request: req });
    }
    const msg = b && typeof b.error === 'string' ? b.error : `${req.method} ${req.path} → ${raw.status}`;
    throw new GeneweaveApiError(msg, { status: raw.status, body: raw.body, request: req });
  }

  function ok(status: number): boolean {
    return status >= 200 && status < 300;
  }

  async function send(req: TransportRequest): Promise<RawResponse> {
    return transport.request(req);
  }

  // Internal RunClient adapter so the shared outbox can flush through our typed startRun.
  const outboxRunClientAdapter = {
    async startRun(input: StartRunInput): Promise<unknown> {
      return api.startRun(input);
    },
  } as unknown as RunClient;

  const api: GeneweaveClient = {
    host: opts.host,
    outbox,

    // ── Auth ────────────────────────────────────────────────────────────────
    async authenticate(email, password) {
      const req = { method: 'POST' as const, path: '/api/auth/token' };
      const raw = await send({ ...req, body: { email, password } });
      if (!ok(raw.status)) fail(raw, req);
      const session = parse(AuthSessionSchema, raw, req);
      await opts.tokenStore.set({ token: session.token, csrfToken: session.csrfToken });
      return session;
    },

    async getCurrentUser() {
      const req = { method: 'GET' as const, path: '/api/auth/me' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      const body = (raw.body ?? {}) as { user?: unknown };
      const result = MeUserSchema.safeParse(body.user);
      if (!result.success) throw new ResponseShapeError({ body: raw.body, issues: result.error.message, request: req });
      return result.data;
    },

    async signOut() {
      const req = { method: 'POST' as const, path: '/api/auth/logout' };
      try {
        await send(req);
      } finally {
        await opts.tokenStore.clear();
      }
    },

    // ── Runs ────────────────────────────────────────────────────────────────
    async startRun(input) {
      const req = { method: 'POST' as const, path: '/api/me/runs' };
      const raw = await send({
        ...req,
        csrf: true,
        idempotencyKey: input.idempotencyKey,
        body: {
          ...(input.surface !== undefined ? { surface: input.surface } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
        },
      });
      if (!ok(raw.status)) fail(raw, req);
      return parse(RunRecordSchema, raw, req);
    },

    async listRuns(filter = {}) {
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      if (filter.offset !== undefined) params.set('offset', String(filter.offset));
      const qs = params.toString();
      const req = { method: 'GET' as const, path: qs ? `/api/me/runs?${qs}` : '/api/me/runs' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(RunListSchema, raw, req).runs;
    },

    async getRun(id) {
      const req = { method: 'GET' as const, path: `/api/me/runs/${id}` };
      const raw = await send(req);
      if (raw.status === 404) return null;
      if (!ok(raw.status)) fail(raw, req);
      return parse(RunRecordSchema, raw, req);
    },

    async cancelRun(id) {
      const req = { method: 'POST' as const, path: `/api/me/runs/${id}/cancel` };
      const raw = await send({ ...req, csrf: true });
      if (!ok(raw.status)) fail(raw, req);
      return parse(CancelRunResultSchema, raw, req).status;
    },

    async postEvent(runId, event) {
      const req = { method: 'POST' as const, path: `/api/me/runs/${runId}/events` };
      const raw = await send({
        ...req,
        csrf: true,
        body: {
          ...(event.kind !== undefined ? { kind: event.kind } : {}),
          ...(event.payload !== undefined ? { payload: event.payload } : {}),
        },
      });
      if (!ok(raw.status)) fail(raw, req);
      return parse(PostEventResultSchema, raw, req);
    },

    attachRun(runId, attachOpts = {}) {
      const controller = new AbortController();
      attachOpts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      const maxReconnects = attachOpts.maxReconnects ?? 8;
      let lastSeq = attachOpts.afterSequence ?? -1;
      let model = emptyRunViewModel();
      let terminal = false;
      let reconnects = 0;

      const connect = () => {
        if (controller.signal.aborted || terminal) return;
        transport.openStream(
          { path: `/api/me/runs/${runId}/events?after=${lastSeq}`, signal: controller.signal },
          {
            onEvent: (value) => {
              const parsed = RunEventEnvelopeSchema.safeParse(value);
              if (!parsed.success) return; // skip malformed; do not advance cursor
              const env = parsed.data;
              if (env.sequence <= lastSeq) return; // dedupe across reconnects
              lastSeq = env.sequence;
              model = streamReducer(model, env as unknown as ReducerEnvelope);
              attachOpts.onEvent?.(env);
              attachOpts.onModel?.(model);
              if (TERMINAL_KINDS.has(env.kind)) {
                terminal = true;
                controller.abort();
                attachOpts.onComplete?.(model);
              }
            },
            onError: (err) => {
              if (terminal || controller.signal.aborted) return;
              attachOpts.onError?.(err);
            },
            onClose: () => {
              if (terminal || controller.signal.aborted) return;
              if (maxReconnects === 0 || reconnects >= maxReconnects) {
                attachOpts.onError?.(new Error(`run stream gave up after ${reconnects} reconnects`));
                return;
              }
              const delay = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)] ?? 30000;
              reconnects++;
              setTimeout(connect, delay);
            },
          },
        );
      };

      connect();
      return { detach: () => controller.abort() };
    },

    // ── Offline outbox ────────────────────────────────────────────────────────
    async enqueueRun(input) {
      return outbox.enqueue(input);
    },
    async flushOutbox() {
      return outbox.flush(outboxRunClientAdapter);
    },

    // ── Catalog ──────────────────────────────────────────────────────────────
    async getCatalog(surface = 'mobile') {
      const req = { method: 'GET' as const, path: `/api/me/catalog?surface=${encodeURIComponent(surface)}` };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(CatalogSchema, raw, req);
    },

    // ── Theme ──────────────────────────────────────────────────────────────
    async getTenantTheme() {
      const req = { method: 'GET' as const, path: '/api/me/theme' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(TenantThemeResponseSchema, raw, req).theme;
    },

    // ── Tasks ────────────────────────────────────────────────────────────────
    async listTasks() {
      const req = { method: 'GET' as const, path: '/api/me/tasks' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(TaskListSchema, raw, req).tasks;
    },
    async createTask(input) {
      const req = { method: 'POST' as const, path: '/api/me/tasks' };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      return parse(TaskSchema, raw, req);
    },
    async completeTask(taskId) {
      const req = { method: 'POST' as const, path: `/api/me/tasks/${taskId}/complete` };
      const raw = await send({ ...req, csrf: true, body: {} });
      if (!ok(raw.status)) fail(raw, req);
      return parse(TaskSchema, raw, req);
    },
    async cancelTask(taskId) {
      const req = { method: 'POST' as const, path: `/api/me/tasks/${taskId}/cancel` };
      const raw = await send({ ...req, csrf: true, body: {} });
      if (!ok(raw.status)) fail(raw, req);
      return parse(TaskSchema, raw, req);
    },
    async resolveNotificationAction(input) {
      const req = { method: 'POST' as const, path: '/api/me/notifications/actions' };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      return parse(NotificationActionResultSchema, raw, req);
    },

    // ── Reminders ──────────────────────────────────────────────────────────────
    async listReminders() {
      const req = { method: 'GET' as const, path: '/api/me/reminders' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(ReminderListSchema, raw, req).reminders;
    },
    async createReminder(input) {
      const req = { method: 'POST' as const, path: '/api/me/reminders' };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      return parse(ReminderSchema, raw, req);
    },
    async rescheduleReminder(reminderId, fireAt) {
      const req = { method: 'POST' as const, path: `/api/me/reminders/${reminderId}/reschedule` };
      const raw = await send({ ...req, csrf: true, body: { fireAt } });
      if (!ok(raw.status)) fail(raw, req);
      return parse(ReminderSchema, raw, req);
    },
    async deleteReminder(reminderId) {
      const req = { method: 'DELETE' as const, path: `/api/me/reminders/${reminderId}` };
      const raw = await send({ ...req, csrf: true });
      if (!ok(raw.status)) fail(raw, req);
    },

    // ── Devices ──────────────────────────────────────────────────────────────
    async registerDevice(input) {
      const req = { method: 'POST' as const, path: '/api/me/devices' };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      parse(RegisterDeviceResultSchema, raw, req);
    },
    async removeDevice(token) {
      const req = { method: 'DELETE' as const, path: `/api/me/devices/${encodeURIComponent(token)}` };
      const raw = await send({ ...req, csrf: true });
      if (!ok(raw.status)) fail(raw, req);
    },

    // ── Notification preferences ─────────────────────────────────────────────
    async getNotificationPreferences() {
      const req = { method: 'GET' as const, path: '/api/me/notification-preferences' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(NotificationPreferencesSchema, raw, req);
    },
    async setNotificationPreferences(prefs) {
      const req = { method: 'PUT' as const, path: '/api/me/notification-preferences' };
      const raw = await send({ ...req, csrf: true, body: prefs });
      if (!ok(raw.status)) fail(raw, req);
    },

    // ── Memories ──────────────────────────────────────────────────────────────
    async listMemories() {
      const req = { method: 'GET' as const, path: '/api/me/memories' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(MemoriesSchema, raw, req);
    },
    async createMemory(input) {
      const req = { method: 'POST' as const, path: '/api/me/memories' };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      return parse(CreatedMemorySchema, raw, req);
    },
    async correctMemory(id, input) {
      const req = { method: 'PATCH' as const, path: `/api/me/memories/${id}` };
      const raw = await send({ ...req, csrf: true, body: input });
      if (!ok(raw.status)) fail(raw, req);
      return parse(CreatedMemorySchema, raw, req);
    },
    async deleteMemory(id) {
      const req = { method: 'DELETE' as const, path: `/api/me/memories/${id}` };
      const raw = await send({ ...req, csrf: true });
      if (!ok(raw.status)) fail(raw, req);
    },
    async clearMemories() {
      const req = { method: 'DELETE' as const, path: '/api/me/memories' };
      const raw = await send({ ...req, csrf: true, body: { confirm: true } });
      if (!ok(raw.status)) fail(raw, req);
    },

    // ── Conversations (SP2) ────────────────────────────────────────────────────
    async listConversations(filter = {}) {
      const params = new URLSearchParams();
      if (filter.query) params.set('query', filter.query);
      if (filter.filter) params.set('filter', filter.filter);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      if (filter.offset !== undefined) params.set('offset', String(filter.offset));
      const qs = params.toString();
      const req = { method: 'GET' as const, path: qs ? `/api/me/conversations?${qs}` : '/api/me/conversations' };
      const raw = await send(req);
      if (!ok(raw.status)) fail(raw, req);
      return parse(ConversationListSchema, raw, req).conversations;
    },
    async updateConversation(id, patch) {
      const req = { method: 'PATCH' as const, path: `/api/me/conversations/${id}` };
      const raw = await send({ ...req, csrf: true, body: patch });
      if (!ok(raw.status)) fail(raw, req);
      return parse(ConversationPatchResultSchema, raw, req).conversation;
    },
  };

  return api;
}
