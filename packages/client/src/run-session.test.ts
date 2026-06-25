/**
 * Unit tests — createRunSession (framework-agnostic run UX controller).
 * Positive · negative · stress · security, against a fully controllable mock
 * RunClient so we drive the SSE event stream by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRunSession, RunResumeExpiredError, type RunSession, type RunSessionState } from './run-session.js';
import { createRunCursorStore } from './cursor.js';
import { MemoryStorage } from './outbox.js';
import type { RunClient, RunRecord, StartRunInput, AttachOptions } from './run-client.js';
import type { RunEventEnvelope } from './reducer.js';

// ---------------------------------------------------------------------------
// Mock RunClient — records calls and exposes the live attach handle so a test
// can push events / completion / errors deterministically.
// ---------------------------------------------------------------------------
interface Harness {
  client: RunClient;
  starts: StartRunInput[];
  cancels: string[];
  posted: Array<{ runId: string; payload: Record<string, unknown> }>;
  attaches: number;
  /** Push an event to the currently attached run. */
  push: (env: Partial<RunEventEnvelope> & { kind: string; sequence: number }) => void;
  complete: () => void;
  fail: (err: Error) => void;
  lastAttach: () => AttachOptions | null;
  /** Control what startRun resolves to / rejects with. */
  setStartResult: (r: RunRecord | (() => Promise<RunRecord>)) => void;
}

function harness(): Harness {
  let attachOpts: AttachOptions | null = null;
  let attachController: AbortController | null = null;
  let startResult: RunRecord | (() => Promise<RunRecord>) = { id: 'run-1', status: 'running' };
  const h: Harness = {
    starts: [],
    cancels: [],
    posted: [],
    attaches: 0,
    lastAttach: () => attachOpts,
    setStartResult: (r) => { startResult = r; },
    push: (env) => {
      const full: RunEventEnvelope = {
        runId: 'run-1', sequence: env.sequence, kind: env.kind,
        payload: env.payload ?? {},
      } as RunEventEnvelope;
      attachOpts?.onEvent(full);
    },
    complete: () => attachOpts?.onComplete?.(),
    fail: (err) => attachOpts?.onError?.(err),
    client: {
      async startRun(input) {
        h.starts.push(input);
        return typeof startResult === 'function' ? startResult() : startResult;
      },
      async getRun() { return null; },
      async listRuns() { return []; },
      async cancelRun(id) { h.cancels.push(id); },
      attach(_runId, opts) {
        h.attaches++;
        attachOpts = opts;
        attachController = new AbortController();
        opts.signal?.addEventListener('abort', () => attachController?.abort());
        return attachController;
      },
      async postEvent(runId, payload) { h.posted.push({ runId, payload }); },
      async setPresence() { return { participants: [] }; },
      async shareRun() { return { sessionId: 's', token: 't', tokenId: 'tid', role: 'viewer', url: '/shared/t', expiresAt: null }; },
      async joinSession() { return { runId: 'run-1', sessionId: 's', role: 'viewer' }; },
      async removeMember() { return { removed: true, streamsClosed: 0 }; },
      async endShare() { return { ended: true, streamsClosed: 0 }; },
      async subscribeRun() { return { subscribed: true, runId: 'run-1', channels: ['inapp'] }; },
      async unsubscribeRun() { return { subscribed: false }; },
      async getSubscription() { return { subscribed: false, channels: [] }; },
      async listNotifications() { return { items: [], unreadCount: 0 }; },
      async markAllNotificationsRead() { return { read: 0 }; },
      async addComment() { return { comment: {} }; },
      async listComments() { return { comments: [], role: 'owner' }; },
      async editComment() { return { comment: {} }; },
      async deleteComment() { return { deleted: true }; },
      async resolveThread() { return { resolved: true }; },
      async reopenThread() { return { reopened: true }; },
      async addAnnotation() { return { annotation: {} }; },
      async listAnnotations() { return { annotations: [], summary: [] }; },
      async createRunPublicShare() { return { id: 's', token: 't', url: '/share/runs/t', expiresAt: null }; },
    },
  };
  return h;
}

const textDelta = (seq: number, delta: string) => ({ kind: 'text.delta', sequence: seq, payload: { delta } });

describe('createRunSession — happy path lifecycle', () => {
  let h: Harness;
  let s: RunSession;
  beforeEach(() => { h = harness(); s = createRunSession({ client: h.client }); });

  it('starts idle', () => {
    expect(s.getState().status).toBe('idle');
    expect(s.getState().runId).toBeNull();
  });

  it('transitions idle → submitted → streaming → ready', async () => {
    const seen: string[] = [];
    s.subscribe((st) => seen.push(st.status));
    const idP = s.start({ input: { text: 'hi' }, metadata: { mode: 'agent' } });
    expect(s.getState().status).toBe('submitted');
    const id = await idP;
    expect(id).toBe('run-1');
    expect(s.getState().runId).toBe('run-1');

    h.push(textDelta(0, 'Hello'));
    expect(s.getState().status).toBe('streaming');
    expect(s.getState().model.fullText).toContain('Hello');

    h.push({ kind: 'run.completed', sequence: 1 });
    h.complete();
    expect(s.getState().status).toBe('ready');
    // Collapse consecutive duplicates → the distinct lifecycle transitions.
    const transitions = seen.filter((v, i) => v !== seen[i - 1]);
    expect(transitions).toEqual(['submitted', 'streaming', 'ready']);
  });

  it('forwards input / metadata / surface / idempotency key to startRun', async () => {
    await s.start({ input: { text: 'q' }, metadata: { mode: 'supervisor' }, surface: 'mobile', idempotencyKey: 'idem-9' });
    expect(h.starts[0]).toMatchObject({ idempotencyKey: 'idem-9', surface: 'mobile', input: { text: 'q' }, metadata: { mode: 'supervisor' } });
  });

  it('defaults surface to web and auto-generates an idempotency key', async () => {
    await s.start({ input: { text: 'q' } });
    expect(h.starts[0]!.surface).toBe('web');
    expect(typeof h.starts[0]!.idempotencyKey).toBe('string');
    expect(h.starts[0]!.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('done() resolves on terminal with the final snapshot', async () => {
    await s.start({ input: { text: 'hi' } });
    const donePromise = s.done();
    h.push({ kind: 'run.completed', sequence: 0 });
    h.complete();
    const final = await donePromise;
    expect(final.status).toBe('ready');
  });
});

describe('createRunSession — failure & error mapping', () => {
  it('maps run.failed → error status', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    h.push({ kind: 'run.failed', sequence: 0, payload: { message: 'boom' } });
    h.complete();
    expect(s.getState().status).toBe('error');
  });

  it('maps run.cancelled → ready status', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    h.push({ kind: 'run.cancelled', sequence: 0 });
    h.complete();
    expect(s.getState().status).toBe('ready');
  });

  it('attach onError settles the session as error and resolves done()', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    const d = s.done();
    h.fail(new Error('socket reset'));
    expect(s.getState().status).toBe('error');
    expect(s.getState().error?.message).toBe('socket reset');
    expect((await d).status).toBe('error');
  });

  it('rejects + settles error when startRun throws', async () => {
    const h = harness();
    h.setStartResult(() => Promise.reject(new Error('429 rate limited')));
    const s = createRunSession({ client: h.client });
    await expect(s.start({ input: { text: 'x' } })).rejects.toThrow('429 rate limited');
    expect(s.getState().status).toBe('error');
    expect(s.getState().error?.message).toBe('429 rate limited');
  });

  it('settles directly when the run is already terminal at creation', async () => {
    const h = harness();
    h.setStartResult({ id: 'run-x', status: 'failed' });
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    expect(s.getState().status).toBe('error');
    expect(h.attaches).toBe(0); // no stream attach for an already-terminal run
  });
});

describe('createRunSession — guards (negative)', () => {
  it('rejects a concurrent start while a run is in progress', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'a' } });
    await expect(s.start({ input: { text: 'b' } })).rejects.toThrow(/already in progress/);
  });

  it('allows a new start once the previous run is terminal', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'a' } });
    h.push({ kind: 'run.completed', sequence: 0 }); h.complete();
    await expect(s.start({ input: { text: 'b' } })).resolves.toBe('run-1');
    expect(h.starts.length).toBe(2);
  });

  it('regenerate before any start rejects', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await expect(s.regenerate()).rejects.toThrow(/nothing to regenerate/);
  });

  it('sendEvent without an active run rejects', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await expect(s.sendEvent({ kind: 'x' })).rejects.toThrow(/no active run/);
  });

  it('stop() when idle is a no-op (no cancel call)', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.stop();
    expect(h.cancels).toEqual([]);
    expect(s.getState().status).toBe('idle');
  });
});

describe('createRunSession — stop / regenerate / approvals', () => {
  it('stop() cancels the run and settles ready', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'long' } });
    h.push(textDelta(0, 'partial'));
    await s.stop();
    expect(h.cancels).toEqual(['run-1']);
    expect(s.getState().status).toBe('ready');
    expect(s.getState().model.fullText).toContain('partial'); // partial output retained
  });

  it('stop() still settles when cancelRun rejects (best effort)', async () => {
    const h = harness();
    h.client.cancelRun = async () => { throw new Error('already gone'); };
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    await expect(s.stop()).resolves.toBeUndefined();
    expect(s.getState().status).toBe('ready');
  });

  it('regenerate() re-runs the last input as a fresh run', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'first' }, metadata: { mode: 'agent' } });
    h.push({ kind: 'run.completed', sequence: 0 }); h.complete();
    await s.regenerate();
    expect(h.starts.length).toBe(2);
    expect(h.starts[1]).toMatchObject({ input: { text: 'first' }, metadata: { mode: 'agent' } });
  });

  it('approve() / reject() post an approval.decision event', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    await s.approve('task-1');
    await s.reject('task-2');
    expect(h.posted).toEqual([
      { runId: 'run-1', payload: { kind: 'approval.decision', payload: { taskId: 'task-1', action: 'approve' } } },
      { runId: 'run-1', payload: { kind: 'approval.decision', payload: { taskId: 'task-2', action: 'reject' } } },
    ]);
  });

  it('reset() clears to idle but keeps last input for regenerate', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'keep' } });
    h.push(textDelta(0, 'words'));
    s.reset();
    expect(s.getState().status).toBe('idle');
    expect(s.getState().model.fullText).toBe('');
    await s.regenerate();
    expect(h.starts[1]).toMatchObject({ input: { text: 'keep' } });
  });
});

describe('createRunSession — throttling (smooth streaming)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid deltas to one notification per window, flushing terminal immediately', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client, throttleMs: 50 });
    const calls: RunSessionState[] = [];
    s.subscribe((st) => calls.push(st));
    await s.start({ input: { text: 'x' } }); // immediate (submitted) ×2
    const baseline = calls.length;

    h.push(textDelta(0, 'a'));
    h.push(textDelta(1, 'b'));
    h.push(textDelta(2, 'c'));
    expect(calls.length).toBe(baseline); // all coalesced, none delivered yet

    await vi.advanceTimersByTimeAsync(50);
    expect(calls.length).toBe(baseline + 1); // one coalesced delivery
    expect(calls[calls.length - 1]!.model.fullText).toBe('abc');

    h.push({ kind: 'run.completed', sequence: 3 });
    h.complete(); // terminal flushes immediately, bypassing the throttle
    expect(calls[calls.length - 1]!.status).toBe('ready');
  });
});

describe('createRunSession — subscribe / dispose / stress', () => {
  it('unsubscribe stops further notifications', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    let n = 0;
    const off = s.subscribe(() => { n++; });
    await s.start({ input: { text: 'x' } });
    const at = n;
    off();
    h.push(textDelta(0, 'a'));
    expect(n).toBe(at);
  });

  it('dispose() detaches, clears listeners, and blocks further starts', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    let n = 0;
    s.subscribe(() => { n++; });
    await s.start({ input: { text: 'x' } });
    s.dispose();
    const at = n;
    h.push(textDelta(0, 'a')); // listeners cleared → no notify
    expect(n).toBe(at);
    await expect(s.start({ input: { text: 'y' } })).rejects.toThrow(/disposed/);
  });

  it('survives a burst of 1000 deltas and reconstructs the full text', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await s.start({ input: { text: 'x' } });
    for (let i = 0; i < 1000; i++) h.push(textDelta(i, 'x'));
    h.push({ kind: 'run.completed', sequence: 1000 }); h.complete();
    expect(s.getState().model.fullText.length).toBe(1000);
    expect(s.getState().status).toBe('ready');
  });

  it('a throwing subscriber does not corrupt state (isolated snapshot fan-out)', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    s.subscribe(() => { throw new Error('listener blew up'); });
    // The throw propagates out of notify synchronously; state is already updated.
    await expect(s.start({ input: { text: 'x' } })).rejects.toThrow('listener blew up');
    expect(s.getState().status).toBe('submitted');
  });
});

describe('createRunSession — Phase 6 cursor persistence & resume', () => {
  it('persists a cursor on each event and clears it on terminal', async () => {
    const h = harness();
    let t = 5000;
    const cursor = createRunCursorStore({ now: () => t });
    const s = createRunSession({ client: h.client, cursor, now: () => t });
    await s.start({ input: { text: 'x' }, surface: 'web' });

    h.push(textDelta(0, 'a'));
    await Promise.resolve(); // let the fire-and-forget cursor write settle
    let saved = await cursor.get('run-1');
    expect(saved).toMatchObject({ runId: 'run-1', lastSequence: 0, surface: 'web', updatedAt: 5000 });

    t = 6000;
    h.push(textDelta(1, 'b'));
    await Promise.resolve();
    saved = await cursor.get('run-1');
    expect(saved?.lastSequence).toBe(1);
    expect(saved?.updatedAt).toBe(6000);

    h.push({ kind: 'run.completed', sequence: 2 });
    h.complete();
    await Promise.resolve();
    expect(await cursor.get('run-1')).toBeNull(); // terminal clears the cursor
  });

  it('resume() rebuilds the view model via full replay and settles', async () => {
    const cursor = createRunCursorStore({ now: () => 1000 });
    await cursor.set({ runId: 'run-1', lastSequence: 3, surface: 'web' });
    const h = harness();
    const s = createRunSession({ client: h.client, cursor, resumeWindowMs: 900_000, now: () => 1000 });

    const id = await s.resume('run-1');
    expect(id).toBe('run-1');
    expect(s.getState().status).toBe('submitted');
    // Resume always replays from the beginning to rebuild the full model.
    expect(h.lastAttach()?.afterSequence).toBe(-1);

    h.push(textDelta(0, 'Hello'));
    h.push(textDelta(1, ' world'));
    expect(s.getState().status).toBe('streaming');
    h.push({ kind: 'run.completed', sequence: 2 });
    h.complete();
    expect(s.getState().status).toBe('ready');
    expect(s.getState().model.fullText).toBe('Hello world');
  });

  it('resume() rejects (and clears) a cursor outside the resume window', async () => {
    let t = 1000;
    const cursor = createRunCursorStore({ now: () => t });
    await cursor.set({ runId: 'run-1', lastSequence: 1 });
    const h = harness();
    const s = createRunSession({ client: h.client, cursor, resumeWindowMs: 60_000, now: () => t });

    t = 1000 + 60_001; // just past the window
    await expect(s.resume('run-1')).rejects.toBeInstanceOf(RunResumeExpiredError);
    expect(await cursor.get('run-1')).toBeNull(); // expired cursor pruned
    expect(s.getState().status).toBe('idle');
  });

  it('resume() without a cursor store rejects', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client });
    await expect(s.resume('run-1')).rejects.toThrow(/requires a cursor store/);
  });

  it('resume() with no persisted cursor for the run rejects', async () => {
    const h = harness();
    const s = createRunSession({ client: h.client, cursor: createRunCursorStore() });
    await expect(s.resume('ghost')).rejects.toThrow(/no persisted cursor/);
  });

  it('resume() is refused while a run is already in progress', async () => {
    const cursor = createRunCursorStore();
    await cursor.set({ runId: 'run-1', lastSequence: 1 });
    const h = harness();
    const s = createRunSession({ client: h.client, cursor });
    await s.start({ input: { text: 'x' } });
    await expect(s.resume('run-1')).rejects.toThrow(/already in progress/);
  });

  it('shares one cursor store across a "refresh" (new session resumes the prior run)', async () => {
    const storage = new MemoryStorage();
    const h = harness();

    // Session A starts and streams a couple of events, persisting the cursor.
    const cursorA = createRunCursorStore({ storage, now: () => 1000 });
    const a = createRunSession({ client: h.client, cursor: cursorA, now: () => 1000 });
    await a.start({ input: { text: 'x' }, surface: 'web' });
    h.push(textDelta(0, 'partial'));
    await Promise.resolve();
    a.dispose(); // simulate the tab closing mid-run (no terminal → cursor remains)

    expect(await createRunCursorStore({ storage }).get('run-1')).not.toBeNull();

    // Session B (fresh tab) resumes from the same storage and drives to ready.
    const cursorB = createRunCursorStore({ storage, now: () => 1500 });
    const b = createRunSession({ client: h.client, cursor: cursorB, resumeWindowMs: 900_000, now: () => 1500 });
    await b.resume('run-1');
    h.push(textDelta(0, 'partial'));
    h.push({ kind: 'run.completed', sequence: 1 });
    h.complete();
    expect(b.getState().status).toBe('ready');
    expect(b.getState().model.fullText).toBe('partial');
  });
});
