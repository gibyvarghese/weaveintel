/**
 * createRunSession — framework-agnostic UX controller for a single run.
 *
 * Phase 5: lifts the per-run UX state machine out of the bespoke client stores
 * (e.g. clients/mobile's `chat-session.ts`) into a shared, reusable primitive.
 * It wraps a {@link RunClient} + the `streamReducer` to give hosts an ergonomic,
 * observable session:
 *
 *   start → submitted → streaming → ready | error
 *
 * with `stop()` (cancel), `regenerate()` (re-run the last input), `approve()` /
 * `reject()` (HITL decisions), throttled notifications (smooth streaming) and a
 * tiny `getState`/`subscribe` store — the exact shape `useSyncExternalStore`
 * wants, so `@weaveintel/react-client`'s `useRun` is a thin wrapper and a vanilla
 * host (the reference UI app) can drive the same controller without a framework.
 *
 * Browser-safe: no Node.js APIs. Timers are injectable for deterministic tests.
 */

import type { RunClient, StartRunInput } from './run-client.js';
import {
  emptyRunViewModel,
  streamReducer,
  type RunViewModel,
  type RunEventEnvelope,
} from './reducer.js';
import { isCursorResumable, type RunCursorStore } from './cursor.js';

/** Thrown by `resume()` when the persisted cursor is outside the resume window. */
export class RunResumeExpiredError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is outside the resume window — re-drive it instead`);
    this.name = 'RunResumeExpiredError';
  }
}

export const RUN_SESSION_SCHEMA_VERSION = 1 as const;

/** The composer-facing lifecycle phase of the session. */
export type RunSessionStatus = 'idle' | 'submitted' | 'streaming' | 'ready' | 'error';

const TERMINAL_KIND_STATUS: Readonly<Record<string, RunSessionStatus>> = {
  'run.completed': 'ready',
  'run.failed': 'error',
  'run.cancelled': 'ready',
};

/** Immutable snapshot handed to subscribers. */
export interface RunSessionState {
  status: RunSessionStatus;
  /** The active run id, or `null` before the first `start()` resolves. */
  runId: string | null;
  /** The reconstructed view model (text / reasoning / tools / widgets / …). */
  model: RunViewModel;
  /** Set when `status === 'error'`. */
  error: Error | null;
}

export interface RunSessionStartInput {
  /** Startup payload (e.g. `{ text: '…' }`). */
  input?: Record<string, unknown>;
  /** Per-run metadata (e.g. `{ mode, provider, model, hitl }`). */
  metadata?: Record<string, unknown>;
  /** Surface hint; defaults to the session's configured surface. */
  surface?: string;
  /** Idempotency key; auto-generated when omitted. */
  idempotencyKey?: string;
}

export interface RunSessionOptions {
  client: RunClient;
  /** Surface stamped on every run start. Defaults to `'web'`. */
  surface?: string;
  /**
   * Coalesce view-model notifications to at most one per `throttleMs` (smooth
   * streaming — caps re-render churn during fast token deltas). Status changes
   * (start / terminal / stop / error) always flush immediately. 0 disables.
   */
  throttleMs?: number;
  /** Idempotency / id generator. Defaults to `crypto.randomUUID()` + counter. */
  generateId?: () => string;
  /** Attach tuning forwarded to `RunClient.attach`. */
  attach?: { maxReconnects?: number; backoffMs?: number[]; afterSequence?: number };
  /**
   * Cursor store for refresh-proof resume. When set, the session persists
   * `{ runId, lastSequence }` on every event and clears it on terminal/reset,
   * so a fresh session can `resume(runId)` after a page refresh.
   */
  cursor?: RunCursorStore;
  /**
   * Resume window (ms) — `resume()` rejects a cursor older than this with
   * {@link RunResumeExpiredError}. Source from `GET /api/me/runs/config`'s
   * `resumeWindowSeconds * 1000`. 0 disables the check. Default 0.
   */
  resumeWindowMs?: number;
  /** Clock injection (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable timers (tests). Default to `setTimeout` / `clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type RunSessionListener = (state: RunSessionState) => void;

export interface RunSession {
  getState(): RunSessionState;
  subscribe(listener: RunSessionListener): () => void;
  /** Start a new run. Rejects if one is already in progress. Resolves to the run id. */
  start(input?: RunSessionStartInput): Promise<string>;
  /** Cancel the in-flight run (best effort) and settle as `ready`. No-op when idle. */
  stop(): Promise<void>;
  /** Re-run the last `start()` input as a fresh run. Rejects if never started. */
  regenerate(): Promise<string>;
  /**
   * Re-attach to an existing run after a refresh, rebuilding the view model from
   * the server journal (full replay) and live-tailing to completion. Uses the
   * persisted cursor to enforce the resume window. Rejects with
   * {@link RunResumeExpiredError} when the cursor is too old, or a plain error
   * when no cursor store / cursor exists. Resolves to the run id.
   */
  resume(runId: string): Promise<string>;
  /** Post a client event into the running run. */
  sendEvent(payload: Record<string, unknown>): Promise<void>;
  /**
   * Collaboration Phase 1 — send a presence heartbeat for the active run ("I'm
   * watching"). The incoming `presence.update` snapshot lands in `model.presence`.
   * Pass `'offline'` (or `{ leave: true }`) to leave.
   */
  setPresence(state?: string): Promise<void>;
  /** Resolve a HITL approval part by task id. */
  approve(taskId: string): Promise<void>;
  /** Reject a HITL approval part by task id. */
  reject(taskId: string): Promise<void>;
  /** Detach and clear back to `idle` (keeps the last input for `regenerate`). */
  reset(): void;
  /** Resolves when the current run next reaches a terminal state. */
  done(): Promise<RunSessionState>;
  /** Detach, drop subscribers + timers. The session is unusable afterwards. */
  dispose(): void;
}

let idCounter = 0;
function defaultGenerateId(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  return uuid ?? `rs-${(++idCounter).toString(36)}`;
}

export function createRunSession(opts: RunSessionOptions): RunSession {
  const { client } = opts;
  const surfaceDefault = opts.surface ?? 'web';
  const throttleMs = opts.throttleMs ?? 0;
  const generateId = opts.generateId ?? defaultGenerateId;
  const now = opts.now ?? (() => Date.now());
  const cursor = opts.cursor;
  const resumeWindowMs = opts.resumeWindowMs ?? 0;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let status: RunSessionStatus = 'idle';
  let runId: string | null = null;
  let model: RunViewModel = emptyRunViewModel();
  let error: Error | null = null;
  let lastInput: RunSessionStartInput | null = null;
  let currentSurface: string = surfaceDefault;

  let controller: AbortController | null = null;
  let disposed = false;
  let terminalKind: string | null = null;

  const listeners = new Set<RunSessionListener>();
  let pendingTimer: unknown = null;
  let doneResolvers: Array<(s: RunSessionState) => void> = [];

  const snapshot = (): RunSessionState => ({ status, runId, model, error });

  const emit = (): void => {
    const s = snapshot();
    for (const l of [...listeners]) l(s);
  };

  /** Flush immediately (status transitions) or coalesce (streaming deltas). */
  const notify = (immediate: boolean): void => {
    if (disposed) return;
    if (immediate || throttleMs <= 0) {
      if (pendingTimer !== null) {
        clearTimer(pendingTimer);
        pendingTimer = null;
      }
      emit();
      return;
    }
    if (pendingTimer === null) {
      pendingTimer = setTimer(() => {
        pendingTimer = null;
        emit();
      }, throttleMs);
    }
  };

  const settleDone = (): void => {
    if (doneResolvers.length === 0) return;
    const s = snapshot();
    const resolvers = doneResolvers;
    doneResolvers = [];
    for (const r of resolvers) r(s);
  };

  const detach = (): void => {
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  const persistCursor = (seq: number): void => {
    if (!cursor || !runId) return;
    void cursor.set({ runId, lastSequence: seq, surface: currentSurface, updatedAt: now() }).catch(() => { /* best effort */ });
  };

  const clearCursor = (): void => {
    if (!cursor || !runId) return;
    const id = runId;
    void cursor.clear(id).catch(() => { /* best effort */ });
  };

  const finalize = (next: RunSessionStatus, err?: Error): void => {
    status = next;
    if (err) error = err;
    clearCursor(); // a terminal run is no longer resumable
    notify(true);
    settleDone();
  };

  const beginAttach = (id: string, afterSequence: number): void => {
    terminalKind = null;
    const ctrl = client.attach(id, {
      afterSequence,
      ...(opts.attach?.maxReconnects !== undefined ? { maxReconnects: opts.attach.maxReconnects } : {}),
      ...(opts.attach?.backoffMs !== undefined ? { backoffMs: opts.attach.backoffMs } : {}),
      onEvent: (env: RunEventEnvelope) => {
        model = streamReducer(model, env);
        if (status === 'submitted') status = 'streaming';
        if (env.kind in TERMINAL_KIND_STATUS) terminalKind = env.kind;
        persistCursor(env.sequence);
        notify(false);
      },
      onComplete: () => {
        finalize(terminalKind ? TERMINAL_KIND_STATUS[terminalKind]! : 'ready');
      },
      onError: (err: Error) => {
        finalize('error', err);
      },
    });
    controller = ctrl;
  };

  async function start(input: RunSessionStartInput = {}): Promise<string> {
    if (disposed) throw new Error('run session disposed');
    if (status === 'submitted' || status === 'streaming') {
      throw new Error('a run is already in progress — stop() or await done() first');
    }
    detach();
    lastInput = input;
    model = emptyRunViewModel();
    error = null;
    runId = null;
    terminalKind = null;
    currentSurface = input.surface ?? surfaceDefault;
    status = 'submitted';
    notify(true);

    const startInput: StartRunInput = {
      idempotencyKey: input.idempotencyKey ?? generateId(),
      surface: input.surface ?? surfaceDefault,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    let rec;
    try {
      rec = await client.startRun(startInput);
    } catch (err) {
      finalize('error', err instanceof Error ? err : new Error(String(err)));
      throw error;
    }
    if (disposed) return rec.id;
    runId = rec.id;
    // A run that is already terminal at creation (rare — e.g. synchronous
    // rejection) skips the stream and settles directly.
    if (rec.status === 'failed') {
      finalize('error', new Error('run failed at creation'));
      return rec.id;
    }
    if (rec.status === 'completed' || rec.status === 'cancelled') {
      finalize('ready');
      return rec.id;
    }
    notify(true); // runId now known, still submitted
    beginAttach(rec.id, opts.attach?.afterSequence ?? -1);
    return rec.id;
  }

  async function resume(targetRunId: string): Promise<string> {
    if (disposed) throw new Error('run session disposed');
    if (status === 'submitted' || status === 'streaming') {
      throw new Error('a run is already in progress — stop() or await done() first');
    }
    if (!cursor) throw new Error('resume requires a cursor store (RunSessionOptions.cursor)');
    const saved = await cursor.get(targetRunId);
    if (!saved) throw new Error(`no persisted cursor for run ${targetRunId}`);
    if (!isCursorResumable(saved, resumeWindowMs, now())) {
      await cursor.clear(targetRunId).catch(() => { /* best effort */ });
      throw new RunResumeExpiredError(targetRunId);
    }

    detach();
    model = emptyRunViewModel();
    error = null;
    runId = targetRunId;
    terminalKind = null;
    currentSurface = saved.surface ?? surfaceDefault;
    status = 'submitted';
    notify(true);
    // Full replay (-1) rebuilds the complete view model from the server journal,
    // then live-tails any remaining events to a terminal state.
    beginAttach(targetRunId, -1);
    return targetRunId;
  }

  async function stop(): Promise<void> {
    if (status !== 'submitted' && status !== 'streaming') return;
    detach();
    const id = runId;
    if (id) {
      try {
        await client.cancelRun(id);
      } catch {
        /* best effort — we still settle the session as stopped */
      }
    }
    finalize('ready');
  }

  async function regenerate(): Promise<string> {
    if (!lastInput) throw new Error('nothing to regenerate — call start() first');
    return start(lastInput);
  }

  async function sendEvent(payload: Record<string, unknown>): Promise<void> {
    if (!runId) throw new Error('no active run to send an event to');
    await client.postEvent(runId, payload);
  }

  async function setPresence(state: string = 'online'): Promise<void> {
    if (!runId) throw new Error('no active run for presence');
    await client.setPresence(runId, state === 'offline' ? { leave: true } : { presence: state });
  }

  const approve = (taskId: string): Promise<void> =>
    sendEvent({ kind: 'approval.decision', payload: { taskId, action: 'approve' } });
  const reject = (taskId: string): Promise<void> =>
    sendEvent({ kind: 'approval.decision', payload: { taskId, action: 'reject' } });

  function reset(): void {
    detach();
    clearCursor();
    status = 'idle';
    model = emptyRunViewModel();
    runId = null;
    error = null;
    terminalKind = null;
    notify(true);
  }

  function done(): Promise<RunSessionState> {
    if (status === 'ready' || status === 'error') return Promise.resolve(snapshot());
    return new Promise((resolve) => doneResolvers.push(resolve));
  }

  function dispose(): void {
    disposed = true;
    detach();
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    listeners.clear();
    doneResolvers = [];
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    regenerate,
    resume,
    sendEvent,
    setPresence,
    approve,
    reject,
    reset,
    done,
    dispose,
  };
}
