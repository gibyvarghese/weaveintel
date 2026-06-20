/**
 * A2A Phase 6 — SSE parser unit tests
 *
 * Coverage:
 *   [SSE-PARSE]  parseSseStream: single event, multiple events, chunked delivery,
 *                comment skipping, [DONE] sentinel, empty stream, malformed JSON
 *   [SSE-EMIT]   sseData / sseComment helpers
 */

import { describe, it, expect } from 'vitest';
import { parseSseStream, sseData, sseComment } from './sse-parser.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a ReadableStream from an array of string chunks. */
function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ─── [SSE-PARSE] ─────────────────────────────────────────────────────────────

describe('[SSE-PARSE] parseSseStream', () => {
  it('parses a single complete data event', async () => {
    const stream = makeStream('data: {"task":{"id":"t1"}}\n\n');
    const events = await collect(parseSseStream<{ task: { id: string } }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.task.id).toBe('t1');
  });

  it('parses multiple events in one chunk', async () => {
    const stream = makeStream(
      'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n',
    );
    const events = await collect(parseSseStream<{ n: number }>(stream));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.n)).toEqual([1, 2, 3]);
  });

  it('handles events split across multiple chunks', async () => {
    // Split "data: {\"x\":42}\n\n" across three chunks
    const stream = makeStream('data: {"x"', ':42}', '\n\n');
    const events = await collect(parseSseStream<{ x: number }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.x).toBe(42);
  });

  it('skips comment lines starting with ":"', async () => {
    const stream = makeStream(': keepalive\n\ndata: {"ok":true}\n\n: ping\n\n');
    const events = await collect(parseSseStream<{ ok: boolean }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
  });

  it('ignores [DONE] sentinel for legacy resilience', async () => {
    const stream = makeStream('data: {"id":"t1"}\n\ndata: [DONE]\n\n');
    const events = await collect(parseSseStream<{ id: string }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('t1');
  });

  it('yields nothing for an empty stream', async () => {
    const stream = makeStream();
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(0);
  });

  it('skips malformed JSON without breaking the stream', async () => {
    const stream = makeStream(
      'data: not-json\n\ndata: {"ok":true}\n\ndata: {broken\n\n',
    );
    const events = await collect(parseSseStream<{ ok: boolean }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
  });

  it('handles empty data lines without yielding', async () => {
    const stream = makeStream('data: \n\ndata: {"v":1}\n\n');
    const events = await collect(parseSseStream<{ v: number }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.v).toBe(1);
  });

  it('ignores other SSE field types (event:, id:, retry:)', async () => {
    const stream = makeStream(
      'event: task\nid: 1\nretry: 1000\ndata: {"y":7}\n\n',
    );
    const events = await collect(parseSseStream<{ y: number }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.y).toBe(7);
  });

  it('handles \\r\\n line endings', async () => {
    // Chunks arrive with CRLF; split('\n') still handles this via trimEnd()
    const stream = makeStream('data: {"z":9}\r\n\r\n');
    const events = await collect(parseSseStream<{ z: number }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.z).toBe(9);
  });

  it('handles large payloads split across many chunks', async () => {
    const payload = { text: 'x'.repeat(4000) };
    const sse = `data: ${JSON.stringify(payload)}\n\n`;
    // Split into 100-char chunks
    const chunks: string[] = [];
    for (let i = 0; i < sse.length; i += 100) chunks.push(sse.slice(i, i + 100));
    const stream = makeStream(...chunks);
    const events = await collect(parseSseStream<{ text: string }>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.text.length).toBe(4000);
  });

  it('parses a real A2A statusUpdate event', async () => {
    const event = {
      statusUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      },
    };
    const stream = makeStream(`data: ${JSON.stringify(event)}\n\n`);
    const events = await collect(parseSseStream<typeof event>(stream));
    expect(events).toHaveLength(1);
    expect(events[0]?.statusUpdate.taskId).toBe('task-1');
    expect(events[0]?.statusUpdate.status.state).toBe('TASK_STATE_WORKING');
  });

  it('parses a real A2A artifactUpdate event', async () => {
    const event = {
      artifactUpdate: {
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'a1', name: 'output', parts: [{ text: 'hello' }] },
        append: false,
        lastChunk: true,
      },
    };
    const stream = makeStream(`data: ${JSON.stringify(event)}\n\n`);
    const events = await collect(parseSseStream<typeof event>(stream));
    expect(events[0]?.artifactUpdate.artifact.parts[0]?.text).toBe('hello');
  });

  it('handles a stream with only comments — yields nothing', async () => {
    const stream = makeStream(': ping\n\n: pong\n\n');
    const events = await collect(parseSseStream(stream));
    expect(events).toHaveLength(0);
  });
});

// ─── [SSE-EMIT] ───────────────────────────────────────────────────────────────

describe('[SSE-EMIT] sseData / sseComment', () => {
  it('sseData wraps event as data line with double newline', () => {
    const out = sseData({ task: 'done' });
    expect(out).toBe('data: {"task":"done"}\n\n');
  });

  it('sseData round-trips through parseSseStream', async () => {
    const event = { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED', timestamp: '' } } };
    const sse = sseData(event);
    const events = await collect(parseSseStream<typeof event>(makeStream(sse)));
    expect(events[0]?.statusUpdate.taskId).toBe('t1');
  });

  it('sseComment emits a comment line with double newline', () => {
    expect(sseComment('keepalive')).toBe(': keepalive\n\n');
    expect(sseComment('ping')).toBe(': ping\n\n');
  });

  it('sseComment is ignored by parseSseStream', async () => {
    const sse = sseComment('heartbeat') + sseData({ n: 1 }) + sseComment('end');
    const events = await collect(parseSseStream<{ n: number }>(makeStream(sse)));
    expect(events).toHaveLength(1);
    expect(events[0]?.n).toBe(1);
  });
});
