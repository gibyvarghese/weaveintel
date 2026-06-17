/**
 * VoicePipeline — Phase 6 unit tests: TTS streaming
 *
 * Tests:
 *   processTurnStreaming() — happy path
 *     - onLlmComplete fires with transcript + responseText before any audio chunk
 *     - onAudioChunk fires for each chunk with done=false, then once with done=true
 *     - multiple chunks arrive in order (streaming, not buffered)
 *     - returned VoiceTurnResult.responseAudio equals concatenated chunks
 *     - returned ttsMs reflects actual TTS duration
 *
 *   processTurnStreaming() — guardrail deny
 *     - onLlmComplete fires with 'deny'
 *     - onAudioChunk is NOT called (TTS skipped)
 *     - returned guardrailDecision is 'deny', responseAudio empty
 *
 *   processTurnStreaming() — speakStream fallback (no speakStream on model)
 *     - falls back to speak(), yields single chunk + done
 *     - onLlmComplete still fires before the chunk
 *
 *   processTurnStreaming() — empty TTS output
 *     - only terminal done=true called (silence marker), no content chunks
 *
 *   processTurnStreaming() — text override skips STT
 *     - STT not called when textOverride is set
 *
 *   VoiceWsHandler with streaming
 *     - transcript event arrives before first audio event
 *     - audio events arrive with done=false, then final done=true
 *     - turn_complete arrives after the done=true audio frame
 *     - guardrail deny: guardrail_denied sent, no audio, no turn_complete callback
 *     - error in speakStream propagates as WS error message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AudioModel, ExecutionContext, SpeechRequest } from '@weaveintel/core';
import { VoicePipeline, VoiceWsHandler } from '../src/index.js';
import type { VoiceTurnSender, TurnStreamCallbacks } from '../src/index.js';
import type { VoiceSession, VoiceConfig } from '../src/index.js';

// ─── Fixtures ─────────────────────────────────────────────────

const CONFIG: VoiceConfig = {
  sttProvider: 'openai', sttModel: 'whisper-1',
  ttsProvider: 'openai', ttsModel: 'tts-1',
  ttsVoice: 'alloy', ttsSpeed: 1.0, ttsFormat: 'mp3',
  mode: 'direct',
};

const SESSION: VoiceSession = {
  id: 'sess_01', userId: 'user_01', tenantId: null, chatId: 'chat_01',
  status: 'active', config: CONFIG,
  totalTurns: 0, totalSttMs: 0, totalTtsMs: 0, totalLlmMs: 0,
  totalCostUsd: 0, totalAudioBytes: 0, wsConnected: true,
  lastActiveAt: null, endedAt: null,
  createdAt: '2026-06-17T00:00:00Z', updatedAt: '2026-06-17T00:00:00Z',
};

const TRANSCRIPT = 'Hello there';
const RESPONSE_TEXT = 'Hi! How can I help?';
const CHUNK_A = Buffer.from('audio-chunk-A', 'utf8');
const CHUNK_B = Buffer.from('audio-chunk-B', 'utf8');

function makeSender(opts: {
  assistantContent?: string;
  guardrailDecision?: 'allow' | 'warn' | 'deny';
} = {}): VoiceTurnSender {
  return {
    send: vi.fn().mockResolvedValue({
      assistantContent: opts.assistantContent ?? RESPONSE_TEXT,
      guardrailDecision: opts.guardrailDecision ?? 'allow',
      provider: 'openai',
      model: 'gpt-4o',
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.001,
    }),
  };
}

function makeInput() {
  return { audio: Buffer.alloc(0), textOverride: TRANSCRIPT };
}

const EMPTY_CAPS = new Set<import('@weaveintel/core').CapabilityId>();

// Audio model with speakStream that yields two chunks
function makeStreamingModel(chunks: Buffer[] = [CHUNK_A, CHUNK_B]): AudioModel {
  return {
    info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
    capabilities: EMPTY_CAPS,
    hasCapability: () => false,
    transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
    async *speakStream(_ctx: ExecutionContext, _req: SpeechRequest): AsyncIterable<Buffer> {
      for (const c of chunks) yield c;
    },
  };
}

// Audio model with only speak() (no speakStream)
function makeBufferedModel(buf: Buffer = CHUNK_A): AudioModel {
  return {
    info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
    capabilities: EMPTY_CAPS,
    hasCapability: () => false,
    transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
    speak: vi.fn().mockResolvedValue(buf),
  };
}

function makePipeline(audioModel: AudioModel, sender?: VoiceTurnSender) {
  return new VoicePipeline({
    audioModel,
    sender: sender ?? makeSender(),
  });
}

// ─── WsSocket stub ────────────────────────────────────────────

class WsStub extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  messages(): unknown[] { return this.sent.map((s) => JSON.parse(s) as unknown); }
  ofType(t: string): unknown[] {
    return this.messages().filter((m) => (m as Record<string, unknown>)['type'] === t);
  }
}

// ─── processTurnStreaming — happy path ────────────────────────

describe('processTurnStreaming() — happy path', () => {
  it('onLlmComplete fires with transcript and responseText', async () => {
    const pipeline = makePipeline(makeStreamingModel());
    const onLlmComplete = vi.fn();

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete, onAudioChunk: () => {} },
    );

    expect(onLlmComplete).toHaveBeenCalledOnce();
    expect(onLlmComplete).toHaveBeenCalledWith(TRANSCRIPT, RESPONSE_TEXT, 'allow');
  });

  it('onLlmComplete fires BEFORE any onAudioChunk call', async () => {
    const pipeline = makePipeline(makeStreamingModel());
    const order: string[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => { order.push('llm'); },
        onAudioChunk: () => { order.push('audio'); },
      },
    );

    expect(order[0]).toBe('llm');
    expect(order.some((v) => v === 'audio')).toBe(true);
    // llm must precede every audio event
    const firstAudio = order.indexOf('audio');
    expect(firstAudio).toBeGreaterThan(order.indexOf('llm'));
  });

  it('onAudioChunk receives chunks in order with done=false, then terminal done=true', async () => {
    const pipeline = makePipeline(makeStreamingModel([CHUNK_A, CHUNK_B]));
    const calls: { chunk: Buffer; done: boolean }[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => {},
        onAudioChunk: (chunk, done) => { calls.push({ chunk, done }); },
      },
    );

    // Two content chunks + one terminal done
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ chunk: CHUNK_A, done: false });
    expect(calls[1]).toEqual({ chunk: CHUNK_B, done: false });
    expect(calls[2]).toEqual({ chunk: Buffer.alloc(0), done: true });
  });

  it('returned responseAudio is concatenation of all chunks', async () => {
    const pipeline = makePipeline(makeStreamingModel([CHUNK_A, CHUNK_B]));

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
    );

    expect(result.responseAudio).toEqual(Buffer.concat([CHUNK_A, CHUNK_B]));
  });

  it('returned VoiceTurnResult has correct metadata', async () => {
    const pipeline = makePipeline(makeStreamingModel());

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
    );

    expect(result.transcript).toBe(TRANSCRIPT);
    expect(result.responseText).toBe(RESPONSE_TEXT);
    expect(result.guardrailDecision).toBe('allow');
    expect(result.sessionId).toBe('sess');
    expect(result.turnIndex).toBe(0);
    expect(result.ttsMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('single-chunk stream: one content chunk + terminal done', async () => {
    const pipeline = makePipeline(makeStreamingModel([CHUNK_A]));
    const calls: { chunk: Buffer; done: boolean }[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: (c, d) => calls.push({ chunk: c, done: d }) },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ chunk: CHUNK_A, done: false });
    expect(calls[1]).toEqual({ chunk: Buffer.alloc(0), done: true });
  });
});

// ─── processTurnStreaming — guardrail deny ────────────────────

describe('processTurnStreaming() — guardrail deny', () => {
  it('onLlmComplete fires with guardrailDecision=deny', async () => {
    const sender = makeSender({ guardrailDecision: 'deny', assistantContent: 'Request blocked' });
    const pipeline = makePipeline(makeStreamingModel(), sender);
    const onLlmComplete = vi.fn();

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete, onAudioChunk: () => {} },
    );

    expect(onLlmComplete).toHaveBeenCalledWith(TRANSCRIPT, 'Request blocked', 'deny');
  });

  it('onAudioChunk is NOT called when guardrail denies', async () => {
    const sender = makeSender({ guardrailDecision: 'deny' });
    const pipeline = makePipeline(makeStreamingModel(), sender);
    const onAudioChunk = vi.fn();

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk },
    );

    expect(onAudioChunk).not.toHaveBeenCalled();
  });

  it('returned result has deny decision and empty responseAudio', async () => {
    const sender = makeSender({ guardrailDecision: 'deny' });
    const pipeline = makePipeline(makeStreamingModel(), sender);

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
    );

    expect(result.guardrailDecision).toBe('deny');
    expect(result.responseAudio.length).toBe(0);
    expect(result.ttsMs).toBe(0);
  });
});

// ─── processTurnStreaming — speakStream fallback ───────────────

describe('processTurnStreaming() — speakStream fallback (no speakStream on model)', () => {
  it('falls back to speak() when speakStream not present', async () => {
    const pipeline = makePipeline(makeBufferedModel(CHUNK_A));
    const calls: { chunk: Buffer; done: boolean }[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: (c, d) => calls.push({ chunk: c, done: d }) },
    );

    // Single content chunk from speak(), plus terminal done
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ chunk: CHUNK_A, done: false });
    expect(calls[1]).toEqual({ chunk: Buffer.alloc(0), done: true });
  });

  it('onLlmComplete still fires before speak() call', async () => {
    const speakFn = vi.fn().mockResolvedValue(CHUNK_A);
    const model: AudioModel = {
      info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
      capabilities: EMPTY_CAPS,
      hasCapability: () => false,
      transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
      speak: speakFn,
    };
    const pipeline = makePipeline(model);
    const order: string[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => { order.push('llm'); },
        onAudioChunk: () => { order.push('audio'); },
      },
    );

    expect(order.indexOf('llm')).toBeLessThan(order.indexOf('audio'));
    expect(speakFn).toHaveBeenCalledOnce();
  });
});

// ─── processTurnStreaming — empty TTS output ──────────────────

describe('processTurnStreaming() — empty TTS output', () => {
  it('when speakStream yields nothing: only terminal done is called', async () => {
    const pipeline = makePipeline(makeStreamingModel([])); // no chunks
    const calls: { chunk: Buffer; done: boolean }[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: (c, d) => calls.push({ chunk: c, done: d }) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ chunk: Buffer.alloc(0), done: true });
  });

  it('when speak() returns empty buffer: only terminal done is called', async () => {
    const pipeline = makePipeline(makeBufferedModel(Buffer.alloc(0)));
    const calls: { chunk: Buffer; done: boolean }[] = [];

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: (c, d) => calls.push({ chunk: c, done: d }) },
    );

    // Empty buffer from speak() is NOT yielded as a content chunk
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ chunk: Buffer.alloc(0), done: true });
  });
});

// ─── processTurnStreaming — STT path ─────────────────────────

describe('processTurnStreaming() — STT path', () => {
  it('text override skips STT', async () => {
    const transcribeFn = vi.fn().mockResolvedValue(TRANSCRIPT);
    const model = makeStreamingModel();
    (model as AudioModel & { transcribe: typeof transcribeFn }).transcribe = transcribeFn;
    const pipeline = makePipeline(model);

    await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG,
      { audio: Buffer.alloc(0), textOverride: 'direct input' },
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
    );

    expect(transcribeFn).not.toHaveBeenCalled();
  });

  it('transcript in result matches textOverride', async () => {
    const pipeline = makePipeline(makeStreamingModel());

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG,
      { audio: Buffer.alloc(0), textOverride: 'my direct input' },
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
    );

    expect(result.transcript).toBe('my direct input');
  });
});

// ─── VoiceWsHandler with streaming ───────────────────────────

describe('VoiceWsHandler — streaming (Phase 6)', () => {
  function makeHandler(audioModel: AudioModel, sender?: VoiceTurnSender) {
    const ws = new WsStub();
    const pipeline = makePipeline(audioModel, sender);
    const handler = new VoiceWsHandler({
      session: SESSION,
      ws: ws as unknown as import('ws').WebSocket,
      pipeline,
    });
    return { ws, handler };
  }

  beforeEach(async () => {
    // nothing to reset
  });

  it('transcript event arrives before first audio event', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A, CHUNK_B]));
    await handler.start();

    // Simulate text message
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    // Allow async processing
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = ws.messages() as Array<Record<string, unknown>>;
    const transcriptIdx = msgs.findIndex((m) => m['type'] === 'transcript');
    const firstAudioIdx = msgs.findIndex((m) => m['type'] === 'audio');

    expect(transcriptIdx).toBeGreaterThanOrEqual(0);
    expect(firstAudioIdx).toBeGreaterThan(transcriptIdx);
  });

  it('llm_text event arrives before first audio event', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A, CHUNK_B]));
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = ws.messages() as Array<Record<string, unknown>>;
    const llmIdx   = msgs.findIndex((m) => m['type'] === 'llm_text');
    const audioIdx = msgs.findIndex((m) => m['type'] === 'audio');

    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(audioIdx).toBeGreaterThan(llmIdx);
  });

  it('multiple audio events with done=false arrive, then one done=true', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A, CHUNK_B]));
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const audioMsgs = ws.ofType('audio') as Array<Record<string, unknown>>;

    // CHUNK_A, CHUNK_B content frames + 1 done=true frame
    expect(audioMsgs.length).toBeGreaterThanOrEqual(3);

    const contentFrames = audioMsgs.filter((m) => !m['done']);
    const doneFrames    = audioMsgs.filter((m) => m['done'] === true);

    expect(contentFrames.length).toBe(2);
    expect(doneFrames.length).toBe(1);
    expect(doneFrames[0]!['payload']).toBe('');
  });

  it('turn_complete arrives after the terminal audio done frame', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A]));
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const msgs = ws.messages() as Array<Record<string, unknown>>;
    const lastAudioIdx    = [...msgs].map((m, i) => m['type'] === 'audio' ? i : -1).filter((i) => i >= 0).at(-1)!;
    const turnCompleteIdx = msgs.findIndex((m) => m['type'] === 'turn_complete');

    expect(turnCompleteIdx).toBeGreaterThan(lastAudioIdx);
  });

  it('turn_complete.costUsd > 0', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A]));
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const tc = ws.ofType('turn_complete') as Array<Record<string, unknown>>;
    expect(tc).toHaveLength(1);
    expect((tc[0]!['costUsd'] as number)).toBeGreaterThan(0);
  });

  it('guardrail deny: sends guardrail_denied, no audio frames, no turn_complete', async () => {
    const sender = makeSender({ guardrailDecision: 'deny', assistantContent: 'Blocked' });
    const { ws, handler } = makeHandler(makeStreamingModel(), sender);
    await handler.start();

    const onTurnComplete = vi.fn().mockResolvedValue(undefined);
    // Patch callback
    (handler as unknown as Record<string, unknown>)['callbacks'] = { onTurnComplete };

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(ws.ofType('guardrail_denied')).toHaveLength(1);
    expect(ws.ofType('audio')).toHaveLength(0);
    expect(ws.ofType('turn_complete')).toHaveLength(0);

    const gd = (ws.ofType('guardrail_denied') as Array<Record<string, unknown>>)[0]!;
    expect(gd['phase']).toBe('input');
    expect(typeof gd['reason']).toBe('string');
  });

  it('error in speakStream propagates as WS error message', async () => {
    const brokenModel: AudioModel = {
      info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
      capabilities: EMPTY_CAPS,
      hasCapability: () => false,
      transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
      async *speakStream(): AsyncIterable<Buffer> {
        throw new Error('TTS provider exploded');
      },
    };
    const { ws, handler } = makeHandler(brokenModel);
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const errors = ws.ofType('error') as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!['code']).toBe('TURN_FAILED');
  });

  it('onTurnComplete callback receives audioBytesOut matching streamed chunks', async () => {
    const { ws, handler } = makeHandler(makeStreamingModel([CHUNK_A, CHUNK_B]));
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);
    await handler.start();
    // Patch callbacks after start
    (handler as unknown as Record<string, unknown>)['callbacks'] = { onTurnComplete };

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onTurnComplete).toHaveBeenCalledOnce();
    const arg = onTurnComplete.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg['audioBytesOut']).toBe(CHUNK_A.length + CHUNK_B.length);
  });
});

// ─── processTurn() backward compat ───────────────────────────

describe('processTurn() backward compatibility', () => {
  it('still works after refactor (non-streaming path)', async () => {
    const pipeline = makePipeline(makeBufferedModel(CHUNK_A));

    const result = await pipeline.processTurn(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
    );

    expect(result.transcript).toBe(TRANSCRIPT);
    expect(result.responseText).toBe(RESPONSE_TEXT);
    expect(result.responseAudio).toEqual(CHUNK_A);
    expect(result.guardrailDecision).toBe('allow');
  });

  it('processTurn deny path still works', async () => {
    const sender = makeSender({ guardrailDecision: 'deny', assistantContent: 'No.' });
    const pipeline = makePipeline(makeBufferedModel(), sender);

    const result = await pipeline.processTurn('sess', 0, 'user', 'chat', CONFIG, makeInput());

    expect(result.guardrailDecision).toBe('deny');
    expect(result.responseAudio.length).toBe(0);
  });
});
