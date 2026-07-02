// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { formatSseFrame, formatSseComment, resolveResumeCursor, writeSseFrame, parseSseStream } from './index.js';

/** Feed a string through the canonical reader to prove writer↔reader round-trip. */
async function readBack(wire: string): Promise<Array<{ id?: string; event?: string; data: string }>> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(wire)); c.close(); },
  });
  const out: Array<{ id?: string; event?: string; data: string }> = [];
  for await (const ev of parseSseStream(stream)) out.push(ev as { id?: string; event?: string; data: string });
  return out;
}

describe('formatSseFrame', () => {
  it('emits id / event / retry / data lines + a blank separator', () => {
    const frame = formatSseFrame({ id: 42, event: 'message', data: { a: 1 }, retry: 3000 });
    expect(frame).toBe('id: 42\nevent: message\nretry: 3000\ndata: {"a":1}\n\n');
  });
  it('splits multi-line data across data: lines', () => {
    expect(formatSseFrame({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n');
  });
  it('sends string data verbatim', () => {
    expect(formatSseFrame({ data: 'hello' })).toBe('data: hello\n\n');
  });
});

describe('writer ↔ canonical reader round-trip', () => {
  it('a written frame parses back to the same id/data', async () => {
    const wire = formatSseFrame({ id: 7, data: { kind: 'text.delta', delta: 'hi' } });
    const events = await readBack(wire);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('7');
    expect(JSON.parse(events[0]!.data)).toMatchObject({ kind: 'text.delta', delta: 'hi' });
  });
  it('comments are ignored by the reader (keepalive)', async () => {
    const wire = formatSseComment() + formatSseFrame({ data: 'x' });
    const events = await readBack(wire);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('x');
  });
});

describe('resolveResumeCursor — Last-Event-ID precedence', () => {
  it('prefers Last-Event-ID, then ?after, then default', () => {
    expect(resolveResumeCursor({ lastEventId: '10', afterParam: '5' })).toBe(10);
    expect(resolveResumeCursor({ lastEventId: null, afterParam: '5' })).toBe(5);
    expect(resolveResumeCursor({ lastEventId: '', afterParam: null, defaultAfter: -1 })).toBe(-1);
    expect(resolveResumeCursor({ lastEventId: 'not-a-number', afterParam: '3' })).toBe(3);
  });
});

describe('writeSseFrame', () => {
  it('writes to a sink and reports success/failure', () => {
    const chunks: string[] = [];
    expect(writeSseFrame({ write: (c) => { chunks.push(c); return true; } }, { id: 1, data: 'x' })).toBe(true);
    expect(chunks[0]).toContain('id: 1');
    expect(writeSseFrame({ write: () => { throw new Error('broken pipe'); } }, { data: 'x' })).toBe(false);
  });
});
