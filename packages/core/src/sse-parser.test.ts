/**
 * Unit tests — parseSseStream (the single SSE byte→event decoder).
 * Positive · boundary · partial-chunk · CRLF · keepalive · abort · stall · security.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSseStream, SseStallError, type SseEvent } from './sse-parser.js';

const enc = new TextEncoder();

/** Build a ReadableStream that emits `chunks` (strings) in order, then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]!));
      else ctrl.close();
    },
  });
}

/** A stream that never produces a chunk (for stall tests), closeable via cancel. */
function silentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull() { /* never enqueue */ } });
}

async function collect(stream: ReadableStream<Uint8Array>, opts?: Parameters<typeof parseSseStream>[1]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(stream, opts)) out.push(ev);
  return out;
}

describe('parseSseStream — positive', () => {
  it('parses a single data event', async () => {
    expect(await collect(streamOf(['data: {"a":1}\n\n']))).toEqual([{ data: '{"a":1}' }]);
  });

  it('parses multiple events', async () => {
    const evs = await collect(streamOf(['data: one\n\n', 'data: two\n\n']));
    expect(evs).toEqual([{ data: 'one' }, { data: 'two' }]);
  });

  it('captures the event: name', async () => {
    expect(await collect(streamOf(['event: ping\ndata: hi\n\n']))).toEqual([{ data: 'hi', event: 'ping' }]);
  });

  it('joins multi-line data with \\n (SSE spec)', async () => {
    expect(await collect(streamOf(['data: a\ndata: b\ndata: c\n\n']))).toEqual([{ data: 'a\nb\nc' }]);
  });

  it('flushes a trailing event with no final blank line', async () => {
    expect(await collect(streamOf(['data: tail']))).toEqual([{ data: 'tail' }]);
  });

  it('strips exactly one leading space after data: (not more)', async () => {
    expect(await collect(streamOf(['data:  two-spaces\n\n']))).toEqual([{ data: ' two-spaces' }]);
  });
});

describe('parseSseStream — chunk boundaries & line endings', () => {
  it('reassembles an event split across arbitrary chunk boundaries', async () => {
    const evs = await collect(streamOf(['da', 'ta: hel', 'lo\n', '\n']));
    expect(evs).toEqual([{ data: 'hello' }]);
  });

  it('handles a blank-line boundary that arrives in its own chunk', async () => {
    expect(await collect(streamOf(['data: x\n', '\n', 'data: y\n\n']))).toEqual([{ data: 'x' }, { data: 'y' }]);
  });

  it('handles CRLF line endings', async () => {
    expect(await collect(streamOf(['event: e\r\ndata: v\r\n\r\n']))).toEqual([{ data: 'v', event: 'e' }]);
  });

  it('decodes a multi-byte UTF-8 char split across two chunks', async () => {
    const bytes = enc.encode('data: ✓done\n\n');
    const a = bytes.slice(0, 8); // splits the ✓ (3 bytes) mid-character
    const b = bytes.slice(8);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i === 0) ctrl.enqueue(a);
        else if (i === 1) ctrl.enqueue(b);
        else ctrl.close();
        i++;
      },
    });
    expect(await collect(stream)).toEqual([{ data: '✓done' }]);
  });
});

describe('parseSseStream — keepalive / noise / negative', () => {
  it('ignores :comment keepalive lines', async () => {
    expect(await collect(streamOf([': keepalive\ndata: real\n\n']))).toEqual([{ data: 'real' }]);
  });

  it('surfaces id: (for Last-Event-ID resume) and ignores retry:', async () => {
    // Phase 6: `id:` is now surfaced so a Node consumer can drive its own resume
    // cursor; `retry:` (a browser reconnect hint) is still ignored.
    expect(await collect(streamOf(['id: 7\nretry: 1000\ndata: ok\n\n']))).toEqual([{ data: 'ok', id: '7' }]);
  });

  it('does not emit for a boundary with no data/event (pure keepalive block)', async () => {
    expect(await collect(streamOf([': ka\n\n: ka\n\n']))).toEqual([]);
  });

  it('yields an empty-string data event for a bare "data:" line', async () => {
    expect(await collect(streamOf(['data:\n\n']))).toEqual([{ data: '' }]);
  });

  it('returns immediately on an empty stream', async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });
});

describe('parseSseStream — abort', () => {
  it('stops cleanly when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await collect(streamOf(['data: x\n\n']), { signal: ac.signal })).toEqual([]);
  });

  it('cancels the underlying reader when the loop is broken early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) { ctrl.enqueue(enc.encode('data: a\n\ndata: b\n\n')); },
      cancel() { cancelled = true; },
    });
    const seen: SseEvent[] = [];
    for await (const ev of parseSseStream(stream)) {
      seen.push(ev);
      break; // stop after the first event
    }
    expect(seen).toEqual([{ data: 'a' }]);
    expect(cancelled).toBe(true);
  });

  it('stops mid-stream when the signal aborts', async () => {
    const ac = new AbortController();
    const stream = silentStream();
    const p = collect(stream, { signal: ac.signal });
    ac.abort();
    expect(await p).toEqual([]);
  });
});

describe('parseSseStream — stall timeout', () => {
  it('throws SseStallError if no bytes arrive within the window', async () => {
    vi.useFakeTimers();
    try {
      const p = (async () => {
        const out: SseEvent[] = [];
        for await (const ev of parseSseStream(silentStream(), { stallTimeoutMs: 1000 })) out.push(ev);
        return out;
      })();
      const assertion = expect(p).rejects.toBeInstanceOf(SseStallError);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stall when data flows', async () => {
    expect(await collect(streamOf(['data: ok\n\n']), { stallTimeoutMs: 50_000 })).toEqual([{ data: 'ok' }]);
  });
});

describe('parseSseStream — security / robustness', () => {
  it('passes raw data through verbatim (no JSON parsing / no injection interpretation)', async () => {
    // A payload containing HTML/script-looking characters survives intact.
    const evil = '{"x":"</script><img src=x onerror=alert(1)>"}';
    expect(await collect(streamOf([`data: ${evil}\n\n`]))).toEqual([{ data: evil }]);
  });

  it('treats a literal "data:" inside the value as content, not a new field', async () => {
    expect(await collect(streamOf(['data: a data: b\n\n']))).toEqual([{ data: 'a data: b' }]);
  });

  it('does not conflate two events when the blank line is missing between them mid-buffer', async () => {
    // Without a blank line, consecutive data: lines accumulate into ONE event.
    expect(await collect(streamOf(['data: a\ndata: b\n\n']))).toEqual([{ data: 'a\nb' }]);
  });
});
