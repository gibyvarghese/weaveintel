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
  // Phase 1 — lossless chat→run parity. Previously dropped by the bridge.
  'reasoning.delta',  // model thinking, as a DISTINCT channel (not folded into text)
  'step.update',      // agent/supervisor plan step lifecycle
  'usage.update',     // token usage, cost, latency, model (from the chat `done` frame)
  'citation.add',     // source/citation (forward-compatible; no producer yet)
  'artifact.update',  // artifact reference produced by the run
  'diagnostic',       // guardrail / policy / eval / cognitive / ensemble metadata
  // Phase 2 — streaming partial tool input (per-part state machine).
  'tool.input.start', // a tool call's input args begin streaming
  'tool.input.delta', // a partial chunk of the tool's input args (JSON text)
  // Phase 4 — human-in-the-loop tool approval (the run pauses awaiting a decision).
  'approval.request',  // a gated tool needs a human approve/deny decision
  'approval.resolved', // the decision arrived (approved / denied / modified)
  // Phase 7 — structured object streaming + multimodal file parts.
  'object.delta',     // an incremental chunk of a streamed structured (JSON) object
  'object.complete',  // the structured object finished (carries the final value)
  'file.part',        // a multimodal file part (image / document) in/out of the run
  // Collaboration Phase 1 — presence ("who else is watching this run").
  // EPHEMERAL: this is a live snapshot broadcast to current subscribers; it is
  // NEVER written to the run journal (presence is high-churn, last-write-wins,
  // disposable — it only ever means "current"). A run_presence table holds the
  // current state; this event is the realtime push of that state.
  'presence.update',  // the full set of currently-present participants (a snapshot)
] as const;

export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

// ─── Phase 1 payload contracts ───────────────────────────────
// Typed payloads for the parity kinds, shared by the geneweave emitter/bridge
// (producer) and the @weaveintel/client reducer (consumer).

/** Token usage + cost + timing for a run (from the chat `done` frame). */
export interface RunUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  model?: string;
  provider?: string;
  mode?: string;
}

/** A single agent/supervisor plan step. */
export interface RunStep {
  index?: number;
  type?: string;
  content?: string;
  toolName?: string;
  durationMs?: number;
  /** Lifecycle phase, when known. */
  phase?: 'step_start' | 'step_end';
}

/** A reference to an artifact produced by the run. */
export interface RunArtifactRef {
  id: string;
  type?: string;
  title?: string;
  mimeType?: string;
  url?: string;
}

/** A source / citation surfaced during the run. */
export interface RunCitation {
  id: string;
  text?: string;
  source?: string;
  url?: string;
}

/** A non-output diagnostic frame (guardrail / policy / eval / cognitive / ensemble). */
export interface RunDiagnostic {
  channel: string;
  data?: unknown;
}

/** A human-in-the-loop approval request emitted when a gated tool needs a decision. */
export interface RunApprovalRequest {
  /** Correlates the request with the client's `approval.decision` reply. */
  taskId: string;
  toolName: string;
  args?: Record<string, unknown>;
  title?: string;
  description?: string;
  riskLevel?: string;
  /** Available decisions (e.g. Approve / Deny). */
  actions?: Array<{ label: string; value: string; style?: string }>;
}

/** Resolution of a prior approval request. */
export interface RunApprovalResolution {
  taskId: string;
  /** 'approve' | 'reject' | 'modify'. */
  action: string;
  feedback?: string;
}

/** Phase 7 — an incremental chunk of a streamed structured (JSON) object. */
export interface RunObjectDelta {
  /** Raw JSON text fragment to append to the object buffer. */
  delta: string;
}

/** Phase 7 — the structured object finished; carries the final parsed value. */
export interface RunObjectComplete {
  /** The fully-parsed object (when the server could parse it). */
  value?: unknown;
}

/**
 * Collaboration Phase 1 — one participant currently present on a run.
 *
 * "Presence" = who is watching/working on this run right now. A participant can
 * be a human (`peerType: 'human'`) or an AI agent (`peerType: 'agent'`, the
 * mid-2026 "agent as a first-class peer" pattern — the server shows the agent as
 * present with a `working`/`streaming` status while the run produces output).
 *
 * Identity (`userId`, `displayName`) is SERVER-DERIVED from the caller's auth —
 * never client-supplied — so presence cannot be spoofed.
 */
export interface RunPresenceParticipant {
  /** Stable identity (server-derived). For agents, a reserved id like `__agent`. */
  userId: string;
  /** Display label only — no PII (no email / internal ids). */
  displayName: string;
  /** Human: online/idle/typing/away/offline. Agent: working/streaming/thinking/idle. */
  presence: string;
  /** `'human'` or `'agent'`. */
  peerType: 'human' | 'agent';
  /** Optional UI color for the participant's cursor/badge. */
  color?: string;
  /** Epoch ms of the participant's last heartbeat (drives TTL expiry). */
  lastHeartbeatAt?: number;
  /** Optional cursor / viewport the participant is looking at. */
  cursor?: Record<string, unknown>;
}

/**
 * Collaboration Phase 1 — the `presence.update` payload: the FULL set of
 * currently-present participants (a snapshot, not a delta). Snapshots are
 * idempotent and gap-safe over SSE — the client replaces its whole presence set
 * on each update, so a dropped/reordered event self-corrects on the next one.
 */
export interface RunPresenceSnapshot {
  participants: RunPresenceParticipant[];
}

/** Phase 7 — a multimodal file part (image / document) attached to a run. */
export interface RunFilePart {
  id: string;
  /** MIME type, e.g. `image/png`. */
  mediaType: string;
  name?: string;
  /** A URL the client can fetch (mutually exclusive with `dataBase64`). */
  url?: string;
  /** Inline base64 payload (no `data:` prefix). */
  dataBase64?: string;
  size?: number;
  /** `'input'` (sent to the model) or `'output'` (produced by the run). */
  direction?: 'input' | 'output';
}

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
