/**
 * Phase 1 — reducer parity for the previously-dropped channels.
 *
 * reasoning (distinct from text), usage/cost, agent steps, citations,
 * artifacts, and diagnostics now reconstruct into the RunViewModel.
 * Positive, negative, stress, and security cases.
 */
import { describe, it, expect } from 'vitest';
import { streamReducer, emptyRunViewModel } from './index.js';
import type { RunEventEnvelope, RunViewModel, UsageView } from './index.js';

let SEQ = 0;
function apply(vm: RunViewModel, kind: string, payload: Record<string, unknown>): RunViewModel {
  return streamReducer(vm, { runId: 'r1', sequence: SEQ++, kind, payload } as RunEventEnvelope);
}
function fresh(): RunViewModel { SEQ = 0; return emptyRunViewModel(); }

// ─── reasoning (distinct channel) ────────────────────────────

describe('reducer parity — reasoning', () => {
  it('accumulates reasoning separately from fullText (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'reasoning.delta', { delta: 'Let me think' });
    vm = apply(vm, 'reasoning.delta', { delta: ' about it.' });
    vm = apply(vm, 'text.delta', { delta: 'The answer is 42.' });
    expect(vm.reasoningText).toBe('Let me think about it.');
    expect(vm.reasoningChunks).toHaveLength(2);
    expect(vm.fullText).toBe('The answer is 42.'); // reasoning NOT leaked into the answer
  });

  it('accepts the raw chat-frame `text` field as the reasoning delta (compat)', () => {
    let vm = fresh();
    vm = apply(vm, 'reasoning.delta', { text: 'hmm' });
    expect(vm.reasoningText).toBe('hmm');
  });
});

// ─── usage / cost ────────────────────────────────────────────

describe('reducer parity — usage', () => {
  it('captures token usage, cost, model (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'usage.update', { promptTokens: 12, completionTokens: 8, totalTokens: 20, costUsd: 0.0003, latencyMs: 540, model: 'gpt-4o-mini', provider: 'openai', mode: 'agent' });
    const u = vm.usage as UsageView;
    expect(u.totalTokens).toBe(20);
    expect(u.costUsd).toBeCloseTo(0.0003, 6);
    expect(u.model).toBe('gpt-4o-mini');
    expect(u.mode).toBe('agent');
  });

  it('ignores non-numeric/non-string fields without crashing (negative/security)', () => {
    let vm = fresh();
    vm = apply(vm, 'usage.update', { promptTokens: 'lots', model: 42, totalTokens: 5 });
    expect(vm.usage!.totalTokens).toBe(5);
    expect(vm.usage!.promptTokens).toBeUndefined(); // bad type dropped
    expect(vm.usage!.model).toBeUndefined();
  });

  it('a later usage.update replaces the earlier snapshot', () => {
    let vm = fresh();
    vm = apply(vm, 'usage.update', { totalTokens: 5 });
    vm = apply(vm, 'usage.update', { totalTokens: 25 });
    expect(vm.usage!.totalTokens).toBe(25);
  });
});

// ─── steps ───────────────────────────────────────────────────

describe('reducer parity — steps', () => {
  it('appends agent steps with tool name + phase (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'step.update', { index: 0, type: 'tool_call', toolName: 'web_search', durationMs: 120, phase: 'step_end' });
    vm = apply(vm, 'step.update', { index: 1, type: 'response', phase: 'step_end' });
    expect(vm.steps).toHaveLength(2);
    expect(vm.steps[0]!.toolName).toBe('web_search');
    expect(vm.steps[0]!.phase).toBe('step_end');
  });

  it('rejects an invalid phase value (security/robustness)', () => {
    let vm = fresh();
    vm = apply(vm, 'step.update', { index: 0, phase: 'not-a-phase' });
    expect(vm.steps[0]!.phase).toBeUndefined();
  });
});

// ─── citations (dedupe) ──────────────────────────────────────

describe('reducer parity — citations', () => {
  it('appends citations and dedupes by id (security: no flooding by repeat id)', () => {
    let vm = fresh();
    vm = apply(vm, 'citation.add', { id: 'c1', source: 'doc', url: 'https://x' });
    vm = apply(vm, 'citation.add', { id: 'c1', source: 'doc-dup' }); // same id → ignored
    vm = apply(vm, 'citation.add', { id: 'c2', source: 'web' });
    expect(vm.citations).toHaveLength(2);
    expect(vm.citations.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

// ─── artifacts (upsert) ──────────────────────────────────────

describe('reducer parity — artifacts', () => {
  it('upserts artifacts by id (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'artifact.update', { id: 'a1', title: 'Chart v1', mimeType: 'image/svg+xml' });
    vm = apply(vm, 'artifact.update', { id: 'a1', title: 'Chart v2' });
    expect(vm.artifacts.size).toBe(1);
    expect(vm.artifacts.get('a1')!.title).toBe('Chart v2');
  });

  it('synthesises an id when none is supplied (negative)', () => {
    let vm = fresh();
    vm = apply(vm, 'artifact.update', { title: 'anon' });
    expect(vm.artifacts.size).toBe(1);
  });
});

// ─── diagnostics ─────────────────────────────────────────────

describe('reducer parity — diagnostics', () => {
  it('records guardrail/eval diagnostics by channel (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'diagnostic', { channel: 'guardrail', data: { decision: 'allow' } });
    vm = apply(vm, 'diagnostic', { channel: 'eval', data: { score: 0.9 } });
    expect(vm.diagnostics).toHaveLength(2);
    expect(vm.diagnostics[0]!.channel).toBe('guardrail');
  });
});

// ─── back-compat + ordering + idempotency + stress ───────────

describe('reducer parity — integration', () => {
  it('preserves all parity items in linear event order (items[])', () => {
    let vm = fresh();
    vm = apply(vm, 'run.started', {});
    vm = apply(vm, 'reasoning.delta', { delta: 'think' });
    vm = apply(vm, 'step.update', { index: 0, type: 'response' });
    vm = apply(vm, 'text.delta', { delta: 'hello' });
    vm = apply(vm, 'usage.update', { totalTokens: 3 });
    vm = apply(vm, 'run.completed', {});
    const kinds = vm.items.map((i) => i.kind);
    expect(kinds).toEqual(['status', 'reasoning', 'step', 'text', 'usage', 'status']);
  });

  it('ignores a duplicate sequence for parity kinds (idempotent)', () => {
    let vm = emptyRunViewModel();
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'reasoning.delta', payload: { delta: 'a' } });
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'reasoning.delta', payload: { delta: 'a' } }); // dup
    expect(vm.reasoningText).toBe('a');
    expect(vm.reasoningChunks).toHaveLength(1);
  });

  it('stress: 5000 interleaved parity events stay ordered, bounded, monotonic', () => {
    let vm = fresh();
    for (let i = 0; i < 5000; i++) {
      const k = i % 5;
      if (k === 0) vm = apply(vm, 'reasoning.delta', { delta: 'r' });
      else if (k === 1) vm = apply(vm, 'step.update', { index: i });
      else if (k === 2) vm = apply(vm, 'text.delta', { delta: 't' });
      else if (k === 3) vm = apply(vm, 'diagnostic', { channel: 'eval' });
      else vm = apply(vm, 'artifact.update', { id: `a${i}` });
    }
    expect(vm.reasoningText).toHaveLength(1000);
    expect(vm.steps).toHaveLength(1000);
    expect(vm.fullText).toHaveLength(1000);
    expect(vm.diagnostics).toHaveLength(1000);
    expect(vm.artifacts.size).toBe(1000);
    expect(vm.sequence).toBe(4999);
  });

  it('does not mutate the input state (purity)', () => {
    const base = fresh();
    const next = apply(base, 'reasoning.delta', { delta: 'x' });
    expect(base.reasoningText).toBe('');
    expect(base.reasoningChunks).toHaveLength(0);
    expect(next).not.toBe(base);
  });
});
