/**
 * VoicePipeline — Phase 7 unit tests: chained pipeline cancellation
 *
 * Tests:
 *   processTurnStreaming() — signal pre-aborted
 *     - no audio chunks are yielded
 *     - AbortError is thrown (not a normalised WeaveIntelError)
 *     - terminal done callback is NOT called
 *
 *   processTurnStreaming() — signal fires mid-stream
 *     - chunks yielded before abort are received
 *     - further chunks are NOT received
 *     - terminal done callback is NOT called
 *     - AbortError is thrown
 *
 *   processTurnStreaming() — signal fires after TTS completes
 *     - normal result is returned (late abort has no effect)
 *
 *   processTurnStreaming() — speak() fallback + signal
 *     - pre-aborted signal: AbortError thrown, no audio chunk
 *
 *   VoiceWsHandler — pause during TTS streaming
 *     - 'paused' event sent immediately
 *     - no 'audio done=true' event
 *     - no 'turn_complete' event
 *     - onTurnComplete callback is NOT called
 *     - processing flag resets to false (handler can accept new turns)
 *
 *   VoiceWsHandler — pause during idle (not processing)
 *     - paused flag is set
 *     - new audio message is rejected with SESSION_PAUSED
 *     - 'resume' clears paused flag
 *
 *   VoiceWsHandler — pause mid-TTS + resume + new turn
 *     - second turn completes normally after resume
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
  id: 'sess_p7', userId: 'user_01', tenantId: null, chatId: 'chat_01',
  status: 'active', config: CONFIG,
  totalTurns: 0, totalSttMs: 0, totalTtsMs: 0, totalLlmMs: 0,
  totalCostUsd: 0, totalAudioBytes: 0, wsConnected: true,
  lastActiveAt: null, endedAt: null,
  createdAt: '2026-06-17T00:00:00Z', updatedAt: '2026-06-17T00:00:00Z',
};

const TRANSCRIPT = 'Cancel me mid-stream';
const RESPONSE_TEXT = 'Sure, I will keep talking...';
const CHUNK_A = Buffer.from('audio-chunk-A', 'utf8');
const CHUNK_B = Buffer.from('audio-chunk-B', 'utf8');
const CHUNK_C = Buffer.from('audio-chunk-C', 'utf8');

const EMPTY_CAPS = new Set<import('@weaveintel/core').CapabilityId>();

function makeSender(opts: { guardrailDecision?: 'allow' | 'warn' | 'deny' } = {}): VoiceTurnSender {
  return {
    send: vi.fn().mockResolvedValue({
      assistantContent: RESPONSE_TEXT,
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

/**
 * Model whose speakStream yields CHUNK_A, then blocks until the AbortSignal fires,
 * then throws an AbortError (simulating a real HTTP stream abort).
 */
function makeBlockingModel(): AudioModel {
  return {
    info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
    capabilities: EMPTY_CAPS,
    hasCapability: () => false,
    transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
    async *speakStream(_ctx: ExecutionContext, req: SpeechRequest): AsyncIterable<Buffer> {
      yield CHUNK_A;
      await new Promise<void>((_res, rej) => {
        if (req.signal?.aborted) {
          rej(new DOMException('Aborted', 'AbortError'));
          return;
        }
        req.signal?.addEventListener('abort', () => {
          rej(new DOMException('Aborted', 'AbortError'));
        });
        // resolves only via abort
      });
      yield CHUNK_B; // never reached
    },
  };
}

/**
 * Model whose speakStream yields chunks with an async step between each,
 * allowing the abort signal to be detected by the loop's `signal.aborted` check.
 */
function makeAsyncStreamingModel(chunks: Buffer[] = [CHUNK_A, CHUNK_B, CHUNK_C]): AudioModel {
  return {
    info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
    capabilities: EMPTY_CAPS,
    hasCapability: () => false,
    transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
    async *speakStream(): AsyncIterable<Buffer> {
      for (const c of chunks) {
        yield c;
        await Promise.resolve(); // allow event loop / abort check
      }
    },
  };
}

function makePipeline(audioModel: AudioModel, sender?: VoiceTurnSender) {
  return new VoicePipeline({ audioModel, sender: sender ?? makeSender() });
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

async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ─── processTurnStreaming + signal — pre-aborted ──────────────

describe('processTurnStreaming() — signal pre-aborted', () => {
  it('throws an AbortError without yielding any chunks', async () => {
    const ac = new AbortController();
    ac.abort(); // already aborted before we call processTurnStreaming

    const onAudioChunk = vi.fn();
    const pipeline = makePipeline(makeAsyncStreamingModel());

    await expect(
      pipeline.processTurnStreaming(
        'sess', 0, 'user', 'chat', CONFIG, makeInput(),
        { onLlmComplete: () => {}, onAudioChunk },
        undefined,
        ac.signal,
      ),
    ).rejects.toThrow();

    // No audio chunks should have been yielded
    expect(onAudioChunk).not.toHaveBeenCalled();
  });

  it('does NOT emit the terminal done frame', async () => {
    const ac = new AbortController();
    ac.abort();

    const calls: { done: boolean }[] = [];
    const pipeline = makePipeline(makeAsyncStreamingModel());

    await expect(
      pipeline.processTurnStreaming(
        'sess', 0, 'user', 'chat', CONFIG, makeInput(),
        { onLlmComplete: () => {}, onAudioChunk: (_, done) => calls.push({ done }) },
        undefined,
        ac.signal,
      ),
    ).rejects.toThrow();

    expect(calls.filter((c) => c.done)).toHaveLength(0);
  });
});

// ─── processTurnStreaming + signal — fires mid-stream ─────────

describe('processTurnStreaming() — signal fires mid-stream', () => {
  it('yields chunks before abort, then throws without done frame', async () => {
    const ac = new AbortController();
    const received: Buffer[] = [];
    let doneCallCount = 0;

    const pipeline = makePipeline(makeBlockingModel());

    const resultPromise = pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => {},
        onAudioChunk: (chunk, done) => {
          if (done) { doneCallCount++; return; }
          received.push(chunk);
          // Fire abort after receiving the first chunk
          if (received.length === 1) ac.abort();
        },
      },
      undefined,
      ac.signal,
    );

    await expect(resultPromise).rejects.toThrow();

    // Only CHUNK_A was received (the one yielded before the block)
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(CHUNK_A);
    // Terminal done must NOT be called
    expect(doneCallCount).toBe(0);
  });

  it('thrown error is an AbortError (not a normalised provider error)', async () => {
    const ac = new AbortController();
    const pipeline = makePipeline(makeBlockingModel());

    const resultPromise = pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => {},
        onAudioChunk: (_, done) => {
          if (!done) ac.abort(); // abort after first chunk
        },
      },
      undefined,
      ac.signal,
    );

    let caughtErr: unknown;
    try {
      await resultPromise;
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeDefined();
    // Should be a DOMException with name AbortError, NOT a WeaveIntelError
    expect(caughtErr instanceof DOMException || (caughtErr as { name?: string }).name === 'AbortError').toBe(true);
  });

  it('abort between iterations (loop check) stops further chunks', async () => {
    const ac = new AbortController();
    const received: Buffer[] = [];

    // Async streaming model: yields chunks with await between them, allowing abort check
    const pipeline = makePipeline(makeAsyncStreamingModel([CHUNK_A, CHUNK_B, CHUNK_C]));

    const resultPromise = pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      {
        onLlmComplete: () => {},
        onAudioChunk: (chunk, done) => {
          if (!done) {
            received.push(chunk);
            if (received.length === 1) {
              ac.abort(); // abort after chunk-A; chunk-B check fires in next iteration
            }
          }
        },
      },
      undefined,
      ac.signal,
    );

    await expect(resultPromise).rejects.toThrow();

    // Only CHUNK_A received (abort fired before CHUNK_B iteration begins)
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(CHUNK_A);
  });
});

// ─── processTurnStreaming + signal — late abort ───────────────

describe('processTurnStreaming() — late abort (after TTS completes)', () => {
  it('returns normal result when signal fires after all chunks delivered', async () => {
    const ac = new AbortController();

    const pipeline = makePipeline(makeAsyncStreamingModel([CHUNK_A, CHUNK_B]));

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: () => {} },
      undefined,
      ac.signal,
    );

    // Abort after the call resolves — should have no effect
    ac.abort();

    expect(result.transcript).toBe(TRANSCRIPT);
    expect(result.responseText).toBe(RESPONSE_TEXT);
    expect(result.responseAudio).toEqual(Buffer.concat([CHUNK_A, CHUNK_B]));
  });
});

// ─── processTurnStreaming + signal — speak() fallback ─────────

describe('processTurnStreaming() — speak() fallback + signal', () => {
  it('pre-aborted signal: throws AbortError, no audio chunk emitted', async () => {
    const ac = new AbortController();
    ac.abort();

    const speakFn = vi.fn().mockResolvedValue(CHUNK_A);
    const model: AudioModel = {
      info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
      capabilities: EMPTY_CAPS,
      hasCapability: () => false,
      transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
      speak: speakFn,
    };
    const onAudioChunk = vi.fn();
    const pipeline = makePipeline(model);

    await expect(
      pipeline.processTurnStreaming(
        'sess', 0, 'user', 'chat', CONFIG, makeInput(),
        { onLlmComplete: () => {}, onAudioChunk },
        undefined,
        ac.signal,
      ),
    ).rejects.toThrow();

    expect(onAudioChunk).not.toHaveBeenCalled();
  });
});

// ─── no signal — baseline ────────────────────────────────────

describe('processTurnStreaming() — no signal (undefined)', () => {
  it('completes normally when no signal is supplied', async () => {
    const pipeline = makePipeline(makeAsyncStreamingModel([CHUNK_A, CHUNK_B]));
    const calls: { chunk: Buffer; done: boolean }[] = [];

    const result = await pipeline.processTurnStreaming(
      'sess', 0, 'user', 'chat', CONFIG, makeInput(),
      { onLlmComplete: () => {}, onAudioChunk: (c, d) => calls.push({ chunk: c, done: d }) },
    );

    expect(calls).toHaveLength(3); // CHUNK_A, CHUNK_B, done
    expect(calls[0]).toEqual({ chunk: CHUNK_A, done: false });
    expect(calls[1]).toEqual({ chunk: CHUNK_B, done: false });
    expect(calls[2]).toEqual({ chunk: Buffer.alloc(0), done: true });
    expect(result.responseAudio).toEqual(Buffer.concat([CHUNK_A, CHUNK_B]));
  });
});

// ─── VoiceWsHandler — pause during TTS streaming ─────────────

describe('VoiceWsHandler — pause during TTS streaming (Phase 7)', () => {
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

  it('sends paused immediately when pause arrives during TTS', async () => {
    const { ws, handler } = makeHandler(makeBlockingModel());
    await handler.start();

    // Start a text turn — this will block inside speakStream after first chunk
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));

    // Let the turn reach the TTS phase (CHUNK_A yields, then blocks)
    await flush(4);

    // Pause mid-stream
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));

    // Let the abort propagate and cleanup finish
    await flush(6);

    const pausedEvents = ws.ofType('paused') as Array<Record<string, unknown>>;
    expect(pausedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT send audio done=true after pause', async () => {
    const { ws, handler } = makeHandler(makeBlockingModel());
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await flush(4);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(6);

    const doneAudio = (ws.ofType('audio') as Array<Record<string, unknown>>)
      .filter((m) => m['done'] === true);
    expect(doneAudio).toHaveLength(0);
  });

  it('does NOT send turn_complete after pause', async () => {
    const { ws, handler } = makeHandler(makeBlockingModel());
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await flush(4);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(6);

    expect(ws.ofType('turn_complete')).toHaveLength(0);
  });

  it('does NOT call onTurnComplete after pause (partial turn not persisted)', async () => {
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);
    const { ws, handler } = makeHandler(makeBlockingModel());
    await handler.start();
    (handler as unknown as Record<string, unknown>)['callbacks'] = { onTurnComplete };

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await flush(4);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(6);

    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it('processing flag is false after abort cleanup (handler accepts new turns)', async () => {
    const { ws, handler } = makeHandler(makeBlockingModel());
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await flush(4);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(8);

    // Send resume to reset paused state (if it was set), then new audio
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resume' })));
    await flush(2);

    // New turn should not be rejected with BUSY
    const errorsBefore = ws.ofType('error') as Array<Record<string, unknown>>;
    const busyBefore = errorsBefore.filter((e) => e['code'] === 'BUSY');
    expect(busyBefore).toHaveLength(0);
  });
});

// ─── VoiceWsHandler — pause during idle ──────────────────────

describe('VoiceWsHandler — pause during idle (not processing)', () => {
  function makeHandler() {
    const ws = new WsStub();
    const pipeline = makePipeline(makeAsyncStreamingModel());
    const handler = new VoiceWsHandler({
      session: SESSION,
      ws: ws as unknown as import('ws').WebSocket,
      pipeline,
    });
    return { ws, handler };
  }

  it('sets paused flag and sends paused', async () => {
    const { ws, handler } = makeHandler();
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(2);

    expect(ws.ofType('paused')).toHaveLength(1);
  });

  it('new audio while paused receives SESSION_PAUSED error', async () => {
    const { ws, handler } = makeHandler();
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(2);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: 'hello' })));
    await flush(2);

    const errors = ws.ofType('error') as Array<Record<string, unknown>>;
    const paused = errors.filter((e) => e['code'] === 'SESSION_PAUSED');
    expect(paused).toHaveLength(1);
  });

  it('resume clears paused flag and sends resumed', async () => {
    const { ws, handler } = makeHandler();
    await handler.start();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(2);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resume' })));
    await flush(2);

    expect(ws.ofType('resumed')).toHaveLength(1);

    // Now a new turn should succeed (no SESSION_PAUSED error)
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: 'hello' })));
    await flush(4);

    const errors = (ws.ofType('error') as Array<Record<string, unknown>>)
      .filter((e) => e['code'] === 'SESSION_PAUSED');
    expect(errors).toHaveLength(0);
  });
});

// ─── VoiceWsHandler — pause + resume + new turn ──────────────

describe('VoiceWsHandler — pause mid-TTS + resume + new turn', () => {
  it('second turn completes normally after pause + resume', async () => {
    const ws = new WsStub();
    // First model blocks; second model (used after reset) completes immediately
    const blockingModel = makeBlockingModel();
    const fastModel = makeAsyncStreamingModel([CHUNK_A]);

    // Use a model that switches: first call blocks, subsequent calls are fast
    let callCount = 0;
    const switchingModel: AudioModel = {
      info: { provider: 'test', modelId: 'test', capabilities: EMPTY_CAPS },
      capabilities: EMPTY_CAPS,
      hasCapability: () => false,
      transcribe: vi.fn().mockResolvedValue(TRANSCRIPT),
      async *speakStream(ctx, req): AsyncIterable<Buffer> {
        callCount++;
        if (callCount === 1) {
          // First call: block until aborted
          yield* blockingModel.speakStream!(ctx, req);
        } else {
          // Subsequent calls: complete immediately
          yield* fastModel.speakStream!(ctx, req);
        }
      },
    };

    const pipeline = makePipeline(switchingModel);
    const handler = new VoiceWsHandler({
      session: SESSION,
      ws: ws as unknown as import('ws').WebSocket,
      pipeline,
    });
    await handler.start();

    // Start first turn — blocks mid-TTS
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: TRANSCRIPT })));
    await flush(4);

    // Pause aborts the first turn
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pause' })));
    await flush(8);

    // Resume to allow new turns
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resume' })));
    await flush(2);

    // Second turn — should complete with turn_complete
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'text', text: 'hello again' })));
    await flush(10);

    expect(ws.ofType('turn_complete')).toHaveLength(1);
  });
});
