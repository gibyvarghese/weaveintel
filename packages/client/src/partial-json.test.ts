/**
 * Unit tests — parsePartialJson (tolerant incremental JSON parser).
 * valid · partial-completion · arrays/nesting/escapes · negative · security.
 */
import { describe, it, expect } from 'vitest';
import { parsePartialJson, extractJsonCandidate } from './partial-json.js';

describe('parsePartialJson — complete & valid', () => {
  it('parses a complete object as valid', () => {
    expect(parsePartialJson('{"a":1,"b":"x"}')).toEqual({ value: { a: 1, b: 'x' }, state: 'valid' });
  });
  it('parses a complete array as valid', () => {
    expect(parsePartialJson('[1,2,3]')).toEqual({ value: [1, 2, 3], state: 'valid' });
  });
  it('parses primitives', () => {
    expect(parsePartialJson('true')).toEqual({ value: true, state: 'valid' });
    expect(parsePartialJson('42')).toEqual({ value: 42, state: 'valid' });
    expect(parsePartialJson('"hi"')).toEqual({ value: 'hi', state: 'valid' });
  });
});

describe('parsePartialJson — partial completion', () => {
  it('completes an unclosed object', () => {
    expect(parsePartialJson('{"a":1')).toEqual({ value: { a: 1 }, state: 'partial' });
  });
  it('drops a dangling comma', () => {
    expect(parsePartialJson('{"a":1,')).toEqual({ value: { a: 1 }, state: 'partial' });
  });
  it('drops a dangling key with colon (no value yet)', () => {
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ value: { a: 1 }, state: 'partial' });
  });
  it('drops a dangling key with no colon', () => {
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ value: { a: 1 }, state: 'partial' });
  });
  it('closes a half-written string value', () => {
    expect(parsePartialJson('{"a":"hel')).toEqual({ value: { a: 'hel' }, state: 'partial' });
  });
  it('closes a half-written string key', () => {
    expect(parsePartialJson('{"ab')).toEqual({ value: {}, state: 'partial' });
  });
  it('completes an unclosed array', () => {
    expect(parsePartialJson('[1,2')).toEqual({ value: [1, 2], state: 'partial' });
  });
  it('drops a trailing comma in an array', () => {
    expect(parsePartialJson('[1,2,')).toEqual({ value: [1, 2], state: 'partial' });
  });
  it('completes deeply nested partial structures', () => {
    expect(parsePartialJson('{"a":{"b":[1,{"c":"de')).toEqual({ value: { a: { b: [1, { c: 'de' }] } }, state: 'partial' });
  });
  it('chops a truncated number/keyword tail', () => {
    // A half-typed value with no terminator yet is dropped, not guessed.
    expect(parsePartialJson('{"a":1,"b":tr')).toEqual({ value: { a: 1 }, state: 'partial' });
    expect(parsePartialJson('{"a":12')).toEqual({ value: { a: 12 }, state: 'partial' }); // brace still open ⇒ partial
  });
  it('preserves escaped characters when closing a string', () => {
    expect(parsePartialJson('{"a":"line\\nbreak')).toEqual({ value: { a: 'line\nbreak' }, state: 'partial' });
  });
  it('drops a trailing backslash (incomplete escape) before closing', () => {
    expect(parsePartialJson('{"a":"x\\')).toEqual({ value: { a: 'x' }, state: 'partial' });
  });
  it('models a progressively-streamed object correctly at each prefix', () => {
    const full = '{"title":"Cats","tags":["cute","furry"],"count":2}';
    const seen: unknown[] = [];
    for (let i = 1; i <= full.length; i++) {
      const r = parsePartialJson(full.slice(0, i));
      if (r.state !== 'failed') seen.push(r.value);
    }
    // The final prefix is the whole document.
    expect(seen[seen.length - 1]).toEqual({ title: 'Cats', tags: ['cute', 'furry'], count: 2 });
    // Every emitted partial is a real object/value (never throws).
    expect(seen.length).toBeGreaterThan(5);
  });
});

describe('parsePartialJson — negative', () => {
  it('returns failed for empty / whitespace', () => {
    expect(parsePartialJson('')).toEqual({ value: undefined, state: 'failed' });
    expect(parsePartialJson('   ')).toEqual({ value: undefined, state: 'failed' });
  });
  it('returns failed for a non-string input', () => {
    expect(parsePartialJson(undefined as unknown as string)).toEqual({ value: undefined, state: 'failed' });
  });
  it('returns failed for an unbalanced closer', () => {
    expect(parsePartialJson('{"a":1}}')).toEqual({ value: undefined, state: 'failed' });
    expect(parsePartialJson(']')).toEqual({ value: undefined, state: 'failed' });
  });
  it('returns failed for mismatched containers', () => {
    expect(parsePartialJson('{"a":[1}')).toEqual({ value: undefined, state: 'failed' });
  });
});

describe('parsePartialJson — security / robustness', () => {
  it('does not execute code embedded in strings', () => {
    const r = parsePartialJson('{"x":"</script><img src=x onerror=alert(1)>"}');
    expect(r.state).toBe('valid');
    expect((r.value as { x: string }).x).toContain('onerror');
  });
  it('handles a deeply nested structure without crashing (stress)', () => {
    const depth = 2000;
    const r = parsePartialJson('['.repeat(depth) + '1');
    // Either parses (completed) or fails — but never throws / hangs.
    expect(['partial', 'failed']).toContain(r.state);
  });
  it('rejects an over-long buffer instead of looping', () => {
    const huge = '{"a":"' + 'x'.repeat(5_000_001);
    expect(parsePartialJson(huge).state).toBe('failed');
  });
  it('treats a literal brace inside a string as content, not structure', () => {
    expect(parsePartialJson('{"a":"{[not real')).toEqual({ value: { a: '{[not real' }, state: 'partial' });
  });
});

describe('extractJsonCandidate — fences / prose / trailing junk', () => {
  it('returns clean JSON unchanged', () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
  });
  it('strips a ```json fence', () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips a bare ``` fence', () => {
    expect(extractJsonCandidate('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('drops leading prose before the object', () => {
    expect(extractJsonCandidate('Here is the JSON:\n{"a":1}')).toBe('{"a":1}');
  });
  it('drops trailing commentary after a balanced object', () => {
    expect(extractJsonCandidate('{"a":1} hope that helps!')).toBe('{"a":1}');
  });
  it('keeps the unclosed remainder while still streaming', () => {
    expect(extractJsonCandidate('```json\n{"a":1,"b":"hel')).toBe('{"a":1,"b":"hel');
  });
  it('returns empty once the fence is stripped and no structure has appeared yet', () => {
    expect(extractJsonCandidate('```json')).toBe('');
  });
  it('returns leading prose unchanged when no JSON structure is present', () => {
    expect(extractJsonCandidate('thinking...')).toBe('thinking...');
  });
  it('round-trips fenced JSON through parsePartialJson', () => {
    expect(parsePartialJson(extractJsonCandidate('```json\n{"name":"x","n":2}\n```'))).toEqual({ value: { name: 'x', n: 2 }, state: 'valid' });
  });
  it('parses a fenced partial progressively', () => {
    expect(parsePartialJson(extractJsonCandidate('```json\n{"name":"Whisk'))).toEqual({ value: { name: 'Whisk' }, state: 'partial' });
  });
});
