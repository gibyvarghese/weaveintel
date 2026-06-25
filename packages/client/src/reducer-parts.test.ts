/**
 * Phase 2 — ordered typed `parts[]` + per-part streaming state machine.
 *
 * Covers text/reasoning streaming→done, the tool lifecycle
 * (input-streaming → input-available → output-available | output-error),
 * partial tool-input accumulation, toolCallId correlation, widget/artifact
 * upsert and citation dedupe as parts, terminal finalization, ordering,
 * idempotency, purity, and stress. Positive, negative, stress, security.
 */
import { describe, it, expect } from 'vitest';
import { streamReducer, emptyRunViewModel } from './index.js';
import type { RunEventEnvelope, RunViewModel, RunPart, ToolPart, TextPart } from './index.js';

let SEQ = 0;
function apply(vm: RunViewModel, kind: string, payload: Record<string, unknown>): RunViewModel {
  return streamReducer(vm, { runId: 'r1', sequence: SEQ++, kind, payload } as RunEventEnvelope);
}
function fresh(): RunViewModel { SEQ = 0; return emptyRunViewModel(); }
const tool = (parts: RunPart[], i = 0): ToolPart => parts.filter((x) => x.type === 'tool')[i] as ToolPart;

// ─── text / reasoning parts ──────────────────────────────────

describe('parts — text & reasoning streaming', () => {
  it('coalesces consecutive text deltas into one streaming part (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'text.delta', { delta: 'Hel' });
    vm = apply(vm, 'text.delta', { delta: 'lo' });
    const text = vm.parts.filter((p) => p.type === 'text');
    expect(text).toHaveLength(1);
    expect((text[0] as TextPart).text).toBe('Hello');
    expect((text[0] as TextPart).state).toBe('streaming');
  });

  it('keeps reasoning and text as SEPARATE ordered parts', () => {
    let vm = fresh();
    vm = apply(vm, 'reasoning.delta', { delta: 'thinking' });
    vm = apply(vm, 'text.delta', { delta: 'answer' });
    vm = apply(vm, 'reasoning.delta', { delta: ' more' }); // new reasoning part (text interrupted)
    expect(vm.parts.map((p) => p.type)).toEqual(['reasoning', 'text', 'reasoning']);
  });

  it('finalizes streaming text/reasoning parts to done on run.completed', () => {
    let vm = fresh();
    vm = apply(vm, 'reasoning.delta', { delta: 'r' });
    vm = apply(vm, 'text.delta', { delta: 't' });
    vm = apply(vm, 'run.completed', {});
    expect(vm.parts.every((p) => (p.type === 'text' || p.type === 'reasoning') ? p.state === 'done' : true)).toBe(true);
  });

  it('also finalizes on run.failed and run.cancelled (negative paths)', () => {
    for (const term of ['run.failed', 'run.cancelled']) {
      let vm = fresh();
      vm = apply(vm, 'text.delta', { delta: 'x' });
      vm = apply(vm, term, {});
      expect((vm.parts.find((p) => p.type === 'text') as TextPart).state).toBe('done');
    }
  });
});

// ─── tool lifecycle state machine ────────────────────────────

describe('parts — tool lifecycle', () => {
  it('input-available → output-available (positive, no partial streaming)', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.invoked', { tool: 'calc', args: { a: 1 }, toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('input-available');
    vm = apply(vm, 'tool.completed', { tool: 'calc', result: 2, toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('output-available');
    expect(tool(vm.parts).result).toBe(2);
  });

  it('full input-streaming → input-available → output-available with partial args', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.input.start', { tool: 'calc', toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('input-streaming');
    vm = apply(vm, 'tool.input.delta', { toolCallId: 't1', delta: '{"a":' });
    vm = apply(vm, 'tool.input.delta', { toolCallId: 't1', delta: '1}' });
    expect(tool(vm.parts).inputText).toBe('{"a":1}');
    vm = apply(vm, 'tool.invoked', { tool: 'calc', args: { a: 1 }, toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('input-available');
    expect(vm.parts.filter((p) => p.type === 'tool')).toHaveLength(1); // upgraded in place, not duplicated
    vm = apply(vm, 'tool.completed', { tool: 'calc', result: 1, toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('output-available');
  });

  it('routes a tool error to output-error (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.invoked', { tool: 'http', toolCallId: 't1' });
    vm = apply(vm, 'tool.errored', { tool: 'http', error: 'timeout', toolCallId: 't1' });
    expect(tool(vm.parts).state).toBe('output-error');
    expect(tool(vm.parts).error).toBe('timeout');
  });

  it('correlates by toolCallId across two concurrent same-name calls', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.invoked', { tool: 'calc', toolCallId: 'A' });
    vm = apply(vm, 'tool.invoked', { tool: 'calc', toolCallId: 'B' });
    vm = apply(vm, 'tool.completed', { tool: 'calc', result: 'rb', toolCallId: 'B' });
    vm = apply(vm, 'tool.errored', { tool: 'calc', error: 'ea', toolCallId: 'A' });
    const a = vm.parts.find((p) => p.type === 'tool' && p.toolCallId === 'A') as ToolPart;
    const b = vm.parts.find((p) => p.type === 'tool' && p.toolCallId === 'B') as ToolPart;
    expect(a.state).toBe('output-error');
    expect(b.state).toBe('output-available');
    expect(b.result).toBe('rb');
  });

  it('falls back to name correlation when no toolCallId is supplied (negative)', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.invoked', { tool: 'calc' });
    vm = apply(vm, 'tool.completed', { tool: 'calc', result: 9 });
    expect(tool(vm.parts).state).toBe('output-available');
    expect(tool(vm.parts).result).toBe(9);
  });

  it('surfaces an orphan completion (no prior invoke) as a finished tool part (HITL-gated tools)', () => {
    let vm = fresh();
    vm = apply(vm, 'tool.completed', { tool: 'calculator', result: 42, toolCallId: 'tc-x' });
    const t = vm.parts.filter((p) => p.type === 'tool') as ToolPart[];
    expect(t).toHaveLength(1);
    expect(t[0]!.state).toBe('output-available');
    expect(t[0]!.result).toBe(42);
    expect(vm.toolCalls).toHaveLength(1); // also reflected in the legacy view
  });
});

// ─── widget / artifact / citation parts ──────────────────────

describe('parts — widget/artifact/citation', () => {
  it('upserts a widget part by widgetId', () => {
    let vm = fresh();
    vm = apply(vm, 'widget.update', { id: 'w1', payload: { v: 1 } });
    vm = apply(vm, 'widget.update', { id: 'w1', payload: { v: 2 } });
    const widgets = vm.parts.filter((p) => p.type === 'widget');
    expect(widgets).toHaveLength(1);
  });

  it('upserts an artifact part and dedupes citations by id', () => {
    let vm = fresh();
    vm = apply(vm, 'artifact.update', { id: 'a1', title: 'v1' });
    vm = apply(vm, 'artifact.update', { id: 'a1', title: 'v2' });
    vm = apply(vm, 'citation.add', { id: 'c1' });
    vm = apply(vm, 'citation.add', { id: 'c1' });
    expect(vm.parts.filter((p) => p.type === 'artifact')).toHaveLength(1);
    expect(vm.parts.filter((p) => p.type === 'citation')).toHaveLength(1);
  });
});

// ─── ordering / idempotency / purity / stress ────────────────

describe('parts — integration', () => {
  it('preserves part order across mixed channels', () => {
    let vm = fresh();
    vm = apply(vm, 'reasoning.delta', { delta: 'r' });
    vm = apply(vm, 'tool.invoked', { tool: 'calc', toolCallId: 't1' });
    vm = apply(vm, 'step.update', { index: 0 });
    vm = apply(vm, 'text.delta', { delta: 't' });
    vm = apply(vm, 'tool.completed', { tool: 'calc', result: 1, toolCallId: 't1' });
    expect(vm.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'step', 'text']);
  });

  it('ignores duplicate sequence for parts (idempotent)', () => {
    let vm = emptyRunViewModel();
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'text.delta', payload: { delta: 'a' } });
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'text.delta', payload: { delta: 'a' } });
    expect((vm.parts[0] as TextPart).text).toBe('a');
  });

  it('does not mutate the prior state parts (purity)', () => {
    const base = fresh();
    const after = apply(base, 'text.delta', { delta: 'x' });
    expect(base.parts).toHaveLength(0);
    expect(after.parts).toHaveLength(1);
  });

  it('stress: 4000 events build a bounded, well-formed parts list', () => {
    let vm = fresh();
    for (let i = 0; i < 1000; i++) {
      vm = apply(vm, 'tool.invoked', { tool: 'calc', toolCallId: `t${i}` });
      vm = apply(vm, 'tool.completed', { tool: 'calc', result: i, toolCallId: `t${i}` });
      vm = apply(vm, 'text.delta', { delta: '.' });
      vm = apply(vm, 'reasoning.delta', { delta: '_' });
    }
    vm = apply(vm, 'run.completed', {});
    const tools = vm.parts.filter((p) => p.type === 'tool') as ToolPart[];
    expect(tools).toHaveLength(1000);
    expect(tools.every((t) => t.state === 'output-available')).toBe(true);
    // Text deltas are interrupted by tool/reasoning parts each loop → 1000 text parts, all done.
    const texts = vm.parts.filter((p) => p.type === 'text') as TextPart[];
    expect(texts.length).toBe(1000);
    expect(texts.every((t) => t.state === 'done')).toBe(true);
  });
});
