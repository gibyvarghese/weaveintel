// SPDX-License-Identifier: MIT
/**
 * @weaveintel/core — Run-event stream contract (Phase 0)
 *
 * The single source of truth for:
 *   - the run-event wire envelope (`RunEventEnvelope`),
 *   - the canonical event-kind taxonomy (`RUN_EVENT_KINDS`), and
 *   - the default stream-tuning constants (`RUN_STREAM_CONFIG_DEFAULTS`).
 *
 * The geneweave server executor and the `@weaveintel/client` browser reducer
 * each used to declare their own duplicate `RunEventEnvelope`; both now import
 * this so the producer and consumer can never drift. The geneweave DB
 * `run_stream_config` single-row table seeds from `RUN_STREAM_CONFIG_DEFAULTS`,
 * and clients fall back to it when no server-served config is present.
 */

/** A single ordered run event as it crosses the SSE wire. */
export interface RunEventEnvelope {
  runId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  /** Epoch ms. The server always stamps it; optional on the client. */
  timestamp?: number;
}

/**
 * Canonical run-event kinds emitted by the run executor and consumed by the
 * client reducer. Producer and consumer share this list so a kind cannot be
 * emitted that the reducer silently drops (or vice-versa) without a type error.
 */
export const RUN_EVENT_KINDS = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'text.delta',
  'tool.invoked',
  'tool.completed',
  'tool.errored',
  'widget.update',
] as const;

export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** Kinds that close a run — exactly one is emitted per run. */
export const TERMINAL_RUN_EVENT_KINDS = ['run.completed', 'run.failed', 'run.cancelled'] as const;
export type TerminalRunEventKind = (typeof TERMINAL_RUN_EVENT_KINDS)[number];

const TERMINAL_SET = new Set<string>(TERMINAL_RUN_EVENT_KINDS);

/** True when `kind` is a terminal (run-closing) event kind. */
export function isTerminalRunEventKind(kind: string): boolean {
  return TERMINAL_SET.has(kind);
}

const KNOWN_SET = new Set<string>(RUN_EVENT_KINDS);

/** True when `kind` is part of the canonical taxonomy. */
export function isKnownRunEventKind(kind: string): kind is RunEventKind {
  return KNOWN_SET.has(kind);
}

/**
 * Run/stream tuning shared by server (SSE keepalive, journal retention) and
 * client (reconnect backoff, stall timeout, UI throttle). The geneweave DB
 * `run_stream_config` row is the runtime source of truth; these are the seeded
 * defaults and the client-side fallback.
 */
export interface RunStreamConfig {
  /** SSE keepalive comment interval (ms). */
  heartbeatMs: number;
  /** Max client reconnect attempts before giving up. 0 disables auto-reconnect. */
  maxReconnects: number;
  /** Reconnect backoff schedule (ms), indexed by attempt number (clamped to last). */
  backoffMs: number[];
  /** Tear down a stream that delivers no bytes within this window (ms). 0 = disabled. */
  stallTimeoutMs: number;
  /** Client UI-update throttle (ms). */
  throttleMs: number;
  /** Journal retention horizon (hours) for `user_run_events` pruning. */
  journalRetentionHours: number;
  /** Max persisted events kept per run. */
  journalMaxEvents: number;
  /** Window within which a refreshed client may resume an in-flight run (seconds). */
  resumeWindowSeconds: number;
}

export const RUN_STREAM_CONFIG_DEFAULTS: RunStreamConfig = {
  heartbeatMs: 15_000,
  maxReconnects: 8,
  backoffMs: [250, 500, 1000, 2000, 4000, 8000, 16000, 30000],
  stallTimeoutMs: 60_000,
  throttleMs: 50,
  journalRetentionHours: 24,
  journalMaxEvents: 2000,
  resumeWindowSeconds: 900,
};

/**
 * Pick the backoff delay (ms) for a given zero-based reconnect attempt,
 * clamping to the last entry of the schedule. Shared by client + tests so the
 * reconnect cadence is defined once.
 */
export function reconnectBackoffMs(attempt: number, schedule: readonly number[] = RUN_STREAM_CONFIG_DEFAULTS.backoffMs): number {
  if (schedule.length === 0) return 0;
  const i = Math.max(0, Math.min(attempt, schedule.length - 1));
  return schedule[i]!;
}
