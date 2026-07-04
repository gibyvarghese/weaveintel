/**
 * View-model stream reducer.
 *
 * Pure function — no side effects, no imports beyond type-only.
 * Maps a stream of `RunEventEnvelope` records onto a typed view model
 * that UI layers can render directly.
 */

import type { RunEventEnvelope, RunPresenceParticipant } from '@weaveintel/core';
import { parsePartialJson, extractJsonCandidate } from './partial-json.js';

export type { RunPresenceParticipant };

// ---------------------------------------------------------------------------
// Run status mirrors @weaveintel/core RunStatus
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// Per-event view kinds
// ---------------------------------------------------------------------------

export type TextChunk = {
  kind: 'text';
  text: string;        // full accumulated text so far
  delta: string;       // latest chunk
  role?: string;
};

export type WidgetView = {
  kind: 'widget';
  id: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
};

export type StatusView = {
  kind: 'status';
  status: RunStatus;
  detail?: string;
};

export type ToolCallView = {
  kind: 'tool-call';
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type ErrorView = {
  kind: 'error';
  code: string;
  message: string;
};

// ─── Phase 1 — parity view kinds ─────────────────────────────

export type ReasoningChunk = {
  kind: 'reasoning';
  text: string;   // full accumulated reasoning so far
  delta: string;  // latest chunk
};

export type UsageView = {
  kind: 'usage';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  model?: string;
  provider?: string;
  mode?: string;
};

export type StepView = {
  kind: 'step';
  index?: number;
  type?: string;
  content?: string;
  toolName?: string;
  durationMs?: number;
  phase?: 'step_start' | 'step_end';
};

export type CitationView = {
  kind: 'citation';
  id: string;
  text?: string;
  source?: string;
  url?: string;
};

export type ArtifactView = {
  kind: 'artifact';
  id: string;
  type?: string;
  title?: string;
  mimeType?: string;
  url?: string;
};

export type DiagnosticView = {
  kind: 'diagnostic';
  channel: string;
  data?: unknown;
};

// ─── Phase 4 — human-in-the-loop approval ────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'modified';

export type ApprovalView = {
  kind: 'approval';
  taskId: string;
  toolName?: string;
  title?: string;
  description?: string;
  riskLevel?: string;
  actions?: Array<{ label: string; value: string; style?: string }>;
  status: ApprovalStatus;
};

export type StreamItem =
  | TextChunk | WidgetView | StatusView | ToolCallView | ErrorView
  | ReasoningChunk | UsageView | StepView | CitationView | ArtifactView | DiagnosticView | ApprovalView
  | ObjectView | FileView;

// ─── Phase 2 — ordered typed parts with per-part streaming state ──────────────
// `parts[]` is the modern message model (cf. Vercel AI SDK UIMessage.parts):
// an ordered list of typed parts, each carrying a streaming `state`, derived
// from the same event stream that feeds the legacy view fields above. UI layers
// render `parts` directly and switch on `part.state` (e.g. a tool part renders
// a spinner at `input-available`, a result at `output-available`, an error at
// `output-error`). The legacy fields (`fullText`, `toolCalls`, …) are retained
// for back-compat.

/** Tool-part lifecycle (Vercel-style): input streams → available → output/err. */
export type ToolPartState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

export interface TextPart { type: 'text'; id: string; state: 'streaming' | 'done'; text: string }
export interface ReasoningPart { type: 'reasoning'; id: string; state: 'streaming' | 'done'; text: string }
export interface ToolPart {
  type: 'tool';
  id: string;
  toolCallId: string;
  toolName: string;
  state: ToolPartState;
  /** Partial input JSON accumulated while `state === 'input-streaming'`. */
  inputText?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
export interface StepPart { type: 'step'; id: string; state: 'done'; index?: number; stepType?: string; toolName?: string; phase?: 'step_start' | 'step_end' }
export interface WidgetPart { type: 'widget'; id: string; state: 'done'; widgetId: string; payload: Record<string, unknown>; schemaVersion?: number }
export interface ArtifactPart { type: 'artifact'; id: string; state: 'done'; artifactId: string; title?: string; mimeType?: string; url?: string }
export interface CitationPart { type: 'citation'; id: string; state: 'done'; citationId: string; source?: string; url?: string; text?: string }
/** A human-in-the-loop approval: `requires-action` until the user decides. */
export interface ApprovalPart {
  type: 'approval';
  id: string;
  taskId: string;
  state: 'requires-action' | 'approved' | 'denied' | 'modified';
  toolName?: string;
  title?: string;
  riskLevel?: string;
}

/** Phase 7 — a progressively-streamed structured (JSON) object. */
export interface ObjectPart {
  type: 'object';
  id: string;
  state: 'streaming' | 'done';
  /** Raw accumulated JSON text. */
  text: string;
  /** Best-effort parsed value (partial while streaming, final when done). */
  partial?: unknown;
  /** The fully-parsed value (only when `state === 'done'`). */
  value?: unknown;
}

/** Phase 7 — a multimodal file part (image / document) on the run. */
export interface FilePart {
  type: 'file';
  id: string;
  mediaType: string;
  name?: string;
  url?: string;
  dataBase64?: string;
  size?: number;
  direction?: 'input' | 'output';
}

export type RunPart = TextPart | ReasoningPart | ToolPart | StepPart | WidgetPart | ArtifactPart | CitationPart | ApprovalPart | ObjectPart | FilePart;

/** Phase 7 — view of the streamed structured object. */
export interface ObjectView {
  kind: 'object';
  text: string;
  partial: unknown;
  complete: boolean;
  value?: unknown;
}

/** Phase 7 — view of a multimodal file part. */
export interface FileView {
  kind: 'file';
  id: string;
  mediaType: string;
  name?: string;
  url?: string;
  dataBase64?: string;
  size?: number;
  direction?: 'input' | 'output';
}

/**
 * Collaboration Phase 4 — a review comment as carried over the live wire and
 * rendered anchored to a part. The server is the source of truth (body is
 * pre-sanitized into `bodyHtml`); this is the minimal shape the UI needs.
 */
export interface RunCommentView {
  id: string;
  threadId: string;
  parentId: string | null;
  authorId: string;
  bodyHtml: string;
  anchor: { partId: string; createdAtSeq: number };
  resolvedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
}

/**
 * Collaboration Phase 5 — a handoff as carried over the live wire. The minimal
 * shape the UI needs to render the baton-pass + its lifecycle state.
 */
export interface RunHandoffView {
  id: string;
  runId: string;
  scope: 'user_to_user' | 'agent_to_human' | 'agent_to_agent';
  fromActor: { type: string; id: string };
  toActor: { type: string; id: string };
  state: string;
  reason: string;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// The accumulated view model
// ---------------------------------------------------------------------------

export interface RunViewModel {
  /** Latest sequence number seen. */
  sequence: number;
  /** Run lifecycle status. */
  status: RunStatus;
  /** Accumulated text (all deltas joined). */
  fullText: string;
  /** All text chunks in order. */
  textChunks: TextChunk[];
  /** Widgets keyed by widget id (upserted). */
  widgets: Map<string, WidgetView>;
  /** Ordered list of all tool calls. */
  toolCalls: ToolCallView[];
  /** Last error (if any). */
  lastError?: ErrorView;
  // ── Phase 1 — parity ──
  /** Accumulated reasoning text (distinct channel, not part of `fullText`). */
  reasoningText: string;
  /** All reasoning chunks in order. */
  reasoningChunks: ReasoningChunk[];
  /** Latest usage / cost / model snapshot for the run. */
  usage?: UsageView;
  /** Ordered agent / supervisor plan steps. */
  steps: StepView[];
  /** Citations / sources surfaced during the run. */
  citations: CitationView[];
  /** Artifacts produced, keyed by id (upserted). */
  artifacts: Map<string, ArtifactView>;
  /** Non-output diagnostics (guardrail / policy / eval / cognitive / ensemble). */
  diagnostics: DiagnosticView[];
  /** Phase 4 — human-in-the-loop approvals, upserted by taskId. */
  approvals: ApprovalView[];
  /** Phase 7 — the progressively-streamed structured object (if any). */
  object?: ObjectView;
  /** Phase 7 — multimodal file parts (image / document), in order. */
  files: FileView[];
  /**
   * Collaboration Phase 1 — who is currently present on this run (humans + the
   * agent). A live SNAPSHOT replaced on every `presence.update`; ephemeral (not
   * derived from the journal). Empty until the first presence event arrives.
   */
  presence: RunPresenceParticipant[];
  /**
   * Collaboration Phase 2 / CVE-2026-53843 — set when the server force-closed
   * this stream because the viewer's access was REVOKED mid-watch (removed from
   * the shared run, or sharing ended). The UI should stop auto-reconnecting and
   * show "you no longer have access" rather than silently retrying forever.
   */
  accessRevoked?: { reason: string };
  /**
   * Collaboration Phase 4 — review comments on this run, keyed by id and kept
   * live via ephemeral `comment.added`/`comment.updated`/`comment.deleted`/
   * `comment.resolvedd`/`comment.reopenedd` events (sequence -1). Each carries an
   * `anchor.partId` so the UI can render the comment next to its part. Seeded by
   * a one-shot `listComments()` fetch; updated live as collaborators comment.
   */
  comments: RunCommentView[];
  /**
   * Collaboration Phase 5 — handoffs on this run, keyed by id and kept live via
   * ephemeral `handoff.update` events (sequence -1). Each carries the lifecycle
   * `state` (requested/accepted/in_progress/handed_back/completed/…) so the UI
   * can show "this run was handed to Alice — accepted" without a refetch.
   */
  handoffs: RunHandoffView[];
  /** Phase 2 — ordered typed parts with per-part streaming state. */
  parts: RunPart[];
  /** All items in event order (for a linear render). */
  items: StreamItem[];
}

export function emptyRunViewModel(): RunViewModel {
  return {
    sequence: -1,
    status: 'pending',
    fullText: '',
    textChunks: [],
    widgets: new Map(),
    toolCalls: [],
    reasoningText: '',
    reasoningChunks: [],
    steps: [],
    citations: [],
    artifacts: new Map(),
    diagnostics: [],
    approvals: [],
    files: [],
    presence: [],
    comments: [],
    handoffs: [],
    parts: [],
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Envelope shape — canonical contract from @weaveintel/core (Phase 0).
// Re-exported here so existing import sites (`from './reducer.js'`) keep working
// while the producer (the host application's executor) and consumer (this reducer) share one
// definition and can never drift.
// ---------------------------------------------------------------------------

export type { RunEventEnvelope };

// ---------------------------------------------------------------------------
// Phase 2 — parts state machine (pure helpers over a cloned parts array)
// ---------------------------------------------------------------------------

function strField(p: Record<string, unknown>, k: string): string | undefined {
  return typeof p[k] === 'string' ? p[k] as string : undefined;
}

/** Append a text/reasoning delta, coalescing into the current open part. */
function appendStreamPart(parts: RunPart[], type: 'text' | 'reasoning', delta: string, seq: number): void {
  const last = parts[parts.length - 1];
  if (last && last.type === type && last.state === 'streaming') {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else if (type === 'text') {
    parts.push({ type: 'text', id: `text-${seq}`, state: 'streaming', text: delta });
  } else {
    parts.push({ type: 'reasoning', id: `reasoning-${seq}`, state: 'streaming', text: delta });
  }
}

/** Locate a tool part by toolCallId (any state), else by name among `openStates`. */
function findToolPartIdx(parts: RunPart[], toolCallId: string | undefined, toolName: string | undefined, openStates: ToolPartState[]): number {
  if (toolCallId) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const pt = parts[i]!;
      if (pt.type === 'tool' && pt.toolCallId === toolCallId) return i;
    }
  }
  if (toolName) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const pt = parts[i]!;
      if (pt.type === 'tool' && pt.toolName === toolName && openStates.includes(pt.state)) return i;
    }
  }
  return -1;
}

/** Finalize any still-streaming text/reasoning parts to `done` (run terminal). */
function finalizeStreamingParts(parts: RunPart[]): void {
  for (let i = 0; i < parts.length; i++) {
    const pt = parts[i]!;
    if ((pt.type === 'text' || pt.type === 'reasoning') && pt.state === 'streaming') {
      parts[i] = { ...pt, state: 'done' };
    } else if (pt.type === 'object' && pt.state === 'streaming') {
      // A run that ended without an explicit object.complete: finalize the
      // object from its accumulated text (best-effort parse becomes the value).
      parts[i] = { ...pt, state: 'done', value: pt.partial };
    }
  }
}

/** Apply an envelope to the (already-cloned) `next.parts` array. */
function updateParts(next: RunViewModel, env: RunEventEnvelope): void {
  const p = env.payload;
  const seq = env.sequence;
  const parts = next.parts;

  switch (env.kind) {
    case 'text.delta':
      appendStreamPart(parts, 'text', typeof p['delta'] === 'string' ? p['delta'] : '', seq);
      break;
    case 'reasoning.delta':
      appendStreamPart(parts, 'reasoning', typeof p['delta'] === 'string' ? p['delta'] : (typeof p['text'] === 'string' ? p['text'] : ''), seq);
      break;

    case 'tool.input.start': {
      const toolCallId = strField(p, 'toolCallId') ?? `tc-${seq}`;
      parts.push({ type: 'tool', id: `tool-${seq}`, toolCallId, toolName: strField(p, 'tool') ?? 'unknown', state: 'input-streaming', inputText: '' });
      break;
    }
    case 'tool.input.delta': {
      const i = findToolPartIdx(parts, strField(p, 'toolCallId'), strField(p, 'tool'), ['input-streaming']);
      if (i >= 0) {
        const pt = parts[i] as ToolPart;
        parts[i] = { ...pt, inputText: (pt.inputText ?? '') + (typeof p['delta'] === 'string' ? p['delta'] : '') };
      }
      break;
    }
    case 'tool.invoked': {
      const toolCallId = strField(p, 'toolCallId');
      const toolName = strField(p, 'tool') ?? 'unknown';
      const args = (typeof p['args'] === 'object' && p['args'] !== null) ? p['args'] as Record<string, unknown> : undefined;
      const i = findToolPartIdx(parts, toolCallId, toolName, ['input-streaming']);
      if (i >= 0) {
        const pt = parts[i] as ToolPart;
        parts[i] = { ...pt, state: 'input-available', ...(args ? { args } : {}) };
      } else {
        parts.push({ type: 'tool', id: `tool-${seq}`, toolCallId: toolCallId ?? `tc-${seq}`, toolName, state: 'input-available', ...(args ? { args } : {}) });
      }
      break;
    }
    case 'tool.completed': {
      const tcId = strField(p, 'toolCallId');
      const toolName = strField(p, 'tool') ?? 'unknown';
      const i = findToolPartIdx(parts, tcId, toolName, ['input-available', 'input-streaming']);
      if (i >= 0) parts[i] = { ...(parts[i] as ToolPart), state: 'output-available', result: p['result'] };
      // Orphan completion (no prior tool.invoked — e.g. a HITL-gated tool whose
      // start frame was suppressed): still surface the tool as a finished part.
      else parts.push({ type: 'tool', id: `tool-${seq}`, toolCallId: tcId ?? `tc-${seq}`, toolName, state: 'output-available', result: p['result'] });
      break;
    }
    case 'tool.errored': {
      const tcId = strField(p, 'toolCallId');
      const toolName = strField(p, 'tool') ?? 'unknown';
      const i = findToolPartIdx(parts, tcId, toolName, ['input-available', 'input-streaming']);
      if (i >= 0) parts[i] = { ...(parts[i] as ToolPart), state: 'output-error', error: typeof p['error'] === 'string' ? p['error'] : 'Tool error' };
      else parts.push({ type: 'tool', id: `tool-${seq}`, toolCallId: tcId ?? `tc-${seq}`, toolName, state: 'output-error', error: typeof p['error'] === 'string' ? p['error'] : 'Tool error' });
      break;
    }

    case 'step.update':
      parts.push({
        type: 'step', id: `step-${seq}`, state: 'done',
        ...(typeof p['index'] === 'number' ? { index: p['index'] as number } : {}),
        ...(strField(p, 'type') !== undefined ? { stepType: strField(p, 'type') } : {}),
        ...(strField(p, 'toolName') !== undefined ? { toolName: strField(p, 'toolName') } : {}),
        ...(p['phase'] === 'step_start' || p['phase'] === 'step_end' ? { phase: p['phase'] as 'step_start' | 'step_end' } : {}),
      });
      break;

    case 'widget.update': {
      const widgetId = strField(p, 'id') ?? `widget-${seq}`;
      const payload = (typeof p['payload'] === 'object' && p['payload'] !== null) ? p['payload'] as Record<string, unknown> : p;
      const wp: WidgetPart = { type: 'widget', id: `widget-${seq}`, state: 'done', widgetId, payload, ...(typeof p['schemaVersion'] === 'number' ? { schemaVersion: p['schemaVersion'] as number } : {}) };
      const i = parts.findIndex((pt) => pt.type === 'widget' && pt.widgetId === widgetId);
      if (i >= 0) parts[i] = wp; else parts.push(wp);
      break;
    }
    case 'artifact.update': {
      const artifactId = strField(p, 'id') ?? `artifact-${seq}`;
      const ap: ArtifactPart = { type: 'artifact', id: `artifact-${seq}`, state: 'done', artifactId, ...(strField(p, 'title') !== undefined ? { title: strField(p, 'title') } : {}), ...(strField(p, 'mimeType') !== undefined ? { mimeType: strField(p, 'mimeType') } : {}), ...(strField(p, 'url') !== undefined ? { url: strField(p, 'url') } : {}) };
      const i = parts.findIndex((pt) => pt.type === 'artifact' && pt.artifactId === artifactId);
      if (i >= 0) parts[i] = ap; else parts.push(ap);
      break;
    }
    case 'citation.add': {
      const citationId = strField(p, 'id') ?? `citation-${seq}`;
      if (!parts.some((pt) => pt.type === 'citation' && pt.citationId === citationId)) {
        parts.push({ type: 'citation', id: `citation-${seq}`, state: 'done', citationId, ...(strField(p, 'source') !== undefined ? { source: strField(p, 'source') } : {}), ...(strField(p, 'url') !== undefined ? { url: strField(p, 'url') } : {}), ...(strField(p, 'text') !== undefined ? { text: strField(p, 'text') } : {}) });
      }
      break;
    }

    case 'approval.request': {
      const taskId = strField(p, 'taskId') ?? `approval-${seq}`;
      parts.push({
        type: 'approval', id: `approval-${seq}`, taskId, state: 'requires-action',
        ...(strField(p, 'toolName') !== undefined ? { toolName: strField(p, 'toolName') } : {}),
        ...(strField(p, 'title') !== undefined ? { title: strField(p, 'title') } : {}),
        ...(strField(p, 'riskLevel') !== undefined ? { riskLevel: strField(p, 'riskLevel') } : {}),
      });
      break;
    }
    case 'approval.resolved': {
      const taskId = strField(p, 'taskId');
      const action = strField(p, 'action') ?? 'reject';
      const state = action === 'approve' ? 'approved' : action === 'modify' ? 'modified' : 'denied';
      const i = parts.findIndex((pt) => pt.type === 'approval' && pt.taskId === taskId);
      if (i >= 0) parts[i] = { ...(parts[i] as ApprovalPart), state };
      break;
    }

    case 'object.delta': {
      const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
      const last = parts[parts.length - 1];
      if (last && last.type === 'object' && last.state === 'streaming') {
        const text = last.text + delta;
        parts[parts.length - 1] = { ...last, text, partial: parsePartialJson(extractJsonCandidate(text)).value };
      } else {
        const text = delta;
        parts.push({ type: 'object', id: `object-${seq}`, state: 'streaming', text, partial: parsePartialJson(extractJsonCandidate(text)).value });
      }
      break;
    }
    case 'object.complete': {
      const i = lastIndex(parts, (pt) => pt.type === 'object');
      if (i >= 0) {
        const obj = parts[i] as ObjectPart;
        const value = 'value' in p ? p['value'] : parsePartialJson(extractJsonCandidate(obj.text)).value;
        parts[i] = { ...obj, state: 'done', value, partial: value };
      } else {
        const value = 'value' in p ? p['value'] : undefined;
        parts.push({ type: 'object', id: `object-${seq}`, state: 'done', text: '', value, partial: value });
      }
      break;
    }
    case 'file.part': {
      parts.push({
        type: 'file', id: strField(p, 'id') ?? `file-${seq}`,
        mediaType: strField(p, 'mediaType') ?? 'application/octet-stream',
        ...(strField(p, 'name') !== undefined ? { name: strField(p, 'name') } : {}),
        ...(strField(p, 'url') !== undefined ? { url: strField(p, 'url') } : {}),
        ...(strField(p, 'dataBase64') !== undefined ? { dataBase64: strField(p, 'dataBase64') } : {}),
        ...(typeof p['size'] === 'number' ? { size: p['size'] } : {}),
        ...(p['direction'] === 'input' || p['direction'] === 'output' ? { direction: p['direction'] } : {}),
      });
      break;
    }

    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      finalizeStreamingParts(parts);
      break;

    default:
      break;
  }
}

/** Index of the last part matching a predicate, or -1. */
function lastIndex(parts: RunPart[], pred: (p: RunPart) => boolean): number {
  for (let i = parts.length - 1; i >= 0; i--) if (pred(parts[i]!)) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Returns a *new* `RunViewModel` with the envelope applied.
 * Never mutates the input state.
 */
export function streamReducer(state: RunViewModel, envelope: RunEventEnvelope): RunViewModel {
  // Collaboration Phase 1 — `presence.update` is an EPHEMERAL snapshot, not a
  // journaled event: it carries `sequence: -1` and must bypass the sequence
  // dedup below. Replace the whole presence set (snapshots are idempotent and
  // gap-safe) and leave `sequence`/parts/items untouched.
  if (envelope.kind === 'presence.update') {
    const raw = (envelope.payload as { participants?: unknown }).participants;
    const participants = Array.isArray(raw) ? (raw as RunPresenceParticipant[]) : [];
    return { ...state, presence: participants };
  }

  // CVE-2026-53843 — the server force-closed this stream because access was
  // revoked. Also ephemeral (`sequence: -1`); record it so the consumer can stop
  // reconnecting and surface a clear message. Never throws, never advances seq.
  if (envelope.kind === 'access.revoked') {
    const reason = typeof (envelope.payload as { reason?: unknown }).reason === 'string'
      ? (envelope.payload as { reason: string }).reason
      : 'access revoked';
    return { ...state, accessRevoked: { reason } };
  }

  // Collaboration Phase 4 — live review comments. All ephemeral (`sequence: -1`),
  // so they bypass the journal dedup and update `comments` without touching
  // run output. The UI renders each anchored to `anchor.partId`.
  if (envelope.kind === 'comment.added' || envelope.kind === 'comment.updated') {
    const incoming = (envelope.payload as { comment?: RunCommentView }).comment;
    if (!incoming || typeof incoming.id !== 'string') return state;
    const rest = state.comments.filter((c) => c.id !== incoming.id);
    return { ...state, comments: [...rest, incoming].sort((a, b) => a.createdAt - b.createdAt) };
  }
  if (envelope.kind === 'comment.deleted') {
    const id = (envelope.payload as { id?: string }).id;
    return id ? { ...state, comments: state.comments.filter((c) => c.id !== id) } : state;
  }
  if (envelope.kind === 'comment.resolvedd' || envelope.kind === 'comment.reopenedd') {
    // Note: kinds are `comment.${action}d` where action is resolve/reopen.
    const threadId = (envelope.payload as { threadId?: string }).threadId;
    if (!threadId) return state;
    const resolvedAt = envelope.kind === 'comment.resolvedd' ? (envelope.timestamp ?? Date.now()) : null;
    return { ...state, comments: state.comments.map((c) => c.threadId === threadId ? { ...c, resolvedAt } : c) };
  }

  // Collaboration Phase 5 — live handoff lifecycle. Ephemeral (`sequence: -1`):
  // upsert the handoff into `handoffs` so the UI tracks the baton-pass state.
  if (envelope.kind === 'handoff.update') {
    const incoming = (envelope.payload as { handoff?: RunHandoffView }).handoff;
    if (!incoming || typeof incoming.id !== 'string') return state;
    const rest = state.handoffs.filter((h) => h.id !== incoming.id);
    return { ...state, handoffs: [...rest, incoming].sort((a, b) => a.createdAt - b.createdAt) };
  }

  // Skip already-seen or out-of-order events (idempotent)
  if (envelope.sequence <= state.sequence) return state;

  const p = envelope.payload;
  const next: RunViewModel = {
    ...state,
    sequence: envelope.sequence,
    textChunks: [...state.textChunks],
    widgets: new Map(state.widgets),
    toolCalls: [...state.toolCalls],
    reasoningChunks: [...state.reasoningChunks],
    steps: [...state.steps],
    citations: [...state.citations],
    artifacts: new Map(state.artifacts),
    diagnostics: [...state.diagnostics],
    approvals: [...state.approvals],
    files: [...state.files],
    parts: [...state.parts],
    items: [...state.items],
  };

  switch (envelope.kind) {
    case 'run.started': {
      next.status = 'running';
      const sv: StatusView = { kind: 'status', status: 'running' };
      next.items.push(sv);
      break;
    }

    case 'run.completed': {
      next.status = 'completed';
      const sv: StatusView = { kind: 'status', status: 'completed' };
      next.items.push(sv);
      break;
    }

    case 'run.failed': {
      next.status = 'failed';
      const msg = typeof p['message'] === 'string' ? p['message'] : 'Unknown error';
      const ev: ErrorView = { kind: 'error', code: 'RUN_FAILED', message: msg };
      next.lastError = ev;
      const sv: StatusView = { kind: 'status', status: 'failed', detail: msg };
      next.items.push(sv, ev);
      break;
    }

    case 'run.cancelled': {
      next.status = 'cancelled';
      const sv: StatusView = { kind: 'status', status: 'cancelled' };
      next.items.push(sv);
      break;
    }

    case 'text.delta': {
      const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
      const role = typeof p['role'] === 'string' ? p['role'] : undefined;
      next.fullText = state.fullText + delta;
      const chunk: TextChunk = {
        kind: 'text',
        text: next.fullText,
        delta,
        ...(role !== undefined ? { role } : {}),
      };
      next.textChunks.push(chunk);
      next.items.push(chunk);
      break;
    }

    case 'widget.update': {
      const id = typeof p['id'] === 'string' ? p['id'] : `widget-${envelope.sequence}`;
      const payload = typeof p['payload'] === 'object' && p['payload'] !== null
        ? (p['payload'] as Record<string, unknown>)
        : p;
      const sv = typeof p['schemaVersion'] === 'number' ? p['schemaVersion'] : undefined;
      const wv: WidgetView = {
        kind: 'widget',
        id,
        payload,
        ...(sv !== undefined ? { schemaVersion: sv } : {}),
      };
      next.widgets.set(id, wv);
      next.items.push(wv);
      break;
    }

    case 'tool.invoked': {
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const args = (typeof p['args'] === 'object' && p['args'] !== null)
        ? (p['args'] as Record<string, unknown>) : undefined;
      const tv: ToolCallView = {
        kind: 'tool-call',
        toolName,
        ...(args !== undefined ? { args } : {}),
      };
      next.toolCalls.push(tv);
      next.items.push(tv);
      break;
    }

    case 'tool.completed': {
      // Try to find matching pending tool call (last one with same name)
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const result = p['result'];
      const lastIdx = [...next.toolCalls].reverse().findIndex((tc) => tc.toolName === toolName);
      if (lastIdx !== -1) {
        const realIdx = next.toolCalls.length - 1 - lastIdx;
        next.toolCalls[realIdx] = { ...next.toolCalls[realIdx]!, result };
      } else {
        // Orphan completion (no prior tool.invoked — e.g. a HITL-approved tool
        // whose start frame was suppressed): record the call as completed.
        const tv: ToolCallView = { kind: 'tool-call', toolName, result };
        next.toolCalls.push(tv);
        next.items.push(tv);
      }
      break;
    }

    case 'tool.errored': {
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const errorMsg = typeof p['error'] === 'string' ? p['error'] : 'Tool error';
      const lastIdx = [...next.toolCalls].reverse().findIndex((tc) => tc.toolName === toolName);
      if (lastIdx !== -1) {
        const realIdx = next.toolCalls.length - 1 - lastIdx;
        next.toolCalls[realIdx] = { ...next.toolCalls[realIdx]!, error: errorMsg };
      } else {
        const tv: ToolCallView = { kind: 'tool-call', toolName, error: errorMsg };
        next.toolCalls.push(tv);
        next.items.push(tv);
      }
      break;
    }

    // ── Phase 1 — parity kinds ──

    case 'reasoning.delta': {
      // Accept either `delta` (canonical) or `text` (raw chat-frame shape).
      const delta = typeof p['delta'] === 'string' ? p['delta']
        : typeof p['text'] === 'string' ? p['text'] : '';
      next.reasoningText = state.reasoningText + delta;
      const chunk: ReasoningChunk = { kind: 'reasoning', text: next.reasoningText, delta };
      next.reasoningChunks.push(chunk);
      next.items.push(chunk);
      break;
    }

    case 'usage.update': {
      const num = (k: string): number | undefined => (typeof p[k] === 'number' ? p[k] as number : undefined);
      const str = (k: string): string | undefined => (typeof p[k] === 'string' ? p[k] as string : undefined);
      const uv: UsageView = {
        kind: 'usage',
        ...(num('promptTokens') !== undefined ? { promptTokens: num('promptTokens') } : {}),
        ...(num('completionTokens') !== undefined ? { completionTokens: num('completionTokens') } : {}),
        ...(num('totalTokens') !== undefined ? { totalTokens: num('totalTokens') } : {}),
        ...(num('costUsd') !== undefined ? { costUsd: num('costUsd') } : {}),
        ...(num('latencyMs') !== undefined ? { latencyMs: num('latencyMs') } : {}),
        ...(str('model') !== undefined ? { model: str('model') } : {}),
        ...(str('provider') !== undefined ? { provider: str('provider') } : {}),
        ...(str('mode') !== undefined ? { mode: str('mode') } : {}),
      };
      next.usage = uv;
      next.items.push(uv);
      break;
    }

    case 'step.update': {
      const sv: StepView = {
        kind: 'step',
        ...(typeof p['index'] === 'number' ? { index: p['index'] as number } : {}),
        ...(typeof p['type'] === 'string' ? { type: p['type'] as string } : {}),
        ...(typeof p['content'] === 'string' ? { content: p['content'] as string } : {}),
        ...(typeof p['toolName'] === 'string' ? { toolName: p['toolName'] as string } : {}),
        ...(typeof p['durationMs'] === 'number' ? { durationMs: p['durationMs'] as number } : {}),
        ...(p['phase'] === 'step_start' || p['phase'] === 'step_end' ? { phase: p['phase'] as 'step_start' | 'step_end' } : {}),
      };
      next.steps.push(sv);
      next.items.push(sv);
      break;
    }

    case 'citation.add': {
      const id = typeof p['id'] === 'string' ? p['id'] : `citation-${envelope.sequence}`;
      const cv: CitationView = {
        kind: 'citation', id,
        ...(typeof p['text'] === 'string' ? { text: p['text'] as string } : {}),
        ...(typeof p['source'] === 'string' ? { source: p['source'] as string } : {}),
        ...(typeof p['url'] === 'string' ? { url: p['url'] as string } : {}),
      };
      if (!next.citations.some((c) => c.id === cv.id)) { // dedupe by id
        next.citations.push(cv);
        next.items.push(cv);
      }
      break;
    }

    case 'artifact.update': {
      const id = typeof p['id'] === 'string' ? p['id'] : `artifact-${envelope.sequence}`;
      const av: ArtifactView = {
        kind: 'artifact', id,
        ...(typeof p['type'] === 'string' ? { type: p['type'] as string } : {}),
        ...(typeof p['title'] === 'string' ? { title: p['title'] as string } : {}),
        ...(typeof p['mimeType'] === 'string' ? { mimeType: p['mimeType'] as string } : {}),
        ...(typeof p['url'] === 'string' ? { url: p['url'] as string } : {}),
      };
      next.artifacts.set(id, av); // upsert by id
      next.items.push(av);
      break;
    }

    case 'diagnostic': {
      const channel = typeof p['channel'] === 'string' ? p['channel'] : 'unknown';
      const dv: DiagnosticView = { kind: 'diagnostic', channel, data: p['data'] };
      next.diagnostics.push(dv);
      next.items.push(dv);
      break;
    }

    // ── Phase 4 — human-in-the-loop approval ──

    case 'approval.request': {
      const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : `approval-${envelope.sequence}`;
      const av: ApprovalView = {
        kind: 'approval', taskId, status: 'pending',
        ...(typeof p['toolName'] === 'string' ? { toolName: p['toolName'] as string } : {}),
        ...(typeof p['title'] === 'string' ? { title: p['title'] as string } : {}),
        ...(typeof p['description'] === 'string' ? { description: p['description'] as string } : {}),
        ...(typeof p['riskLevel'] === 'string' ? { riskLevel: p['riskLevel'] as string } : {}),
        ...(Array.isArray(p['actions']) ? { actions: p['actions'] as ApprovalView['actions'] } : {}),
      };
      const idx = next.approvals.findIndex((a) => a.taskId === taskId);
      if (idx >= 0) next.approvals[idx] = av; else next.approvals.push(av);
      next.items.push(av);
      break;
    }

    case 'approval.resolved': {
      const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : '';
      const action = typeof p['action'] === 'string' ? p['action'] : 'reject';
      const status: ApprovalStatus = action === 'approve' ? 'approved' : action === 'modify' ? 'modified' : 'denied';
      const idx = next.approvals.findIndex((a) => a.taskId === taskId);
      if (idx >= 0) next.approvals[idx] = { ...next.approvals[idx]!, status };
      break;
    }

    case 'object.delta': {
      const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
      const text = (state.object?.text ?? '') + delta;
      const parsed = parsePartialJson(extractJsonCandidate(text));
      next.object = { kind: 'object', text, partial: parsed.value, complete: false };
      break;
    }

    case 'object.complete': {
      const text = state.object?.text ?? '';
      // Prefer an explicit server-parsed value; else parse the accumulated text.
      const value = 'value' in p ? p['value'] : parsePartialJson(extractJsonCandidate(text)).value;
      next.object = { kind: 'object', text, partial: value, complete: true, value };
      break;
    }

    case 'file.part': {
      const id = typeof p['id'] === 'string' ? p['id'] : `file-${envelope.sequence}`;
      const fv: FileView = {
        kind: 'file', id,
        mediaType: typeof p['mediaType'] === 'string' ? p['mediaType'] : 'application/octet-stream',
        ...(typeof p['name'] === 'string' ? { name: p['name'] } : {}),
        ...(typeof p['url'] === 'string' ? { url: p['url'] } : {}),
        ...(typeof p['dataBase64'] === 'string' ? { dataBase64: p['dataBase64'] } : {}),
        ...(typeof p['size'] === 'number' ? { size: p['size'] } : {}),
        ...(p['direction'] === 'input' || p['direction'] === 'output' ? { direction: p['direction'] } : {}),
      };
      next.files.push(fv);
      next.items.push(fv);
      break;
    }

    default:
      // Unknown event — just advance sequence, no view change
      break;
  }

  // Phase 2 — maintain the ordered typed `parts[]` from the same event.
  updateParts(next, envelope);

  return next;
}
