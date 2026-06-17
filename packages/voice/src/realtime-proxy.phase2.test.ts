/**
 * VoiceRealtimeProxy — Phase 2 unit tests
 *
 * Tests: turn counting, session rotation (transparent upstream WS swap),
 * onRotateSession callback, rotation with updated system prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RealtimeProxyCallbacks } from './realtime-proxy.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const mockState = vi.hoisted(() => ({
  instances: [] as MockWsInstance[],
  reset: () => { mockState.instances.length = 0; },
}));

interface MockWsInstance {
  url: string;
  readyState: number;
  sent: string[];
  close: (code?: number, reason?: string) => void;
  receive: (event: unknown) => void;
  messages: () => unknown[];
  ofType: (type: string) => unknown[];
  emitOpen: () => void;
}

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  class MockWs extends EE {
    static OPEN   = 1 as const;
    static CLOSED = 3 as const;
    readyState = 1;
    readonly sent: string[] = [];
    readonly url: string;

    constructor(url: string, _opts?: unknown) {
      super();
      this.url = url as string;
      const self = this;
      const inst: MockWsInstance = {
        get url()       { return self.url; },
        get readyState(){ return self.readyState; },
        sent:           self.sent,
        close:          (code = 1000, reason = '') => { self.readyState = 3; self.emit('close', code, Buffer.from(String(reason))); },
        receive:        (ev: unknown) => { self.emit('message', Buffer.from(JSON.stringify(ev))); },
        messages:       () => self.sent.map((s: string) => JSON.parse(s) as unknown),
        ofType:         (t: string) => self.sent.map((s: string) => JSON.parse(s) as Record<string, unknown>).filter((m) => m['type'] === t),
        emitOpen:       () => { self.emit('open'); },
      };
      mockState.instances.push(inst);
      // Don't auto-emit open — tests control this for rotation scenarios
    }

    send(data: string): void { this.sent.push(data); }
    close(code = 1000, reason = ''): void { this.readyState = 3; this.emit('close', code, Buffer.from(String(reason))); }
  }

  return { default: MockWs };
});

import { VoiceRealtimeProxy } from './realtime-proxy.js';

// ── Client WS stub ────────────────────────────────────────────────────────────

class ClientWsStub extends EventEmitter {
  static OPEN = 1;
  readyState  = 1;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void            { this.readyState = 3; }
  receive(msg: unknown): void { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  messages(): unknown[]   { return this.sent.map((s) => JSON.parse(s) as unknown); }
  ofType(t: string): unknown[] {
    return this.messages().filter((m) => (m as Record<string, unknown>)['type'] === t);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function audioDelta(itemId: string, ms = 100): Record<string, unknown> {
  return {
    type: 'response.output_audio.delta',
    item_id: itemId,
    response_id: 'resp_test',
    output_index: 0,
    content_index: 0,
    delta: btoa('A'.repeat(Math.round(ms * 48))),
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('VoiceRealtimeProxy — Phase 2 (turn counting & session rotation)', () => {
  let clientWs: ClientWsStub;
  let proxy: VoiceRealtimeProxy;

  async function startProxy(opts?: {
    rotateAfterTurns?: number;
    onRotateSession?: RealtimeProxyCallbacks['onRotateSession'];
  }): Promise<void> {
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();

    proxy.start({
      clientWs: clientWs as never,
      apiKey:   'test-key',
      model:    'gpt-realtime-2',
      voice:    'alloy',
      systemPrompt: 'Initial system prompt.',
      rotateAfterTurns: opts?.rotateAfterTurns ?? 3, // use 3 in tests so we hit it fast
      callbacks: {
        onRotateSession: opts?.onRotateSession,
      },
    });

    // Emit 'open' on the first (and only initial) WS
    mockState.instances[0]?.emitOpen();
    await sleep(10);
    // Clear session.update + realtime_ready noise
    mockState.instances[0]!.sent.length = 0;
    clientWs.sent.length = 0;
  }

  function oai(index = 0): MockWsInstance { return mockState.instances[index]!; }

  /** Simulate one complete response.done turn */
  function completeTurn(turnNum = 0): void {
    const idx = `item_t${turnNum}`;
    oai().receive(audioDelta(idx));
    oai().receive({ type: 'response.output_audio_transcript.done', transcript: `user said ${turnNum}` });
    oai().receive({ type: 'response.done', response: { id: `resp_${turnNum}`, usage: { input_tokens: 10, output_tokens: 20 } } });
  }

  beforeEach(async () => { await startProxy(); });
  afterEach(() => { proxy.close(); });

  // ── 1. Turn counting ──────────────────────────────────────────────────────

  it('counts turns and exposes them through onTurnComplete', async () => {
    const turnCompletions: number[] = [];
    proxy.close();
    await startProxy({
      onRotateSession: async (n: number) => ({ systemPrompt: `rotated at ${n}` }),
    });

    // Re-wire so we can spy — restart with a callback
    proxy.close();
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs: clientWs as never,
      apiKey: 'test-key',
      model: 'gpt-realtime-2',
      voice: 'alloy',
      rotateAfterTurns: 100, // disable rotation for this test
      callbacks: {
        onTurnComplete: (_ms) => { turnCompletions.push(turnCompletions.length + 1); },
      },
    });
    oai().emitOpen();
    await sleep(10);
    oai().sent.length = 0;
    clientWs.sent.length = 0;

    oai().receive({ type: 'response.done', response: { id: 'r1', usage: { input_tokens: 5, output_tokens: 5 } } });
    oai().receive({ type: 'response.done', response: { id: 'r2', usage: { input_tokens: 5, output_tokens: 5 } } });

    expect(turnCompletions).toEqual([1, 2]);
  });

  // ── 2. Session rotation triggered at correct turn ─────────────────────────

  it('triggers rotation after rotateAfterTurns completions', async () => {
    let rotationCallCount = 0;
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => { rotationCallCount++; return { systemPrompt: 'rotated prompt' }; },
    });

    // Turn 1
    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    expect(rotationCallCount).toBe(0);

    // Turn 2 — rotation should fire
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(30); // let async rotation start

    expect(rotationCallCount).toBe(1);
  });

  // ── 3. New WS opened with updated system prompt ───────────────────────────

  it('opens a new OpenAI WS during rotation with updated system prompt', async () => {
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => ({ systemPrompt: 'ROTATED_PROMPT' }),
    });

    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(30); // rotation starts asynchronously

    // A second WS instance should have been created
    expect(mockState.instances.length).toBeGreaterThanOrEqual(2);

    // Emit open on the new WS to complete rotation
    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    // New WS should have received session.update with the rotated prompt
    const sessionUpdates = newWs.ofType('session.update') as Array<{ session: { instructions: string } }>;
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]?.session.instructions).toBe('ROTATED_PROMPT');
  });

  // ── 4. Old WS is closed after rotation ───────────────────────────────────

  it('gracefully closes the old OpenAI WS after rotation', async () => {
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => ({ systemPrompt: 'new' }),
    });

    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(20);

    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    // Old WS should now be closed
    expect(oai(0).readyState).toBe(3);
  });

  // ── 5. Client WS stays open during rotation ───────────────────────────────

  it('client WebSocket stays open throughout rotation', async () => {
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => ({ systemPrompt: 'new' }),
    });

    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(20);

    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    expect(clientWs.readyState).toBe(1); // OPEN
  });

  // ── 6. Events from new WS are relayed to client after rotation ────────────

  it('events from the new OpenAI WS are relayed to client after rotation', async () => {
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => ({ systemPrompt: 'new' }),
    });

    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(20);

    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    clientWs.sent.length = 0; // clear previous events

    // Simulate a turn on the NEW WS
    newWs.receive({ type: 'input_audio_buffer.speech_started' });

    // speech_started should reach the client (relayed through new WS)
    expect(clientWs.ofType('speech_started')).toHaveLength(1);
  });

  // ── 7. Rotation does NOT fire again until next cycle ──────────────────────

  it('rotation does not fire a second time until next cycle of rotateAfterTurns', async () => {
    let rotationCount = 0;
    proxy.close();
    await startProxy({
      rotateAfterTurns: 2,
      onRotateSession: async () => { rotationCount++; return { systemPrompt: 'new' }; },
    });

    // First cycle (2 turns → rotation)
    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(20);

    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    expect(rotationCount).toBe(1);

    // Turn 3 on new WS — should NOT trigger rotation (only at turn 4)
    newWs.receive({ type: 'response.done', response: { id: 'r3' } });
    await sleep(20);
    expect(rotationCount).toBe(1); // still 1

    // Turn 4 — triggers second rotation
    newWs.receive({ type: 'response.done', response: { id: 'r4' } });
    await sleep(20);
    expect(rotationCount).toBe(2);
  });

  // ── 8. Fallback: no onRotateSession → reuses existing prompt ──────────────

  it('uses existing systemPrompt when onRotateSession is not provided', async () => {
    proxy.close();
    await startProxy({ rotateAfterTurns: 2 }); // no onRotateSession

    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    oai(0).receive({ type: 'response.done', response: { id: 'r2' } });
    await sleep(20);

    const newWs = mockState.instances[mockState.instances.length - 1]!;
    newWs.emitOpen();
    await sleep(10);

    const sessionUpdates = newWs.ofType('session.update') as Array<{ session: { instructions: string } }>;
    expect(sessionUpdates).toHaveLength(1);
    // Falls back to original prompt
    expect(sessionUpdates[0]?.session.instructions).toBe('Initial system prompt.');
  });

  // ── 9. rotateAfterTurns: 0 disables rotation ──────────────────────────────

  it('rotation is disabled when rotateAfterTurns is 0', async () => {
    let rotationCount = 0;
    proxy.close();
    await startProxy({
      rotateAfterTurns: 0,
      onRotateSession: async () => { rotationCount++; return { systemPrompt: 'new' }; },
    });

    // Many turns — no rotation
    for (let i = 0; i < 20; i++) {
      oai(0).receive({ type: 'response.done', response: { id: `r${i}` } });
    }
    await sleep(20);

    expect(rotationCount).toBe(0);
    expect(mockState.instances.length).toBe(1); // only the original WS
  });

  // ── 10. Transcript captured and accessible in onRotateSession ─────────────

  it('passes lastTranscript to onRotateSession callback', async () => {
    let capturedTranscript = '';
    proxy.close();
    await startProxy({
      rotateAfterTurns: 1,
      onRotateSession: async (_turnCount: number, lastTxn: string) => {
        capturedTranscript = lastTxn;
        return { systemPrompt: 'new' };
      },
    });

    // Fire a transcript then complete the turn
    oai(0).receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello world' });
    oai(0).receive({ type: 'response.done', response: { id: 'r1' } });
    await sleep(30);

    expect(capturedTranscript).toBe('Hello world');
  });
});
