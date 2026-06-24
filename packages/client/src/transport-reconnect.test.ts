/**
 * Phase 0 — transport lifecycle + run-client auto-reconnect.
 *
 * Covers the seam that was previously dead code (`void scheduleReconnect`):
 *   - sseTransport lifecycle: onOpen / onEvent / onClose(permanent) / onError,
 *     permanent-vs-transient classification, stall timeout, malformed-event
 *     resilience.
 *   - run-client.attach(): real reconnect with backoff + cursor resume + dedup,
 *     give-up after maxReconnects, permanent-close stop, abort stops reconnect.
 *
 * Includes positive, negative, stress, and security cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sseTransport, createRunClient } from './index.js';
import type { EventTransport, StreamLifecycle, RunEventEnvelope } from './index.js';

// ─── Helpers ─────────────────────────────────────────────────

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** A transport whose Nth `openStream` runs the Nth script (last script repeats). */
function scriptedTransport(scripts: Array<(life: StreamLifecycle, url: string) => void>): {
  transport: EventTransport;
  opens: string[];
} {
  const opens: string[] = [];
  let i = 0;
  return {
    opens,
    transport: {
      openStream(url, life) {
        opens.push(url);
        const script = scripts[Math.min(i, scripts.length - 1)]!;
        i++;
        script(life, url);
      },
    },
  };
}

const env = (sequence: number, kind: string, payload: Record<string, unknown> = {}): RunEventEnvelope =>
  ({ runId: 'r1', sequence, kind, payload });
const sseFrame = (e: RunEventEnvelope): string => `data: ${JSON.stringify(e)}\n\n`;

// ═══════════════════════════════════════════════════════════════
// sseTransport — lifecycle
// ═══════════════════════════════════════════════════════════════

describe('sseTransport — lifecycle (positive)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fires onOpen, parses each event, then onClose(transient)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      sseFrame(env(0, 'run.started')),
      sseFrame(env(1, 'text.delta', { delta: 'hi' })),
    ]), { status: 200 })));

    const events: string[] = [];
    let opened = false;
    const close = await new Promise<{ permanent: boolean }>((resolve) => {
      sseTransport({}).openStream('http://x/events', {
        onOpen: () => { opened = true; },
        onEvent: (e) => { events.push(e.data); },
        onClose: resolve,
      });
    });

    expect(opened).toBe(true);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]!).payload.delta).toBe('hi');
    expect(close.permanent).toBe(false);
  });

  it('honours an onEvent stop (returns true) and closes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      sseFrame(env(0, 'run.started')),
      sseFrame(env(1, 'run.completed')),
      sseFrame(env(2, 'text.delta')), // must NOT be delivered after stop
    ]), { status: 200 })));

    const kinds: string[] = [];
    await new Promise<void>((resolve) => {
      sseTransport({}).openStream('http://x', {
        onEvent: (e) => {
          const k = JSON.parse(e.data).kind as string;
          kinds.push(k);
          return k === 'run.completed'; // stop
        },
        onClose: () => resolve(),
      });
    });
    expect(kinds).toEqual(['run.started', 'run.completed']);
  });
});

describe('sseTransport — failure classification (negative)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies a 4xx open as PERMANENT (no reconnect)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const errs: Error[] = [];
    const info = await new Promise<{ permanent: boolean }>((resolve) => {
      sseTransport({}).openStream('http://x', {
        onEvent: () => {},
        onError: (e) => errs.push(e),
        onClose: resolve,
      });
    });
    expect(info.permanent).toBe(true);
    expect(errs[0]?.message).toContain('403');
  });

  it('classifies a 5xx open as TRANSIENT (reconnectable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const info = await new Promise<{ permanent: boolean }>((resolve) => {
      sseTransport({}).openStream('http://x', { onEvent: () => {}, onClose: resolve });
    });
    expect(info.permanent).toBe(false);
  });

  it('classifies a thrown fetch (network drop) as TRANSIENT + reports onError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const errs: Error[] = [];
    const info = await new Promise<{ permanent: boolean }>((resolve) => {
      sseTransport({}).openStream('http://x', {
        onEvent: () => {},
        onError: (e) => errs.push(e),
        onClose: resolve,
      });
    });
    expect(info.permanent).toBe(false);
    expect(errs[0]?.message).toContain('ECONNRESET');
  });

  it('tears down a stalled stream within stallTimeoutMs', async () => {
    // Body that opens but never emits or closes → read() hangs → stall fires.
    const hanging = new ReadableStream<Uint8Array>({ start() { /* never enqueue/close */ } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(hanging, { status: 200 })));
    const errs: Error[] = [];
    const info = await new Promise<{ permanent: boolean }>((resolve) => {
      sseTransport({ stallTimeoutMs: 25 }).openStream('http://x', {
        onEvent: () => {},
        onError: (e) => errs.push(e),
        onClose: resolve,
      });
    });
    expect(info.permanent).toBe(false);
    expect(errs.some((e) => /stall/i.test(e.message))).toBe(true);
  });
});

describe('sseTransport — resilience (security/robustness)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores malformed frames without throwing and keeps delivering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody([
      'data: {not json\n\n',
      sseFrame(env(0, 'run.started')),
    ]), { status: 200 })));
    const ok: unknown[] = [];
    await new Promise<void>((resolve) => {
      sseTransport({}).openStream('http://x', {
        // The transport delivers raw frames; the caller parses. Malformed JSON
        // here is delivered as a raw string and must not crash the reader.
        onEvent: (e) => { try { ok.push(JSON.parse(e.data)); } catch { /* caller-side */ } },
        onClose: () => resolve(),
      });
    });
    expect(ok).toHaveLength(1); // only the valid frame parsed
  });

  it('passes the bearer token in the Authorization header (no token in URL)', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer s3cr3t');
      return new Response(sseBody([sseFrame(env(0, 'run.started'))]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    await new Promise<void>((resolve) => {
      sseTransport({ auth: 's3cr3t' }).openStream('http://x/events', { onEvent: () => {}, onClose: () => resolve() });
    });
    expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('s3cr3t');
  });
});

// ═══════════════════════════════════════════════════════════════
// run-client.attach — auto-reconnect
// ═══════════════════════════════════════════════════════════════

describe('run-client.attach — reconnect (positive)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects after a transient close, resumes from cursor, dedups overlap', async () => {
    const { transport, opens } = scriptedTransport([
      // 1st connection: deliver 0,1 then drop (transient close).
      (life) => { life.onOpen?.(); life.onEvent({ data: JSON.stringify(env(0, 'run.started')) }); life.onEvent({ data: JSON.stringify(env(1, 'text.delta', { delta: 'a' })) }); life.onClose?.({ permanent: false }); },
      // 2nd connection: replay 1 (overlap → deduped) then 2 then terminal.
      (life) => { life.onOpen?.(); life.onEvent({ data: JSON.stringify(env(1, 'text.delta', { delta: 'a' })) }); life.onEvent({ data: JSON.stringify(env(2, 'text.delta', { delta: 'b' })) }); life.onEvent({ data: JSON.stringify(env(3, 'run.completed')) }); life.onClose?.({ permanent: false }); },
    ]);
    const got: number[] = [];
    let done = false; let err: Error | undefined;
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { onEvent: (e) => got.push(e.sequence), onComplete: () => { done = true; }, onError: (e) => { err = e; } });

    await vi.runAllTimersAsync(); // fire the backoff timer → 2nd connect

    expect(got).toEqual([0, 1, 2, 3]); // sequence 1 NOT delivered twice
    expect(done).toBe(true);
    expect(err).toBeUndefined();
    expect(opens).toHaveLength(2);
    expect(opens[0]).toContain('after=-1');
    expect(opens[1]).toContain('after=1'); // resumed from last-seen cursor
  });
});

describe('run-client.attach — reconnect (negative)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does NOT reconnect on a permanent (4xx) close — surfaces onError once', async () => {
    const { opens, transport } = scriptedTransport([
      (life) => { life.onClose?.({ permanent: true }); },
    ]);
    let err: Error | undefined;
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { onEvent: () => {}, onError: (e) => { err = e; } });
    await vi.runAllTimersAsync();
    expect(opens).toHaveLength(1); // never retried
    expect(err?.message).toMatch(/permanent/i);
  });

  it('gives up after maxReconnects and reports onError', async () => {
    const { opens, transport } = scriptedTransport([
      (life) => { life.onClose?.({ permanent: false }); }, // always drops with no events
    ]);
    let err: Error | undefined;
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { maxReconnects: 3, backoffMs: [1, 1, 1], onEvent: () => {}, onError: (e) => { err = e; } });
    await vi.runAllTimersAsync();
    expect(opens).toHaveLength(1 + 3); // initial + 3 retries
    expect(err?.message).toMatch(/after 3 reconnects/);
  });

  it('maxReconnects=0 disables auto-reconnect', async () => {
    const { opens, transport } = scriptedTransport([(life) => life.onClose?.({ permanent: false })]);
    let err: Error | undefined;
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { maxReconnects: 0, onEvent: () => {}, onError: (e) => { err = e; } });
    await vi.runAllTimersAsync();
    expect(opens).toHaveLength(1);
    expect(err?.message).toMatch(/disabled/i);
  });

  it('aborting the controller stops further reconnects', async () => {
    const { opens, transport } = scriptedTransport([(life) => life.onClose?.({ permanent: false })]);
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    const ctrl = client.attach('r1', { maxReconnects: 5, backoffMs: [50], onEvent: () => {} });
    ctrl.abort(); // detach before the backoff timer fires
    await vi.runAllTimersAsync();
    expect(opens).toHaveLength(1); // no reconnect after abort
  });
});

describe('run-client.attach — reconnect (stress + security)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('survives 50 transient flaps while making forward progress (budget resets on progress)', async () => {
    let seq = 0;
    // Each connection delivers exactly one new event then drops — forward
    // progress must reset the reconnect budget so it never gives up.
    const oneThenDrop = (life: StreamLifecycle) => {
      life.onOpen?.();
      if (seq < 50) { life.onEvent({ data: JSON.stringify(env(seq, 'text.delta', { delta: String(seq) })) }); seq++; }
      else { life.onEvent({ data: JSON.stringify(env(seq, 'run.completed')) }); }
      life.onClose?.({ permanent: false });
    };
    const { opens, transport } = scriptedTransport([oneThenDrop]);
    const got: number[] = [];
    let done = false; let err: Error | undefined;
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { maxReconnects: 8, backoffMs: [1], onEvent: (e) => got.push(e.sequence), onComplete: () => { done = true; }, onError: (e) => { err = e; } });
    await vi.runAllTimersAsync();
    expect(done).toBe(true);
    expect(err).toBeUndefined();
    expect(got).toHaveLength(51); // 50 deltas + terminal, monotonic, no dupes
    expect(new Set(got).size).toBe(51);
    expect(opens.length).toBeGreaterThan(50);
  });

  it('never resumes from a forged lower cursor (monotonic guard rejects replay attacks)', async () => {
    const { transport } = scriptedTransport([
      (life) => {
        life.onOpen?.();
        life.onEvent({ data: JSON.stringify(env(5, 'text.delta', { delta: 'real' })) });
        // A malicious/duplicate replay of an OLDER sequence must be ignored.
        life.onEvent({ data: JSON.stringify(env(2, 'text.delta', { delta: 'STALE' })) });
        life.onEvent({ data: JSON.stringify(env(6, 'run.completed')) });
        life.onClose?.({ permanent: false });
      },
    ]);
    const deltas: string[] = [];
    const client = createRunClient({ baseUrl: 'http://x', sse: transport, json: {} as never });
    client.attach('r1', { afterSequence: 4, onEvent: (e) => { if (e.kind === 'text.delta') deltas.push(String(e.payload['delta'])); } });
    await vi.runAllTimersAsync();
    expect(deltas).toEqual(['real']); // the stale/lower-sequence event was dropped
  });
});
