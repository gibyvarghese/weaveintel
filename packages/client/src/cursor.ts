/**
 * Run cursor store — refresh-proof resume (Phase 6).
 *
 * Persists, per run, the last sequence the client has seen plus a timestamp, so
 * that after a page refresh / app relaunch the host can re-attach to a still-live
 * (or recently-finished) run and rebuild its view model instead of losing it.
 *
 * The store is a thin layer over the same injectable `OutboxStorage` KV the
 * outbox uses (localStorage / IndexedDB / memory). The resume *window* —
 * `run_stream_config.resume_window_seconds`, served at `GET /api/me/runs/config`
 * — is enforced by the consumer (`createRunSession.resume`) using `updatedAt`.
 *
 * Browser-safe: no Node.js APIs.
 */
import type { OutboxStorage } from './outbox.js';
import { MemoryStorage } from './outbox.js';

export interface RunCursor {
  runId: string;
  /** Highest run-event sequence the client has applied. */
  lastSequence: number;
  /** Surface the run was started on (e.g. 'web'). */
  surface?: string;
  /** Epoch ms of the last update — used to enforce the resume window. */
  updatedAt: number;
}

export interface RunCursorStore {
  /** Read the cursor for a run, or null if none / unparseable. */
  get(runId: string): Promise<RunCursor | null>;
  /** Upsert a cursor (stamps `updatedAt` if not provided). */
  set(cursor: Omit<RunCursor, 'updatedAt'> & { updatedAt?: number }): Promise<RunCursor>;
  /** Remove a run's cursor (call on terminal / reset). */
  clear(runId: string): Promise<void>;
  /** All stored cursors, newest first. */
  list(): Promise<RunCursor[]>;
  /** The most recently updated cursor (what a fresh tab would resume). */
  latest(): Promise<RunCursor | null>;
  /** Drop every cursor. */
  clearAll(): Promise<void>;
}

const CURSOR_KEY_PREFIX = '__weave_cursor__:';

export function createRunCursorStore(opts: { storage?: OutboxStorage; now?: () => number } = {}): RunCursorStore {
  const storage = opts.storage ?? new MemoryStorage();
  const now = opts.now ?? (() => Date.now());

  const keyFor = (runId: string) => CURSOR_KEY_PREFIX + runId;

  async function readKey(key: string): Promise<RunCursor | null> {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as RunCursor;
      // Defensive: a corrupt / partial entry must not crash a resume decision.
      if (typeof c?.runId !== 'string' || typeof c?.lastSequence !== 'number' || typeof c?.updatedAt !== 'number') {
        return null;
      }
      return c;
    } catch {
      return null;
    }
  }

  async function allKeys(): Promise<string[]> {
    return (await storage.keys()).filter((k) => k.startsWith(CURSOR_KEY_PREFIX));
  }

  return {
    async get(runId) {
      return readKey(keyFor(runId));
    },

    async set(cursor) {
      const full: RunCursor = {
        runId: cursor.runId,
        lastSequence: cursor.lastSequence,
        ...(cursor.surface !== undefined ? { surface: cursor.surface } : {}),
        updatedAt: cursor.updatedAt ?? now(),
      };
      await storage.setItem(keyFor(full.runId), JSON.stringify(full));
      return full;
    },

    async clear(runId) {
      await storage.removeItem(keyFor(runId));
    },

    async list() {
      const out: RunCursor[] = [];
      for (const key of await allKeys()) {
        const c = await readKey(key);
        if (c) out.push(c);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async latest() {
      const all = await this.list();
      return all[0] ?? null;
    },

    async clearAll() {
      for (const key of await allKeys()) await storage.removeItem(key);
    },
  };
}

/** True when a cursor is still inside the resume window (ms). */
export function isCursorResumable(cursor: RunCursor, resumeWindowMs: number, nowMs: number): boolean {
  if (resumeWindowMs <= 0) return true; // 0 / negative ⇒ no window enforcement
  return nowMs - cursor.updatedAt <= resumeWindowMs;
}
