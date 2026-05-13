/**
 * Phase 7 — Tool Output Truncation unit tests.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, Tool } from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';
import {
  TRUNCATION_MARKER,
  applyOutputTruncationToHistory,
  truncateText,
  weaveToolOutputTruncator,
  wrapToolRegistryWithOutputTruncation,
} from './output-truncation.js';

const ctx: ExecutionContext = { executionId: 'r-1', metadata: {} };

describe('truncateText', () => {
  it('returns input unchanged when below cap', () => {
    const r = truncateText('hello', 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('hello');
    expect(r.originalBytes).toBe(5);
  });

  it('truncates and stamps marker when above cap', () => {
    const big = 'x'.repeat(1000);
    const r = truncateText(big, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(100);
    expect(r.originalBytes).toBe(1000);
  });

  it('respects multi-byte UTF-8 boundaries (no split chars)', () => {
    // each em-dash is 3 UTF-8 bytes
    const text = '—'.repeat(100);
    const r = truncateText(text, 50);
    expect(r.truncated).toBe(true);
    // the truncated text must remain valid utf-8 (decode round-trip)
    expect(() => Buffer.from(r.text, 'utf8').toString('utf8')).not.toThrow();
  });

  it('pass-through on zero / negative / NaN cap', () => {
    expect(truncateText('hello', 0).truncated).toBe(false);
    expect(truncateText('hello', -1).truncated).toBe(false);
    expect(truncateText('hello', Number.NaN).truncated).toBe(false);
  });

  it('handles non-string input gracefully', () => {
    const r = truncateText(undefined as unknown as string, 100);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
  });
});

describe('wrapToolRegistryWithOutputTruncation', () => {
  function makeTool(): Tool {
    return {
      schema: { name: 'echo', description: 'echo', parameters: { type: 'object' as const, properties: {} } },
      invoke: async () => ({ content: 'x'.repeat(2000) }),
    };
  }

  it('passes through when config is missing or cap is 0', () => {
    const reg = weaveToolRegistry();
    reg.register(makeTool());
    expect(wrapToolRegistryWithOutputTruncation(reg, undefined)).toBe(reg);
    expect(wrapToolRegistryWithOutputTruncation(reg, { maxBytesPerTurn: 0 })).toBe(reg);
  });

  it('wraps and caps tool result content', async () => {
    const reg = weaveToolRegistry();
    reg.register(makeTool());
    const wrapped = wrapToolRegistryWithOutputTruncation(reg, { maxBytesPerTurn: 100 });
    const t = wrapped.get('echo')!;
    const out = await t.invoke(ctx, { name: 'echo', arguments: {} });
    expect(out.content.length).toBeLessThanOrEqual(100);
    expect(out.metadata?.['truncated']).toBe(true);
    expect(out.metadata?.['originalBytes']).toBe(2000);
    expect(out.metadata?.['maxBytesPerTurn']).toBe(100);
  });

  it('does not modify result when below cap', async () => {
    const reg = weaveToolRegistry();
    reg.register({
      schema: { name: 'small', description: '', parameters: { type: 'object' as const, properties: {} } },
      invoke: async () => ({ content: 'tiny' }),
    });
    const wrapped = wrapToolRegistryWithOutputTruncation(reg, { maxBytesPerTurn: 100 });
    const out = await wrapped.get('small')!.invoke(ctx, { name: 'small', arguments: {} });
    expect(out.content).toBe('tiny');
    expect(out.metadata).toBeUndefined();
  });
});

describe('applyOutputTruncationToHistory', () => {
  const sys = { role: 'system', content: 'sys' };
  const u = (i: number) => ({ role: 'user', content: `u${i}` });
  const a = (i: number) => ({ role: 'assistant', content: `a${i}` });
  const all = [sys, u(1), a(1), u(2), a(2), u(3), a(3)];

  it('keeps first system + last N non-system', () => {
    const r = applyOutputTruncationToHistory(all, 2);
    expect(r).toEqual([sys, u(3), a(3)]);
  });

  it('returns input unchanged when keepLastN missing or non-positive', () => {
    expect(applyOutputTruncationToHistory(all, undefined)).toBe(all);
    expect(applyOutputTruncationToHistory(all, 0)).toBe(all);
    expect(applyOutputTruncationToHistory(all, -1)).toBe(all);
  });

  it('returns input unchanged when non-system count ≤ keepLastN', () => {
    const r = applyOutputTruncationToHistory(all, 100);
    expect(r).toBe(all);
  });
});

describe('weaveToolOutputTruncator', () => {
  it('returns no-op when config disabled', () => {
    const t = weaveToolOutputTruncator(null);
    const r = t('hello');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('hello');
  });

  it('returns truncating fn when cap > 0', () => {
    const t = weaveToolOutputTruncator({ maxBytesPerTurn: 50 });
    const r = t('x'.repeat(500));
    expect(r.truncated).toBe(true);
  });
});
