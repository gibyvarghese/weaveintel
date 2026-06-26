/**
 * Unit tests — toAGUIEvents (optional AG-UI wire adapter).
 * mapping · message lifecycle · tool calls · object state · negative.
 */
import { describe, it, expect } from 'vitest';
import { toAGUIEvents, type AGUIEvent } from './ag-ui.js';
import type { RunEventEnvelope } from '@weaveintel/core';

let seq = 0;
function ev(kind: string, payload: Record<string, unknown> = {}): RunEventEnvelope {
  return { runId: 'run-7', sequence: seq++, kind, payload } as RunEventEnvelope;
}
function types(events: AGUIEvent[]): string[] { return events.map((e) => e.type); }
function reset() { seq = 0; }

describe('toAGUIEvents', () => {
  it('returns nothing for an empty journal', () => {
    expect(toAGUIEvents([])).toEqual([]);
  });

  it('maps a basic text run to a well-formed AG-UI message lifecycle', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('text.delta', { delta: 'Hello ' }),
      ev('text.delta', { delta: 'world' }),
      ev('run.completed'),
    ]);
    expect(types(out)).toEqual([
      'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
    ]);
    // START appears exactly once and CONTENT carries the deltas.
    expect(out.filter((e) => e.type === 'TEXT_MESSAGE_START')).toHaveLength(1);
    expect(out.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e['delta'])).toEqual(['Hello ', 'world']);
  });

  it('maps tool calls to START/ARGS/END/RESULT', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('tool.invoked', { tool: 'calc', args: { a: 1 }, toolCallId: 'tc1' }),
      ev('tool.completed', { tool: 'calc', result: { value: 2 }, toolCallId: 'tc1' }),
      ev('run.completed'),
    ]);
    expect(types(out)).toEqual(['RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_FINISHED']);
    expect(out.find((e) => e.type === 'TOOL_CALL_START')).toMatchObject({ toolCallId: 'tc1', toolCallName: 'calc' });
    expect(out.find((e) => e.type === 'TOOL_CALL_ARGS')!['delta']).toBe('{"a":1}');
    expect(out.find((e) => e.type === 'TOOL_CALL_RESULT')!['content']).toBe('{"value":2}');
  });

  it('maps reasoning to THINKING and a structured object to STATE_DELTA/SNAPSHOT', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('reasoning.delta', { delta: 'hmm' }),
      ev('object.delta', { delta: '{"a":' }),
      ev('object.delta', { delta: '1}' }),
      ev('object.complete', { value: { a: 1 } }),
      ev('run.completed'),
    ]);
    expect(out.find((e) => e.type === 'THINKING_TEXT_MESSAGE_CONTENT')!['delta']).toBe('hmm');
    expect(out.filter((e) => e.type === 'STATE_DELTA').map((e) => e['delta'])).toEqual(['{"a":', '1}']);
    expect(out.find((e) => e.type === 'STATE_SNAPSHOT')!['snapshot']).toEqual({ a: 1 });
  });

  it('closes the open text message before a terminal even without explicit end', () => {
    reset();
    const out = toAGUIEvents([ev('text.delta', { delta: 'hi' }), ev('run.completed')]);
    // END comes before FINISHED.
    expect(types(out)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  });

  it('maps run.failed to RUN_ERROR with the message', () => {
    reset();
    const out = toAGUIEvents([ev('run.started'), ev('run.failed', { message: 'boom' })]);
    expect(out.find((e) => e.type === 'RUN_ERROR')).toMatchObject({ message: 'boom' });
  });

  it('marks a cancelled run finished with cancelled:true', () => {
    reset();
    const out = toAGUIEvents([ev('run.started'), ev('run.cancelled')]);
    expect(out.find((e) => e.type === 'RUN_FINISHED')).toMatchObject({ cancelled: true });
  });

  it('closes a dangling open message when the journal is truncated mid-run', () => {
    reset();
    const out = toAGUIEvents([ev('run.started'), ev('text.delta', { delta: 'partial' })]);
    expect(types(out)).toContain('TEXT_MESSAGE_END'); // defensive close
  });

  it('uses a stable messageId derived from the runId', () => {
    reset();
    const out = toAGUIEvents([ev('text.delta', { delta: 'x' }), ev('run.completed')]);
    expect(out.find((e) => e.type === 'TEXT_MESSAGE_START')!['messageId']).toBe('msg-run-7');
  });
});

import { applyJsonPatch } from '@weaveintel/core';

describe('toAGUIEvents — collaboration as shared STATE (Phase 6)', () => {
  it('emits STATE_SNAPSHOT once, then STATE_DELTA + CUSTOM for presence', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('presence.update', { participants: [{ userId: 'a', presence: 'online' }] }),
    ]);
    expect(types(out)).toContain('STATE_SNAPSHOT');
    expect(types(out)).toContain('STATE_DELTA');
    const custom = out.find((e) => e.type === 'CUSTOM');
    expect(custom!['name']).toBe('presence');
    // Exactly one snapshot even across multiple state changes.
    expect(types(out).filter((t) => t === 'STATE_SNAPSHOT').length).toBe(1);
  });

  it('STATE_DELTA is a valid JSON Patch that reconstructs the snapshot state', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('presence.update', { participants: [{ userId: 'a' }] }),
      ev('handoff.update', { handoff: { id: 'h1', state: 'requested' } }),
    ]);
    // Replay: start from the snapshot, apply each delta in order → final state.
    const snapshot = out.find((e) => e.type === 'STATE_SNAPSHOT')!['snapshot'] as Record<string, unknown>;
    let doc: unknown = snapshot;
    for (const e of out) {
      if (e.type === 'STATE_DELTA') {
        const res = applyJsonPatch(doc, e['delta'] as never);
        expect(res.ok).toBe(true);
        doc = res.doc;
      }
    }
    expect(doc).toMatchObject({ presence: [{ userId: 'a' }], handoffs: [{ id: 'h1', state: 'requested' }] });
  });

  it('emits a CUSTOM signal for handoff, comment add/delete, and access.revoked', () => {
    reset();
    const out = toAGUIEvents([
      ev('run.started'),
      ev('handoff.update', { handoff: { id: 'h1', state: 'accepted' } }),
      ev('comment.added', { comment: { id: 'c1', threadId: 'c1' } }),
      ev('comment.deleted', { id: 'c1' }),
      ev('access.revoked', { reason: 'removed' }),
    ]);
    const customs = out.filter((e) => e.type === 'CUSTOM').map((e) => e['name']);
    expect(customs).toEqual(['handoff', 'comment', 'comment', 'access.revoked']);
  });

  it('does not emit collaboration state for a plain text run (back-compat)', () => {
    reset();
    const out = toAGUIEvents([ev('run.started'), ev('text.delta', { delta: 'hi' }), ev('run.completed')]);
    expect(types(out)).not.toContain('STATE_DELTA');
    expect(types(out)).not.toContain('CUSTOM');
    expect(types(out)).not.toContain('STATE_SNAPSHOT');
  });
});
