/**
 * Phase 1 — chat→run bridge (SseCaptureResponse) lossless mapping.
 *
 * Feeds the bridge the SSE frames the ChatEngine writes and asserts every
 * channel is mirrored onto the MeRunEmitter (reasoning distinct from text,
 * steps, usage/cost from `done`, artifacts, tool errors, diagnostics) instead
 * of being dropped. Positive, negative, stress, and security cases.
 */
import { describe, it, expect } from 'vitest';
import { SseCaptureResponse } from './me-run-agent.js';
import type { MeRunEmitter } from './me-run-executor.js';
import type { RunStep, RunUsage, RunArtifactRef } from '@weaveintel/core';

interface Recorded {
  text: Array<{ delta: string; role?: string }>;
  reasoning: string[];
  toolInvoked: Array<{ tool: string; args?: Record<string, unknown>; toolCallId?: string }>;
  toolCompleted: Array<{ tool: string; result: unknown; toolCallId?: string }>;
  toolErrored: Array<{ tool: string; error: string; toolCallId?: string }>;
  toolInputStart: Array<{ toolCallId: string; tool: string }>;
  toolInputDelta: Array<{ toolCallId: string; delta: string }>;
  step: RunStep[];
  usage: RunUsage[];
  citation: unknown[];
  artifact: RunArtifactRef[];
  diagnostic: Array<{ channel: string; data?: unknown }>;
  widget: unknown[];
}

function recorder(): { emitter: MeRunEmitter; rec: Recorded } {
  const rec: Recorded = { text: [], reasoning: [], toolInvoked: [], toolCompleted: [], toolErrored: [], toolInputStart: [], toolInputDelta: [], step: [], usage: [], citation: [], artifact: [], diagnostic: [], widget: [] };
  const emitter: MeRunEmitter = {
    text: async (delta, role) => { rec.text.push({ delta, ...(role ? { role } : {}) }); },
    toolInvoked: async (tool, args, toolCallId) => { rec.toolInvoked.push({ tool, ...(args ? { args } : {}), ...(toolCallId ? { toolCallId } : {}) }); },
    toolCompleted: async (tool, result, toolCallId) => { rec.toolCompleted.push({ tool, result, ...(toolCallId ? { toolCallId } : {}) }); },
    toolErrored: async (tool, error, toolCallId) => { rec.toolErrored.push({ tool, error, ...(toolCallId ? { toolCallId } : {}) }); },
    widget: async (id) => { rec.widget.push(id); },
    reasoning: async (delta) => { rec.reasoning.push(delta); },
    step: async (step) => { rec.step.push(step); },
    usage: async (usage) => { rec.usage.push(usage); },
    citation: async (c) => { rec.citation.push(c); },
    artifact: async (a) => { rec.artifact.push(a); },
    diagnostic: async (channel, data) => { rec.diagnostic.push({ channel, data }); },
    toolInputStart: async (toolCallId, tool) => { rec.toolInputStart.push({ toolCallId, tool }); },
    toolInputDelta: async (toolCallId, delta) => { rec.toolInputDelta.push({ toolCallId, delta }); },
  };
  return { emitter, rec };
}

function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function feed(frames: Array<Record<string, unknown>>): Promise<Recorded> {
  const { emitter, rec } = recorder();
  const cap = new SseCaptureResponse(emitter);
  for (const f of frames) cap.write(frame(f));
  await cap.drain();
  return rec;
}

// ─── positive ────────────────────────────────────────────────

describe('bridge — lossless mapping (positive)', () => {
  it('maps reasoning to a DISTINCT channel (not text)', async () => {
    const rec = await feed([{ type: 'reasoning', text: 'thinking...' }, { type: 'text', text: 'answer' }]);
    expect(rec.reasoning).toEqual(['thinking...']);
    expect(rec.text).toEqual([{ delta: 'answer' }]);
  });

  it('maps step frames with tool name + phase', async () => {
    const rec = await feed([{ type: 'step', phase: 'step_end', step: { index: 0, type: 'tool_call', content: 'searching', toolCall: { name: 'web_search' }, durationMs: 120 } }]);
    expect(rec.step).toHaveLength(1);
    expect(rec.step[0]).toMatchObject({ index: 0, type: 'tool_call', toolName: 'web_search', durationMs: 120, phase: 'step_end' });
  });

  it('maps the done frame to usage (cost→costUsd) + artifact refs', async () => {
    const rec = await feed([{
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      cost: 0.0007, latencyMs: 800, model: 'gpt-4o-mini', provider: 'openai', mode: 'agent',
      artifactRefs: [{ id: 'art-1', type: 'chart', title: 'Sales', mimeType: 'image/svg+xml' }, { artifactId: 'art-2', name: 'Table' }],
    }]);
    expect(rec.usage[0]).toMatchObject({ promptTokens: 10, totalTokens: 15, costUsd: 0.0007, latencyMs: 800, model: 'gpt-4o-mini', mode: 'agent' });
    expect(rec.artifact).toHaveLength(2);
    expect(rec.artifact[0]).toMatchObject({ id: 'art-1', type: 'chart', title: 'Sales' });
    expect(rec.artifact[1]).toMatchObject({ id: 'art-2', title: 'Table' }); // artifactId + name fallbacks
  });

  it('maps tool_start/tool_end normally', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { a: 1 } },
      { type: 'tool_end', name: 'calc', result: { value: 2 } },
    ]);
    expect(rec.toolInvoked[0]).toMatchObject({ tool: 'calc', args: { a: 1 } });
    expect(rec.toolCompleted[0]).toMatchObject({ tool: 'calc', result: { value: 2 } });
    expect(rec.toolErrored).toHaveLength(0);
  });

  it('surfaces guardrail/eval/policy frames as diagnostics (no longer dropped)', async () => {
    const rec = await feed([
      { type: 'guardrail', decision: 'allow', reason: 'ok' },
      { type: 'eval', score: 0.9 },
      { type: 'policy_checks', checks: [] },
      { type: 'ensemble_result', winner: 'a' },
    ]);
    expect(rec.diagnostic.map((d) => d.channel)).toEqual(['guardrail', 'eval', 'policy_checks', 'ensemble_result']);
    expect((rec.diagnostic[0]!.data as Record<string, unknown>)['decision']).toBe('allow');
    expect((rec.diagnostic[0]!.data as Record<string, unknown>)['type']).toBeUndefined(); // type stripped from data
  });
});

// ─── tool errors ─────────────────────────────────────────────

describe('bridge — real tool.errored path', () => {
  it('routes a tool_end whose result carries an error to toolErrored', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'http', result: { error: 'timeout' } }]);
    expect(rec.toolErrored).toHaveLength(1);
    expect(rec.toolErrored[0]).toMatchObject({ tool: 'http', error: 'timeout' });
    expect(rec.toolErrored[0]!.toolCallId).toBeDefined();
    expect(rec.toolCompleted).toHaveLength(0);
  });

  it('a successful result with no error string is a normal completion', async () => {
    const rec = await feed([{ type: 'tool_end', name: 'http', result: { status: 200 } }]);
    expect(rec.toolCompleted).toHaveLength(1);
    expect(rec.toolErrored).toHaveLength(0);
  });
});

// ─── Phase 2 — tool-call id correlation ──────────────────────

describe('bridge — toolCallId correlation (Phase 2)', () => {
  it('assigns a stable id on tool_start and reuses it on tool_end', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { a: 1 } },
      { type: 'tool_end', name: 'calc', result: 2 },
    ]);
    expect(rec.toolInvoked[0]!.toolCallId).toBeDefined();
    expect(rec.toolCompleted[0]!.toolCallId).toBe(rec.toolInvoked[0]!.toolCallId);
  });

  it('correlates interleaved same-name calls LIFO (no id crosstalk)', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: { n: 1 } }, // id A
      { type: 'tool_start', name: 'calc', arguments: { n: 2 } }, // id B
      { type: 'tool_end', name: 'calc', result: 2 },             // pops B
      { type: 'tool_end', name: 'calc', result: 1 },             // pops A
    ]);
    const [a, b] = rec.toolInvoked.map((t) => t.toolCallId);
    expect(a).not.toBe(b);
    expect(rec.toolCompleted[0]!.toolCallId).toBe(b);
    expect(rec.toolCompleted[1]!.toolCallId).toBe(a);
  });

  it('distinct tool names get distinct ids', async () => {
    const rec = await feed([
      { type: 'tool_start', name: 'calc', arguments: {} },
      { type: 'tool_start', name: 'search', arguments: {} },
    ]);
    expect(rec.toolInvoked[0]!.toolCallId).not.toBe(rec.toolInvoked[1]!.toolCallId);
  });
});

// ─── negative / security ─────────────────────────────────────

describe('bridge — robustness (negative/security)', () => {
  it('ignores malformed JSON frames without crashing or emitting', async () => {
    const { emitter, rec } = recorder();
    const cap = new SseCaptureResponse(emitter);
    cap.write('data: {not json\n\n');
    cap.write('data: \n\n');
    cap.write(frame({ type: 'text', text: 'ok' }));
    await cap.drain();
    expect(rec.text).toEqual([{ delta: 'ok' }]);
  });

  it('captures an error frame as a run failure (not as output)', async () => {
    const { emitter } = recorder();
    const cap = new SseCaptureResponse(emitter);
    cap.write(frame({ type: 'error', error: 'model exploded' }));
    await cap.drain();
    expect(cap.error).toBe('model exploded');
  });

  it('drops unknown/internal frames (redaction/generation/screenshot)', async () => {
    const rec = await feed([
      { type: 'redaction', count: 2 },
      { type: 'generation', id: 'g1' },
      { type: 'screenshot', url: 'x' },
    ]);
    const total = rec.text.length + rec.reasoning.length + rec.step.length + rec.usage.length + rec.artifact.length + rec.diagnostic.length;
    expect(total).toBe(0);
  });

  it('handles a done frame with no usage/artifacts gracefully', async () => {
    const rec = await feed([{ type: 'done' }]);
    expect(rec.usage).toHaveLength(1); // emits an (empty) usage snapshot
    expect(rec.artifact).toHaveLength(0);
  });

  it('preserves frame ordering across a split write (SSE chunk boundary)', async () => {
    const { emitter, rec } = recorder();
    const cap = new SseCaptureResponse(emitter);
    const a = frame({ type: 'reasoning', text: 'AB' });
    const b = frame({ type: 'text', text: 'CD' });
    const joined = a + b;
    cap.write(joined.slice(0, 12)); // split mid-frame
    cap.write(joined.slice(12));
    await cap.drain();
    expect(rec.reasoning).toEqual(['AB']);
    expect(rec.text).toEqual([{ delta: 'CD' }]);
  });
});

// ─── stress ──────────────────────────────────────────────────

describe('bridge — stress', () => {
  it('mirrors 2000 mixed frames in order', async () => {
    const frames: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i++) {
      const k = i % 4;
      if (k === 0) frames.push({ type: 'text', text: 't' });
      else if (k === 1) frames.push({ type: 'reasoning', text: 'r' });
      else if (k === 2) frames.push({ type: 'step', step: { index: i, type: 'response' } });
      else frames.push({ type: 'tool_end', name: 'x', result: { ok: true } });
    }
    const rec = await feed(frames);
    expect(rec.text).toHaveLength(500);
    expect(rec.reasoning).toHaveLength(500);
    expect(rec.step).toHaveLength(500);
    expect(rec.toolCompleted).toHaveLength(500);
  });
});
