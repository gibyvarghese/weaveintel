/**
 * VoiceRealtimeProxy — barge-in unit tests
 *
 * Tests the three-part barge-in protocol without a live OpenAI connection.
 * Uses vi.hoisted() to share mock state between the vi.mock factory and tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Shared mock state — hoisted above vi.mock (required by Vitest) ────────────
const mockState = vi.hoisted(() => {
  return {
    lastOpenAIWs: null as {
      readyState: number;
      sent: string[];
      close: (code?: number, reason?: string) => void;
      receive: (event: unknown) => void;
      messages: () => unknown[];
      ofType: (type: string) => unknown[];
    } | null,
  };
});

// ── WebSocket mock — factory is self-contained except for hoisted state ────────
vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  class MockOpenAIWs extends EE {
    static OPEN   = 1 as const;
    static CLOSED = 3 as const;
    readyState = 1;
    readonly sent: string[] = [];

    constructor(_url: string, _opts?: unknown) {
      super();
      const self = this;
      mockState.lastOpenAIWs = {
        get readyState() { return self.readyState; },
        sent: self.sent,
        close:    (code = 1000, reason = '') => { self.readyState = 3; self.emit('close', code, Buffer.from(String(reason))); },
        receive:  (event: unknown) => { self.emit('message', Buffer.from(JSON.stringify(event))); },
        messages: () => self.sent.map((s: string) => JSON.parse(s) as unknown),
        ofType:   (type: string) => self.sent.map((s: string) => JSON.parse(s) as Record<string, unknown>).filter((m) => m['type'] === type),
      };
      setImmediate(() => self.emit('open'));
    }

    send(data: string): void { this.sent.push(data); }
    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.emit('close', code, Buffer.from(String(reason)));
    }
  }

  return { default: MockOpenAIWs };
});

// ── Import SUT after mock is registered ──────────────────────────────────────
import { VoiceRealtimeProxy } from './realtime-proxy.js';

// ── Client WebSocket stub ─────────────────────────────────────────────────────

class ClientWsStub extends EventEmitter {
  static OPEN   = 1;
  static CLOSED = 3;
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }

  receive(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  messages(): unknown[]       { return this.sent.map((s) => JSON.parse(s) as unknown); }
  ofType(t: string): unknown[] {
    return this.messages().filter((m) => (m as Record<string, unknown>)['type'] === t);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msToBase64(ms: number): string {
  return btoa('A'.repeat(Math.round(ms * 48))); // 24000 Hz × 2 bytes / 1000 ms
}

function audioDelta(itemId: string, ms = 200): Record<string, unknown> {
  return {
    type: 'response.output_audio.delta',
    item_id: itemId,
    response_id: 'resp_test',
    output_index: 0,
    content_index: 0,
    delta: msToBase64(ms),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('VoiceRealtimeProxy — barge-in', () => {
  let clientWs: ClientWsStub;
  let proxy: VoiceRealtimeProxy;

  async function startProxy(
    callbacks?: Parameters<VoiceRealtimeProxy['start']>[0]['callbacks'],
  ): Promise<void> {
    mockState.lastOpenAIWs = null;
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs: clientWs as never,
      apiKey: 'test-key',
      model: 'gpt-realtime-2',
      voice: 'alloy',
      systemPrompt: 'Test assistant',
      callbacks,
    });
    // Wait for mock OpenAI WS 'open' event (fires via setImmediate in mock ctor)
    await sleep(20);
    // Clear setup noise (session.update, realtime_ready)
    mockState.lastOpenAIWs!.sent.length = 0;
    clientWs.sent.length = 0;
  }

  function oai() { return mockState.lastOpenAIWs!; }

  beforeEach(async () => { await startProxy(); });
  afterEach(() => { proxy.close(); });

  // ── 1. Normal turn — no audio in flight ──────────────────────────────────

  it('sends speech_started when agent was silent (no audio in flight)', () => {
    oai().receive({ type: 'input_audio_buffer.speech_started' });

    expect(clientWs.ofType('speech_started')).toHaveLength(1);
    expect(clientWs.ofType('barge_in')).toHaveLength(0);
  });

  // ── 2. True barge-in — client responds in time ────────────────────────────

  it('true barge-in: sends barge_in, client reports audioPlayedMs, proxy sends truncate + ack', () => {
    const ITEM = 'item_001';
    oai().receive(audioDelta(ITEM, 500));
    oai().receive(audioDelta(ITEM, 300));
    clientWs.sent.length = 0;
    const oaiBefore = oai().sent.length;

    oai().receive({ type: 'input_audio_buffer.speech_started' });

    const bargInMsgs = clientWs.ofType('barge_in') as { itemId: string }[];
    expect(bargInMsgs).toHaveLength(1);
    expect(bargInMsgs[0]?.itemId).toBe(ITEM);
    expect(clientWs.ofType('speech_started')).toHaveLength(0);
    clientWs.sent.length = 0;

    clientWs.receive({ type: 'barge_in', itemId: ITEM, audioPlayedMs: 340 });

    const newOai = oai().sent.slice(oaiBefore).map((s) => JSON.parse(s) as Record<string, unknown>);
    const truncate = newOai.find((e) => e['type'] === 'conversation.item.truncate');
    expect(truncate).toMatchObject({
      type: 'conversation.item.truncate',
      item_id: ITEM,
      content_index: 0,
      audio_end_ms: 340,
    });

    const acks = clientWs.ofType('barge_in_ack') as { audioEndMs: number }[];
    expect(acks).toHaveLength(1);
    expect(acks[0]?.audioEndMs).toBe(340);
  });

  // ── 3. Fallback timer ─────────────────────────────────────────────────────

  it('fallback fires after 200ms when client does not respond — uses PCM byte estimate', async () => {
    const ITEM = 'item_002';
    oai().receive(audioDelta(ITEM, 400));
    const oaiBefore = oai().sent.length;
    oai().receive({ type: 'input_audio_buffer.speech_started' });
    expect(clientWs.ofType('barge_in')).toHaveLength(1);
    clientWs.sent.length = 0;

    await sleep(260); // past the 200ms fallback

    const newOai = oai().sent.slice(oaiBefore).map((s) => JSON.parse(s) as Record<string, unknown>);
    const t = newOai.find((e) => e['type'] === 'conversation.item.truncate') as
      { item_id: string; audio_end_ms: number } | undefined;

    expect(t, 'fallback truncate should have been sent').toBeDefined();
    expect(t!.item_id).toBe(ITEM);
    expect(t!.audio_end_ms).toBeGreaterThanOrEqual(380);
    expect(t!.audio_end_ms).toBeLessThanOrEqual(420);

    const acks = clientWs.ofType('barge_in_ack') as { audioEndMs: number }[];
    expect(acks).toHaveLength(1);
  }, 5_000);

  // ── 4. Late client response ignored after fallback ────────────────────────

  it('late client barge_in after fallback does not cause duplicate truncate', async () => {
    const ITEM = 'item_003';
    oai().receive(audioDelta(ITEM, 200));
    oai().receive({ type: 'input_audio_buffer.speech_started' });
    await sleep(260);

    const oaiAfterFallback = oai().sent.length;
    clientWs.receive({ type: 'barge_in', itemId: ITEM, audioPlayedMs: 100 });

    const extra = oai().sent.slice(oaiAfterFallback).filter(
      (s) => (JSON.parse(s) as Record<string, unknown>)['type'] === 'conversation.item.truncate',
    );
    expect(extra).toHaveLength(0);
  }, 5_000);

  // ── 5. Second speech_started while barge-in pending ──────────────────────

  it('second speech_started while barge-in pending → treated as normal turn', () => {
    const ITEM = 'item_004';
    oai().receive(audioDelta(ITEM, 300));
    oai().receive({ type: 'input_audio_buffer.speech_started' });
    expect(clientWs.ofType('barge_in')).toHaveLength(1);
    clientWs.sent.length = 0;

    oai().receive({ type: 'input_audio_buffer.speech_started' });
    expect(clientWs.ofType('speech_started')).toHaveLength(1);
    expect(clientWs.ofType('barge_in')).toHaveLength(0);
  });

  // ── 6. item_id forwarded in audio messages ────────────────────────────────

  it('forwards item_id from OpenAI audio delta to client audio message', () => {
    const ITEM = 'item_005';
    oai().receive(audioDelta(ITEM, 100));

    const audioMsgs = clientWs.ofType('audio') as { itemId?: string }[];
    expect(audioMsgs).toHaveLength(1);
    expect(audioMsgs[0]?.itemId).toBe(ITEM);
  });

  // ── 7. currentItemId cleared after output_audio.done ─────────────────────

  it('clears currentItemId on output_audio.done — next speech_started is normal turn', () => {
    const ITEM = 'item_006';
    oai().receive(audioDelta(ITEM, 200));
    oai().receive({ type: 'response.output_audio.done' });
    clientWs.sent.length = 0;

    oai().receive({ type: 'input_audio_buffer.speech_started' });
    expect(clientWs.ofType('speech_started')).toHaveLength(1);
    expect(clientWs.ofType('barge_in')).toHaveLength(0);
  });

  // ── 8. response.cancelled clears state ────────────────────────────────────

  it('response.cancelled clears currentItemId — next speech_started is normal turn', () => {
    const ITEM = 'item_007';
    oai().receive(audioDelta(ITEM, 150));
    oai().receive({ type: 'response.cancelled' });
    clientWs.sent.length = 0;

    oai().receive({ type: 'input_audio_buffer.speech_started' });
    expect(clientWs.ofType('speech_started')).toHaveLength(1);
    expect(clientWs.ofType('barge_in')).toHaveLength(0);
  });

  // ── 9. usage extracted from response.done ────────────────────────────────

  it('extracts usage from response.done and passes to onTurnComplete', async () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 200,
      input_token_details:  { cached_tokens: 0, text_tokens: 50, audio_tokens: 50 },
      output_token_details: { text_tokens: 10, audio_tokens: 190 },
    };

    let capturedUsage: unknown;
    proxy.close();
    await startProxy({ onTurnComplete: (_ms, u) => { capturedUsage = u; } });

    oai().receive({ type: 'response.done', response: { id: 'resp_x', usage } });

    expect(capturedUsage).toMatchObject(usage);
  });

  // ── 10. audioPlayedMs: 0 handled safely ──────────────────────────────────

  it('handles audioPlayedMs: 0 (immediate interrupt) → audio_end_ms: 0', () => {
    const ITEM = 'item_010';
    oai().receive(audioDelta(ITEM, 500));
    const oaiBefore = oai().sent.length;
    oai().receive({ type: 'input_audio_buffer.speech_started' });
    clientWs.receive({ type: 'barge_in', itemId: ITEM, audioPlayedMs: 0 });

    const newOai = oai().sent.slice(oaiBefore).map((s) => JSON.parse(s) as Record<string, unknown>);
    const t = newOai.find((e) => e['type'] === 'conversation.item.truncate') as
      { audio_end_ms: number } | undefined;
    expect(t).toBeDefined();
    expect(t!.audio_end_ms).toBe(0);
  });

  // ── 11. Multiple consecutive barge-in cycles ──────────────────────────────

  it('handles two consecutive barge-in cycles correctly', () => {
    const ITEM_A = 'item_011a';
    const ITEM_B = 'item_011b';

    // First cycle
    oai().receive(audioDelta(ITEM_A, 400));
    let oaiBefore = oai().sent.length;
    oai().receive({ type: 'input_audio_buffer.speech_started' });
    clientWs.receive({ type: 'barge_in', itemId: ITEM_A, audioPlayedMs: 200 });

    let newOai = oai().sent.slice(oaiBefore).map((s) => JSON.parse(s) as Record<string, unknown>);
    let t = newOai.find((e) => e['type'] === 'conversation.item.truncate') as
      { item_id: string; audio_end_ms: number };
    expect(t.item_id).toBe(ITEM_A);
    expect(t.audio_end_ms).toBe(200);

    oai().sent.length = 0;
    clientWs.sent.length = 0;

    // Second cycle
    oai().receive(audioDelta(ITEM_B, 300));
    clientWs.sent.length = 0;
    oaiBefore = oai().sent.length;
    oai().receive({ type: 'input_audio_buffer.speech_started' });

    const bargInMsgs = clientWs.ofType('barge_in') as { itemId: string }[];
    expect(bargInMsgs).toHaveLength(1);
    expect(bargInMsgs[0]?.itemId).toBe(ITEM_B);

    clientWs.receive({ type: 'barge_in', itemId: ITEM_B, audioPlayedMs: 150 });

    newOai = oai().sent.slice(oaiBefore).map((s) => JSON.parse(s) as Record<string, unknown>);
    t = newOai.find((e) => e['type'] === 'conversation.item.truncate') as
      { item_id: string; audio_end_ms: number };
    expect(t.item_id).toBe(ITEM_B);
    expect(t.audio_end_ms).toBe(150);
  });
});
