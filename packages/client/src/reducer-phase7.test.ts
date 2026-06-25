/**
 * Unit tests — Phase 7 reducer handling (structured object streaming + files).
 * progressive object · finalize · file parts · ordering · purity · robustness.
 */
import { describe, it, expect } from 'vitest';
import { streamReducer, emptyRunViewModel, type RunViewModel, type ObjectPart, type FilePart } from './reducer.js';
import type { RunEventEnvelope } from '@weaveintel/core';

let seq = 0;
function ev(kind: string, payload: Record<string, unknown>): RunEventEnvelope {
  return { runId: 'r', sequence: seq++, kind, payload } as RunEventEnvelope;
}
function fold(events: RunEventEnvelope[]): RunViewModel {
  let vm = emptyRunViewModel();
  for (const e of events) vm = streamReducer(vm, e);
  return vm;
}
function reset() { seq = 0; }

describe('Phase 7 reducer — structured object streaming', () => {
  it('accumulates object.delta into a progressively-parsed object', () => {
    reset();
    const vm = fold([
      ev('run.started', {}),
      ev('object.delta', { delta: '{"title":"Ca' }),
      ev('object.delta', { delta: 'ts","tags":["cu' }),
      ev('object.delta', { delta: 'te"]}' }),
    ]);
    expect(vm.object?.text).toBe('{"title":"Cats","tags":["cute"]}');
    expect(vm.object?.partial).toEqual({ title: 'Cats', tags: ['cute'] });
    expect(vm.object?.complete).toBe(false);
    // A streaming object part mirrors the view.
    const part = vm.parts.find((p): p is ObjectPart => p.type === 'object');
    expect(part?.state).toBe('streaming');
    expect(part?.partial).toEqual({ title: 'Cats', tags: ['cute'] });
  });

  it('exposes a valid partial mid-stream (before the object closes)', () => {
    reset();
    const vm = fold([ev('object.delta', { delta: '{"a":1,"b":"hel' })]);
    expect(vm.object?.partial).toEqual({ a: 1, b: 'hel' });
    expect(vm.object?.complete).toBe(false);
  });

  it('object.complete finalizes with the parsed value', () => {
    reset();
    const vm = fold([
      ev('object.delta', { delta: '{"n":42}' }),
      ev('object.complete', {}),
    ]);
    expect(vm.object?.complete).toBe(true);
    expect(vm.object?.value).toEqual({ n: 42 });
    const part = vm.parts.find((p): p is ObjectPart => p.type === 'object')!;
    expect(part.state).toBe('done');
    expect(part.value).toEqual({ n: 42 });
  });

  it('object.complete honors an explicit server-provided value', () => {
    reset();
    const vm = fold([
      ev('object.delta', { delta: '{"partial' }),
      ev('object.complete', { value: { fixed: true } }),
    ]);
    expect(vm.object?.value).toEqual({ fixed: true });
  });

  it('finalizes a streaming object on run.completed without an explicit object.complete', () => {
    reset();
    const vm = fold([
      ev('object.delta', { delta: '{"done":true}' }),
      ev('run.completed', {}),
    ]);
    const part = vm.parts.find((p): p is ObjectPart => p.type === 'object')!;
    expect(part.state).toBe('done');
    expect(part.value).toEqual({ done: true });
  });

  it('tolerates a malformed object stream without throwing (partial undefined)', () => {
    reset();
    const vm = fold([ev('object.delta', { delta: 'not json at all' })]);
    expect(vm.object?.text).toBe('not json at all');
    expect(vm.object?.partial).toBeUndefined();
  });
});

describe('Phase 7 reducer — multimodal file parts', () => {
  it('records an input file part (round-trip) on vm.files and parts', () => {
    reset();
    const vm = fold([
      ev('run.started', {}),
      ev('file.part', { id: 'f1', mediaType: 'image/png', name: 'cat.png', dataBase64: 'iVBOR', direction: 'input' }),
    ]);
    expect(vm.files).toHaveLength(1);
    expect(vm.files[0]).toMatchObject({ kind: 'file', id: 'f1', mediaType: 'image/png', name: 'cat.png', direction: 'input' });
    const part = vm.parts.find((p): p is FilePart => p.type === 'file')!;
    expect(part).toMatchObject({ id: 'f1', mediaType: 'image/png', direction: 'input' });
  });

  it('records multiple files in order and supports url-based parts', () => {
    reset();
    const vm = fold([
      ev('file.part', { id: 'a', mediaType: 'image/png', direction: 'input' }),
      ev('file.part', { id: 'b', mediaType: 'application/pdf', url: 'https://x/y.pdf', direction: 'output' }),
    ]);
    expect(vm.files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(vm.files[1]).toMatchObject({ url: 'https://x/y.pdf', direction: 'output' });
  });

  it('defaults mediaType and id when omitted', () => {
    reset();
    const vm = fold([ev('file.part', {})]);
    expect(vm.files[0]!.mediaType).toBe('application/octet-stream');
    expect(typeof vm.files[0]!.id).toBe('string');
  });
});

describe('Phase 7 reducer — purity & ordering', () => {
  it('does not mutate the previous state (immutability)', () => {
    reset();
    const a = fold([ev('object.delta', { delta: '{"x":1' })]);
    const before = a.files.length;
    const b = streamReducer(a, ev('file.part', { id: 'z', mediaType: 'image/png' }));
    expect(a.files.length).toBe(before); // previous VM untouched
    expect(b.files.length).toBe(before + 1);
    expect(b).not.toBe(a);
  });

  it('ignores out-of-order / replayed events (dedup by sequence)', () => {
    const vm0 = emptyRunViewModel();
    const e1 = { runId: 'r', sequence: 5, kind: 'object.delta', payload: { delta: '{"a":1}' } } as RunEventEnvelope;
    const vm1 = streamReducer(vm0, e1);
    const vm2 = streamReducer(vm1, e1); // replay same sequence
    expect(vm2).toBe(vm1);
    const stale = { runId: 'r', sequence: 3, kind: 'object.delta', payload: { delta: 'X' } } as RunEventEnvelope;
    expect(streamReducer(vm1, stale)).toBe(vm1);
  });

  it('keeps object and file channels independent of fullText', () => {
    reset();
    const vm = fold([
      ev('text.delta', { delta: 'hello ' }),
      ev('object.delta', { delta: '{"a":1}' }),
      ev('file.part', { id: 'f', mediaType: 'image/png' }),
      ev('text.delta', { delta: 'world' }),
    ]);
    expect(vm.fullText).toBe('hello world');
    expect(vm.object?.partial).toEqual({ a: 1 });
    expect(vm.files).toHaveLength(1);
  });
});
