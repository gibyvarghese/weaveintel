/**
 * AG-UI wire adapter — translate a weaveIntel run-event journal into the AG-UI
 * (Agent-User Interaction) protocol event stream so an off-the-shelf AG-UI client
 * can consume a run, INCLUDING the collaboration signals (presence, comments,
 * handoffs) as shared STATE (Collaboration Phase 6).
 *
 * This is a PURE batch transform over `RunEventEnvelope[]`: it tracks the small
 * amount of cross-event state the protocol needs (emit `TEXT_MESSAGE_START`
 * once, balance `TOOL_CALL_START`/`END`, close the open text message before a
 * terminal event) and returns the AG-UI events in order. No transport, no I/O.
 *
 * --- For someone new to this ---
 * AG-UI is a small standard set of event names a UI understands (text started,
 * tool called, run finished, …). Phase 6 adds the multiplayer signals on top in
 * the AG-UI-conformant way: instead of inventing new event names, weaveIntel keeps
 * a small SHARED STATE object `{ status, presence, comments, handoffs }` and emits
 * a `STATE_SNAPSHOT` once, then a `STATE_DELTA` (a JSON Patch — a tiny list of
 * edits) whenever it changes. Each raw signal is ALSO emitted as a `CUSTOM` event
 * so simpler clients can react without tracking state. This is exactly the
 * mid-2026 AG-UI recommendation: carry non-standard signals via `CUSTOM`, carry
 * evolving shared data via `STATE_SNAPSHOT` + `STATE_DELTA` (RFC 6902 JSON Patch).
 *
 * Browser-safe: no Node.js APIs.
 */
import type { RunEventEnvelope, JsonPatch } from '@weaveintel/core';
import { diffJsonPatch } from '@weaveintel/core';

export type AGUIEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'THINKING_TEXT_MESSAGE_CONTENT'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_DELTA'
  | 'STATE_SNAPSHOT'
  | 'CUSTOM';

export interface AGUIEvent {
  type: AGUIEventType;
  [key: string]: unknown;
}

/** The collaborative shared-state object carried over AG-UI STATE_* events. */
export interface AGUICollabState {
  status: string;
  presence: unknown[];
  comments: unknown[];
  handoffs: unknown[];
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  return typeof p[k] === 'string' ? (p[k] as string) : undefined;
}
function arr(p: Record<string, unknown>, k: string): unknown[] {
  return Array.isArray(p[k]) ? (p[k] as unknown[]) : [];
}

/**
 * Convert a run-event journal (or any in-order batch) to AG-UI protocol events.
 * The assistant text is modelled as a single AG-UI message (`messageId`
 * `msg-<runId>`); the structured object + collaboration signals are surfaced as
 * `STATE_SNAPSHOT`/`STATE_DELTA` (+ `CUSTOM` for each raw collaboration signal).
 */
export function toAGUIEvents(envelopes: RunEventEnvelope[]): AGUIEvent[] {
  const out: AGUIEvent[] = [];
  if (envelopes.length === 0) return out;

  const runId = envelopes[0]!.runId;
  const messageId = `msg-${runId}`;
  let textOpen = false;
  const openToolCalls = new Set<string>();

  // Collaborative shared state — seeded by a STATE_SNAPSHOT, evolved by STATE_DELTA.
  let state: AGUICollabState = { status: 'running', presence: [], comments: [], handoffs: [] };
  let snapshotEmitted = false;

  const closeText = (): void => {
    if (textOpen) {
      out.push({ type: 'TEXT_MESSAGE_END', messageId });
      textOpen = false;
    }
  };

  /** Ensure the initial STATE_SNAPSHOT has been emitted (once, after RUN_STARTED). */
  const ensureSnapshot = (): void => {
    if (snapshotEmitted) return;
    out.push({ type: 'STATE_SNAPSHOT', snapshot: { ...state, presence: [...state.presence], comments: [...state.comments], handoffs: [...state.handoffs] } });
    snapshotEmitted = true;
  };

  /** Transition the shared state and emit a STATE_DELTA (JSON Patch) + a CUSTOM signal. */
  const mutateState = (next: AGUICollabState, customName: string, customValue: unknown): void => {
    ensureSnapshot();
    const patch: JsonPatch = diffJsonPatch(state, next);
    if (patch.length > 0) out.push({ type: 'STATE_DELTA', delta: patch });
    state = next;
    out.push({ type: 'CUSTOM', name: customName, value: customValue });
  };

  for (const env of envelopes) {
    const p = env.payload;
    switch (env.kind) {
      case 'run.started':
        out.push({ type: 'RUN_STARTED', runId, threadId: runId });
        // Snapshot is emitted LAZILY on the first collaboration signal, so a plain
        // (non-collaborative) run produces the exact same AG-UI stream as before.
        break;

      // ── Collaboration Phase 6 — multiplayer signals as shared state + CUSTOM ──
      case 'presence.update':
        mutateState({ ...state, presence: arr(p, 'participants') }, 'presence', { participants: arr(p, 'participants') });
        break;
      case 'handoff.update': {
        const handoff = p['handoff'] as { id?: string } | undefined;
        if (handoff && typeof handoff.id === 'string') {
          const rest = state.handoffs.filter((h) => (h as { id?: string }).id !== handoff.id);
          mutateState({ ...state, handoffs: [...rest, handoff] }, 'handoff', handoff);
        }
        break;
      }
      case 'comment.added':
      case 'comment.updated': {
        const comment = p['comment'] as { id?: string } | undefined;
        if (comment && typeof comment.id === 'string') {
          const rest = state.comments.filter((c) => (c as { id?: string }).id !== comment.id);
          mutateState({ ...state, comments: [...rest, comment] }, 'comment', { action: env.kind, comment });
        }
        break;
      }
      case 'comment.deleted': {
        const id = str(p, 'id');
        if (id) mutateState({ ...state, comments: state.comments.filter((c) => (c as { id?: string }).id !== id) }, 'comment', { action: 'comment.deleted', id });
        break;
      }
      case 'comment.resolvedd':
      case 'comment.reopenedd':
        // Thread-level resolve/reopen — surfaced as a CUSTOM signal (the comment
        // state is reconciled by the next comment.* snapshot from the server).
        out.push({ type: 'CUSTOM', name: 'comment', value: { action: env.kind, threadId: str(p, 'threadId') } });
        break;

      case 'access.revoked':
        out.push({ type: 'CUSTOM', name: 'access.revoked', value: { reason: str(p, 'reason') ?? 'access revoked' } });
        break;

      case 'text.delta': {
        const delta = str(p, 'delta') ?? '';
        if (!textOpen) { out.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }); textOpen = true; }
        out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
        break;
      }

      case 'reasoning.delta':
        out.push({ type: 'THINKING_TEXT_MESSAGE_CONTENT', delta: str(p, 'delta') ?? '' });
        break;

      case 'tool.invoked': {
        const toolCallId = str(p, 'toolCallId') ?? `tc-${env.sequence}`;
        const toolCallName = str(p, 'tool') ?? 'unknown';
        out.push({ type: 'TOOL_CALL_START', toolCallId, toolCallName });
        if (p['args'] !== undefined) {
          out.push({ type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(p['args']) });
        }
        openToolCalls.add(toolCallId);
        break;
      }

      case 'tool.completed': {
        const toolCallId = str(p, 'toolCallId') ?? `tc-${env.sequence}`;
        out.push({ type: 'TOOL_CALL_END', toolCallId });
        out.push({ type: 'TOOL_CALL_RESULT', toolCallId, content: JSON.stringify(p['result'] ?? null) });
        openToolCalls.delete(toolCallId);
        break;
      }

      case 'tool.errored': {
        const toolCallId = str(p, 'toolCallId') ?? `tc-${env.sequence}`;
        out.push({ type: 'TOOL_CALL_END', toolCallId });
        out.push({ type: 'TOOL_CALL_RESULT', toolCallId, content: JSON.stringify({ error: str(p, 'error') ?? 'tool error' }) });
        openToolCalls.delete(toolCallId);
        break;
      }

      case 'object.delta':
        out.push({ type: 'STATE_DELTA', delta: str(p, 'delta') ?? '' });
        break;

      case 'object.complete':
        if ('value' in p) out.push({ type: 'STATE_SNAPSHOT', snapshot: p['value'] });
        break;

      case 'run.completed':
        closeText();
        out.push({ type: 'RUN_FINISHED', runId });
        break;

      case 'run.cancelled':
        closeText();
        out.push({ type: 'RUN_FINISHED', runId, cancelled: true });
        break;

      case 'run.failed':
        closeText();
        out.push({ type: 'RUN_ERROR', message: str(p, 'message') ?? 'run failed' });
        break;

      // reasoning/step/widget/citation/artifact/approval/file/usage have no
      // 1:1 AG-UI mapping in this minimal adapter and are intentionally skipped.
      default:
        break;
    }
  }

  // Defensive: if the journal was truncated mid-run, still close an open message.
  closeText();
  return out;
}
