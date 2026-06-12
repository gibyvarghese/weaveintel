/**
 * W7 — @weaveintel/client tests
 *
 * Covers:
 *  - streamReducer: text accumulation, widget upsert, status transitions, tool-call, error
 *  - RunOutbox: enqueue/flush/pending/clear
 *  - createRunClient: startRun, getRun, listRuns, cancelRun, attach (mock transport)
 *  - idempotent reducer (duplicate sequence ignored)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  streamReducer,
  emptyRunViewModel,
  createRunClient,
  createRunOutbox,
  MemoryStorage,
  mockSseTransport,
} from './index.js';
import type { RunEventEnvelope, RunRecord } from './index.js';

// ---------------------------------------------------------------------------
// streamReducer
// ---------------------------------------------------------------------------

describe('streamReducer', () => {
  it('starts as pending', () => {
    expect(emptyRunViewModel().status).toBe('pending');
  });

  it('transitions to running on run.started', () => {
    const s = streamReducer(emptyRunViewModel(), { runId: 'r1', sequence: 0, kind: 'run.started', payload: {} });
    expect(s.status).toBe('running');
    expect(s.sequence).toBe(0);
  });

  it('accumulates text deltas', () => {
    let s = emptyRunViewModel();
    s = streamReducer(s, { runId: 'r1', sequence: 0, kind: 'text.delta', payload: { delta: 'Hello' } });
    s = streamReducer(s, { runId: 'r1', sequence: 1, kind: 'text.delta', payload: { delta: ', world' } });
    expect(s.fullText).toBe('Hello, world');
    expect(s.textChunks).toHaveLength(2);
  });

  it('upserts widgets by id', () => {
    let s = emptyRunViewModel();
    const e1: RunEventEnvelope = {
      runId: 'r1', sequence: 0, kind: 'widget.update',
      payload: { id: 'w1', payload: { title: 'v1' } },
    };
    const e2: RunEventEnvelope = {
      runId: 'r1', sequence: 1, kind: 'widget.update',
      payload: { id: 'w1', payload: { title: 'v2' } },
    };
    s = streamReducer(s, e1);
    s = streamReducer(s, e2);
    expect(s.widgets.get('w1')?.payload['title']).toBe('v2');
    expect(s.widgets.size).toBe(1);
  });

  it('records tool calls', () => {
    let s = emptyRunViewModel();
    s = streamReducer(s, { runId: 'r1', sequence: 0, kind: 'tool.invoked', payload: { tool: 'search', args: { q: 'test' } } });
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]?.toolName).toBe('search');
  });

  it('marks failed run with error', () => {
    let s = emptyRunViewModel();
    s = streamReducer(s, { runId: 'r1', sequence: 0, kind: 'run.failed', payload: { message: 'timeout' } });
    expect(s.status).toBe('failed');
    expect(s.lastError?.message).toBe('timeout');
  });

  it('transitions to completed', () => {
    let s = emptyRunViewModel();
    s = streamReducer(s, { runId: 'r1', sequence: 0, kind: 'run.started', payload: {} });
    s = streamReducer(s, { runId: 'r1', sequence: 1, kind: 'run.completed', payload: {} });
    expect(s.status).toBe('completed');
  });

  it('ignores duplicate / out-of-order sequences (idempotent)', () => {
    let s = streamReducer(emptyRunViewModel(), { runId: 'r1', sequence: 0, kind: 'text.delta', payload: { delta: 'A' } });
    const before = s.fullText;
    s = streamReducer(s, { runId: 'r1', sequence: 0, kind: 'text.delta', payload: { delta: 'A' } }); // duplicate
    expect(s.fullText).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// RunOutbox
// ---------------------------------------------------------------------------

describe('createRunOutbox', () => {
  it('enqueues and lists pending items', async () => {
    const outbox = createRunOutbox({ storage: new MemoryStorage() });
    await outbox.enqueue({ idempotencyKey: 'ik-1', input: { text: 'hello' } });
    await outbox.enqueue({ idempotencyKey: 'ik-2', input: { text: 'world' } });
    const pending = await outbox.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.input['idempotencyKey']).toBe('ik-1');
  });

  it('flushes successfully and removes from outbox', async () => {
    const outbox = createRunOutbox({ storage: new MemoryStorage() });
    await outbox.enqueue({ idempotencyKey: 'ik-1' });
    const mockClient = { startRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'pending' }) } as never;
    const result = await outbox.flush(mockClient);
    expect(result.flushed).toBe(1);
    expect(result.failed).toBe(0);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('keeps failed items in outbox and increments attempts', async () => {
    const outbox = createRunOutbox({ storage: new MemoryStorage() });
    await outbox.enqueue({ idempotencyKey: 'ik-1' });
    const mockClient = { startRun: vi.fn().mockRejectedValue(new Error('network')) } as never;
    const result = await outbox.flush(mockClient);
    expect(result.failed).toBe(1);
    const pending = await outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
  });

  it('clear removes all items', async () => {
    const outbox = createRunOutbox({ storage: new MemoryStorage() });
    await outbox.enqueue({ idempotencyKey: 'ik-1' });
    await outbox.clear();
    expect(await outbox.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createRunClient (mock transport)
// ---------------------------------------------------------------------------

describe('createRunClient', () => {
  function makeClient(jsonOverrides: Partial<{
    get: (path: string) => unknown;
    post: (path: string, body: unknown) => unknown;
  }> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = {
      get: vi.fn(async (path: string) => jsonOverrides.get ? jsonOverrides.get(path) : null),
      post: vi.fn(async (_path: string, body: unknown) => jsonOverrides.post ? jsonOverrides.post(_path, body) : {}),
      del: vi.fn(async () => ({})),
    };
    const client = createRunClient({ baseUrl: 'http://test', json });
    return { client, json };
  }

  it('startRun calls POST /api/me/runs', async () => {
    const { client, json } = makeClient({ post: () => ({ id: 'run-1', status: 'pending' } as RunRecord) });
    const result = await client.startRun({ idempotencyKey: 'ik' });
    expect(json.post).toHaveBeenCalledWith('/api/me/runs', { idempotencyKey: 'ik' }, 'ik');
    expect(result.id).toBe('run-1');
  });

  it('getRun returns null on 404', async () => {
    const { client } = makeClient({ get: () => null });
    expect(await client.getRun('missing')).toBeNull();
  });

  it('listRuns calls GET /api/me/runs', async () => {
    const runs: RunRecord[] = [{ id: 'r1', status: 'completed' }];
    const { client, json } = makeClient({ get: () => runs });
    const result = await client.listRuns();
    expect(json.get).toHaveBeenCalledWith('/api/me/runs');
    expect(result).toHaveLength(1);
  });

  it('cancelRun calls POST /api/me/runs/:id/cancel', async () => {
    const { client, json } = makeClient();
    await client.cancelRun('r1');
    expect(json.post).toHaveBeenCalledWith('/api/me/runs/r1/cancel', {});
  });

  it('attach processes pre-canned SSE events via mock transport', () => {
    const events: { data: string }[] = [
      { data: JSON.stringify({ runId: 'r1', sequence: 0, kind: 'run.started', payload: {} }) },
      { data: JSON.stringify({ runId: 'r1', sequence: 1, kind: 'text.delta', payload: { delta: 'Hi' } }) },
      { data: JSON.stringify({ runId: 'r1', sequence: 2, kind: 'run.completed', payload: {} }) },
    ];
    const received: RunEventEnvelope[] = [];
    let completed = false;
    const sse = mockSseTransport(events);
    const client = createRunClient({ baseUrl: 'http://test', sse });
    const ctrl = client.attach('r1', {
      onEvent: (e) => { received.push(e); },
      onComplete: () => { completed = true; },
    });
    expect(received).toHaveLength(3);
    expect(received[2]?.kind).toBe('run.completed');
    expect(completed).toBe(true);
    ctrl.abort(); // no-op; stream already ended
  });
});
