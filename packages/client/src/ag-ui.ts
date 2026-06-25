/**
 * AG-UI wire adapter (Phase 7, optional) — translate a weaveIntel run-event
 * journal into the AG-UI (Agent-User Interaction) protocol event stream so an
 * off-the-shelf AG-UI client can consume a run.
 *
 * This is a PURE batch transform over `RunEventEnvelope[]`: it tracks the small
 * amount of cross-event state the protocol needs (emit `TEXT_MESSAGE_START`
 * once, balance `TOOL_CALL_START`/`END`, close the open text message before a
 * terminal event) and returns the AG-UI events in order. No transport, no I/O.
 *
 * Reference: AG-UI canonical event types (mid-2026).
 *
 * Browser-safe: no Node.js APIs.
 */
import type { RunEventEnvelope } from '@weaveintel/core';

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
  | 'STATE_SNAPSHOT';

export interface AGUIEvent {
  type: AGUIEventType;
  [key: string]: unknown;
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  return typeof p[k] === 'string' ? (p[k] as string) : undefined;
}

/**
 * Convert a run-event journal (or any in-order batch) to AG-UI protocol events.
 * The assistant text is modelled as a single AG-UI message (`messageId`
 * `msg-<runId>`); the structured object is surfaced as `STATE_DELTA`/
 * `STATE_SNAPSHOT`.
 */
export function toAGUIEvents(envelopes: RunEventEnvelope[]): AGUIEvent[] {
  const out: AGUIEvent[] = [];
  if (envelopes.length === 0) return out;

  const runId = envelopes[0]!.runId;
  const messageId = `msg-${runId}`;
  let textOpen = false;
  const openToolCalls = new Set<string>();

  const closeText = (): void => {
    if (textOpen) {
      out.push({ type: 'TEXT_MESSAGE_END', messageId });
      textOpen = false;
    }
  };

  for (const env of envelopes) {
    const p = env.payload;
    switch (env.kind) {
      case 'run.started':
        out.push({ type: 'RUN_STARTED', runId, threadId: runId });
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
