/**
 * Unit tests — createRunOutbox v2.
 * order · backoff · max-attempts→dead-letter · event buffering · auto-flush ·
 * security/robustness · stress.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRunOutbox, MemoryStorage, type OutboxItem } from './outbox.js';
import type { RunClient, RunRecord, StartRunInput } from './run-client.js';

/** A mock client whose start/post behaviour is scriptable per call. */
function mockClient(opts: {
  onStart?: (input: StartRunInput) => void | never;
  onPost?: (runId: string, payload: Record<string, unknown>) => void | never;
} = {}): RunClient & { starts: StartRunInput[]; posts: Array<{ runId: string; payload: Record<string, unknown> }> } {
  const starts: StartRunInput[] = [];
  const posts: Array<{ runId: string; payload: Record<string, unknown> }> = [];
  return {
    starts, posts,
    async startRun(input) { opts.onStart?.(input); starts.push(input); return { id: `run-${starts.length}`, status: 'running' } as RunRecord; },
    async getRun() { return null; },
    async listRuns() { return []; },
    async cancelRun() { /* noop */ },
    attach() { return new AbortController(); },
    async postEvent(runId, payload) { opts.onPost?.(runId, payload); posts.push({ runId, payload }); },
    async setPresence() { return { participants: [] }; },
  };
}

describe('createRunOutbox v2 — enqueue & flush', () => {
  it('flushes start items in enqueue order and removes them', async () => {
    let t = 0;
    const ob = createRunOutbox({ now: () => t });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } }); t = 1;
    await ob.enqueue({ idempotencyKey: 'b', input: { text: '2' } });
    const client = mockClient();
    const res = await ob.flush(client);
    expect(res).toMatchObject({ flushed: 2, failed: 0, deadLettered: 0, deferred: 0 });
    expect(client.starts.map((s) => s.idempotencyKey)).toEqual(['a', 'b']);
    expect(await ob.pending()).toEqual([]);
  });

  it('buffers and replays client→run events (postEvent)', async () => {
    const ob = createRunOutbox();
    await ob.enqueueEvent('run-9', { kind: 'approval.decision', payload: { taskId: 't', action: 'approve' } });
    const client = mockClient();
    const res = await ob.flush(client);
    expect(res.flushed).toBe(1);
    expect(client.posts).toEqual([{ runId: 'run-9', payload: { kind: 'approval.decision', payload: { taskId: 't', action: 'approve' } } }]);
  });

  it('keeps failed items pending and records lastError', async () => {
    const ob = createRunOutbox({ now: () => 1000 });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const client = mockClient({ onStart: () => { throw new Error('offline'); } });
    const res = await ob.flush(client);
    expect(res).toMatchObject({ flushed: 0, failed: 1 });
    const pending = await ob.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
    expect(pending[0]!.lastError).toBe('offline');
  });
});

describe('createRunOutbox v2 — backoff', () => {
  it('defers a failed item until its backoff window elapses', async () => {
    let t = 1000;
    const ob = createRunOutbox({ now: () => t, backoffMs: [0, 5000], maxAttempts: 9 });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const failing = mockClient({ onStart: () => { throw new Error('net'); } });

    // First flush fails → schedules nextAttemptAt = now + backoff[1] = 6000.
    expect((await ob.flush(failing)).failed).toBe(1);
    expect((await ob.pending())[0]!.nextAttemptAt).toBe(6000);

    // Still inside the backoff window → deferred, not attempted.
    t = 5999;
    const res2 = await ob.flush(failing);
    expect(res2).toMatchObject({ deferred: 1, failed: 0, flushed: 0 });
    expect((await ob.pending())[0]!.attempts).toBe(1); // unchanged

    // Window elapsed → retried, and this time it succeeds.
    t = 6000;
    const ok = mockClient();
    expect((await ob.flush(ok)).flushed).toBe(1);
    expect(await ob.pending()).toEqual([]);
  });
});

describe('createRunOutbox v2 — dead-letter', () => {
  it('moves an item to the dead-letter queue after maxAttempts', async () => {
    let t = 0;
    const dead: OutboxItem[] = [];
    const ob = createRunOutbox({ now: () => t, maxAttempts: 3, backoffMs: [0], onDeadLetter: (i) => dead.push(i) });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const failing = mockClient({ onStart: () => { throw new Error('always fails'); } });

    await ob.flush(failing); // attempt 1
    await ob.flush(failing); // attempt 2
    const final = await ob.flush(failing); // attempt 3 → dead-letter
    expect(final.deadLettered).toBe(1);
    expect(await ob.pending()).toEqual([]);
    const dl = await ob.deadLettered();
    expect(dl).toHaveLength(1);
    expect(dl[0]!.attempts).toBe(3);
    expect(dl[0]!.lastError).toBe('always fails');
    expect(dead).toHaveLength(1); // onDeadLetter fired
  });

  it('clearDeadLetter empties the dead-letter queue', async () => {
    const ob = createRunOutbox({ maxAttempts: 1, backoffMs: [0] });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    await ob.flush(mockClient({ onStart: () => { throw new Error('x'); } }));
    expect(await ob.deadLettered()).toHaveLength(1);
    await ob.clearDeadLetter();
    expect(await ob.deadLettered()).toEqual([]);
  });
});

describe('createRunOutbox v2 — attachAutoFlush', () => {
  it('flushes on online and immediately when already online', async () => {
    const ob = createRunOutbox();
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const client = mockClient();
    const listeners: Record<string, () => void> = {};
    const target = {
      addEventListener: (t: string, cb: () => void) => { listeners[t] = cb; },
      removeEventListener: (t: string) => { delete listeners[t]; },
    };
    let online = false;
    const onFlush = vi.fn();
    const detach = ob.attachAutoFlush(client, { target, isOnline: () => online, onFlush });

    // Already-online flush at attach time did nothing (offline).
    expect(client.starts).toHaveLength(0);

    // Going online triggers a flush.
    online = true;
    listeners['online']!();
    await vi.waitFor(() => expect(client.starts).toHaveLength(1));
    expect(onFlush).toHaveBeenCalled();

    detach();
    expect(listeners['online']).toBeUndefined();
  });

  it('does not flush while offline', async () => {
    const ob = createRunOutbox();
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const client = mockClient();
    ob.attachAutoFlush(client, { target: { addEventListener() {}, removeEventListener() {} }, isOnline: () => false });
    await new Promise((r) => setTimeout(r, 5));
    expect(client.starts).toHaveLength(0);
  });
});

describe('createRunOutbox v2 — robustness & stress', () => {
  it('ignores corrupt / foreign storage entries', async () => {
    const storage = new MemoryStorage();
    storage.setItem('__weave_outbox__:bad', '{not json');
    storage.setItem('__weave_outbox__:wrong', JSON.stringify({ id: 'x', kind: 'bogus' }));
    storage.setItem('unrelated', 'keep');
    const ob = createRunOutbox({ storage });
    await ob.enqueue({ idempotencyKey: 'a', input: { text: '1' } });
    const pending = await ob.pending();
    expect(pending).toHaveLength(1); // only the valid item
    expect(storage.getItem('unrelated')).toBe('keep');
  });

  it('clear removes pending but not dead-letter', async () => {
    const ob = createRunOutbox({ maxAttempts: 1, backoffMs: [0] });
    await ob.enqueue({ idempotencyKey: 'dead', input: { text: 'x' } });
    await ob.flush(mockClient({ onStart: () => { throw new Error('x'); } })); // → dead-letter
    await ob.enqueue({ idempotencyKey: 'live', input: { text: 'y' } });
    await ob.clear();
    expect(await ob.pending()).toEqual([]);
    expect(await ob.deadLettered()).toHaveLength(1);
  });

  it('flushes a large batch in order', async () => {
    const ob = createRunOutbox({ now: (() => { let n = 0; return () => n++; })() });
    for (let i = 0; i < 500; i++) await ob.enqueue({ idempotencyKey: `k${i}`, input: { i } });
    const client = mockClient();
    const res = await ob.flush(client);
    expect(res.flushed).toBe(500);
    expect(client.starts.map((s) => s.idempotencyKey)).toEqual(Array.from({ length: 500 }, (_, i) => `k${i}`));
  });
});
