/**
 * @weaveintel/voice — WebSocket handler
 *
 * Manages the full lifecycle of a single voice session WebSocket connection:
 *   • Handshake / session_ready
 *   • Inbound audio chunk processing (queued, sequential)
 *   • Streaming progress events back to the client
 *   • Pause / resume / end control messages
 *   • Graceful teardown on socket close / error
 *
 * Phase 6: Uses `VoicePipeline.processTurnStreaming()` so TTS audio chunks
 * are sent to the client as they arrive from the provider, rather than
 * waiting for the full synthesis to complete.  The `transcript` and
 * `llm_text` events are emitted as soon as the LLM responds — before TTS
 * even starts.
 *
 * Phase 7: `{ type: 'pause' }` during active TTS streaming fires an
 * AbortSignal into `processTurnStreaming()`, cutting the HTTP stream
 * immediately.  The partial turn is NOT persisted.  The client should
 * follow up with `{ type: 'resume' }` then a new audio message.
 *
 * The handler is designed to plug into any Node.js `http.Server` that
 * delegates `upgrade` events to it.  GeneWeave wires this in server.ts
 * for the path `/api/voice/sessions/:id/ws`.
 */

import { EventEmitter } from 'node:events';
import type { WebSocket as WsSocket } from 'ws';
import type { VoiceSession, VoiceWsClientMessage, VoiceWsServerMessage } from './types.js';
import { ttsFormatToMime } from './types.js';
import type { VoicePipeline } from './pipeline.js';

// ─── Callbacks the caller must supply ────────────────────────

export interface VoiceWsHandlerCallbacks {
  /** Called when the session starts its first turn. */
  onSessionStart?(sessionId: string): Promise<void>;
  /** Called after every completed (or failed) turn so the caller can persist stats. */
  onTurnComplete?(sessionId: string, result: {
    turnIndex: number;
    transcript: string;
    responseText: string;
    guardrailDecision: string;
    promptTokens: number;
    completionTokens: number;
    sttMs: number;
    llmMs: number;
    ttsMs: number;
    costUsd: number;
    audioBytesIn: number;
    audioBytesOut: number;
    traceId?: string;
    error?: string;
    llmProvider: string;
    llmModel: string;
  }): Promise<void>;
  /** Called when the session ends (client sent 'end' or socket closed). */
  onSessionEnd?(sessionId: string): Promise<void>;
  /** Called when WS connection state changes. */
  onConnectionChange?(sessionId: string, connected: boolean): Promise<void>;
}

// ─── Handler ─────────────────────────────────────────────────

export interface VoiceWsHandlerOptions {
  session: VoiceSession;
  ws: WsSocket;
  pipeline: VoicePipeline;
  callbacks?: VoiceWsHandlerCallbacks;
  /** Max concurrent turns (default: 1 — sequential) */
  maxConcurrentTurns?: number;
  /** Heartbeat interval ms (default: 25 000) */
  heartbeatIntervalMs?: number;
}

export class VoiceWsHandler extends EventEmitter {
  private readonly session: VoiceSession;
  private readonly ws: WsSocket;
  private readonly pipeline: VoicePipeline;
  private readonly callbacks: VoiceWsHandlerCallbacks;

  private turnIndex = 0;
  private paused = false;
  private ended = false;
  private processing = false;
  /** Non-null only while a `processTurnStreaming` call is in the TTS phase. */
  private abortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;

  constructor(opts: VoiceWsHandlerOptions) {
    super();
    this.session = opts.session;
    this.ws = opts.ws;
    this.pipeline = opts.pipeline;
    this.callbacks = opts.callbacks ?? {};
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
  }

  // ── Initialise ──────────────────────────────────────────────

  async start(): Promise<void> {
    await this.callbacks.onConnectionChange?.(this.session.id, true);

    this.send({ type: 'session_ready', sessionId: this.session.id, chatId: this.session.chatId, config: this.session.config });

    this.ws.on('message', (data) => void this.handleMessage(data));
    this.ws.on('close', () => void this.handleClose());
    this.ws.on('error', (err) => void this.handleError(err));

    this.heartbeatTimer = setInterval(() => {
      if (!this.ended && this.ws.readyState === 1 /* OPEN */) {
        this.send({ type: 'pong' });
      }
    }, this.heartbeatIntervalMs);
  }

  // ── Message dispatch ────────────────────────────────────────

  private async handleMessage(raw: unknown): Promise<void> {
    if (this.ended) return;

    let msg: VoiceWsClientMessage;
    try {
      const str = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
      msg = JSON.parse(str) as VoiceWsClientMessage;
    } catch {
      this.send({ type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON message', retryable: false });
      return;
    }

    switch (msg.type) {
      case 'audio':
        await this.handleAudio(Buffer.from(msg.payload, 'base64'), msg.mimeType);
        break;
      case 'text':
        await this.handleAudio(Buffer.alloc(0), undefined, msg.text);
        break;
      case 'pause':
        if (this.processing && this.abortController) {
          // Mid-TTS barge-in: abort the streaming turn immediately.
          // State returns to LISTENING (not paused) once abort cleanup finishes.
          this.abortController.abort();
        } else {
          // Idle pause: block new turns until the client sends resume.
          this.paused = true;
        }
        this.send({ type: 'paused' });
        break;
      case 'resume':
        this.paused = false;
        this.send({ type: 'resumed' });
        break;
      case 'end':
        await this.end();
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      default:
        this.send({ type: 'error', code: 'UNKNOWN_MESSAGE_TYPE', message: `Unknown message type`, retryable: false });
    }
  }

  private async handleAudio(audio: Buffer, inputMime?: string, textOverride?: string): Promise<void> {
    if (this.paused) {
      this.send({ type: 'error', code: 'SESSION_PAUSED', message: 'Session is paused — resume before sending audio', retryable: true });
      return;
    }
    if (this.processing) {
      this.send({ type: 'error', code: 'BUSY', message: 'Still processing previous turn — please wait', retryable: true });
      return;
    }

    this.processing = true;
    const idx = this.turnIndex++;
    const t0 = Date.now();

    // Phase 7: one AbortController per turn — fired on mid-TTS 'pause' message
    const ac = new AbortController();
    this.abortController = ac;

    // Derive TTS output MIME type upfront for streaming audio frames
    const outMimeType = ttsFormatToMime(this.session.config.ttsFormat);
    let audioBytesOut = 0;
    let guardrailDenied = false;

    try {
      const result = await this.pipeline.processTurnStreaming(
        this.session.id,
        idx,
        this.session.userId,
        this.session.chatId,
        this.session.config,
        { audio, mimeType: inputMime, textOverride },
        {
          onLlmComplete: (transcript, responseText, decision) => {
            // Skip if already cancelled — avoids sending events after paused
            if (ac.signal.aborted) return;
            if (decision === 'deny') {
              guardrailDenied = true;
              this.send({ type: 'guardrail_denied', turnIndex: idx, reason: responseText.slice(0, 200), phase: 'input' });
            } else {
              // Emit transcript and LLM text immediately — before TTS starts
              this.send({ type: 'transcript', turnIndex: idx, text: transcript });
              this.send({ type: 'llm_text', turnIndex: idx, text: responseText });
            }
          },
          onAudioChunk: (chunk, done) => {
            // Skip if cancelled — paused event is already on its way
            if (ac.signal.aborted) return;
            if (done) {
              // Terminal done frame — always emitted so the client knows the stream ended.
              // Serves as a silence marker when audioBytesOut is 0 (e.g. guardrail warn).
              if (!guardrailDenied) {
                this.send({ type: 'audio', turnIndex: idx, payload: '', mimeType: outMimeType, done: true });
              }
            } else {
              audioBytesOut += chunk.length;
              this.send({ type: 'audio', turnIndex: idx, payload: chunk.toString('base64'), mimeType: outMimeType, done: false });
            }
          },
        },
        undefined,   // ctx — use pipeline default
        ac.signal,   // Phase 7: cancellation signal
      );

      // processTurnStreaming throws on abort — this guard is a safety net
      if (ac.signal.aborted) return;

      if (guardrailDenied) {
        await this.callbacks.onTurnComplete?.(this.session.id, {
          turnIndex: idx,
          transcript: result.transcript,
          responseText: result.responseText,
          guardrailDecision: 'deny',
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          sttMs: result.sttMs,
          llmMs: result.llmMs,
          ttsMs: result.ttsMs,
          costUsd: result.costUsd,
          audioBytesIn: audio.length,
          audioBytesOut: 0,
          traceId: result.traceId,
          llmProvider: result.llmProvider,
          llmModel: result.llmModel,
        });
        return;
      }

      const durationMs = Date.now() - t0;
      this.send({ type: 'turn_complete', turnIndex: idx, costUsd: result.costUsd, durationMs });

      await this.callbacks.onTurnComplete?.(this.session.id, {
        turnIndex: idx,
        transcript: result.transcript,
        responseText: result.responseText,
        guardrailDecision: result.guardrailDecision,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        sttMs: result.sttMs,
        llmMs: result.llmMs,
        ttsMs: result.ttsMs,
        costUsd: result.costUsd,
        audioBytesIn: audio.length,
        audioBytesOut,
        traceId: result.traceId,
        llmProvider: result.llmProvider,
        llmModel: result.llmModel,
      });
    } catch (err) {
      if (ac.signal.aborted) {
        // Deliberate mid-TTS cancellation — 'paused' was already sent to client.
        // Partial turn is NOT persisted (no onTurnComplete call).
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = msg.includes('429') || msg.includes('timeout') || msg.includes('ECONNRESET');
      this.send({ type: 'error', code: 'TURN_FAILED', message: msg.slice(0, 300), retryable });

      await this.callbacks.onTurnComplete?.(this.session.id, {
        turnIndex: idx,
        transcript: '',
        responseText: '',
        guardrailDecision: 'allow',
        promptTokens: 0,
        completionTokens: 0,
        sttMs: 0,
        llmMs: 0,
        ttsMs: 0,
        costUsd: 0,
        audioBytesIn: audio.length,
        audioBytesOut: 0,
        error: msg.slice(0, 500),
        llmProvider: '',
        llmModel: '',
      });
    } finally {
      this.abortController = null;
      this.processing = false;
    }
  }

  private async handleClose(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      await this.teardown();
    }
  }

  private async handleError(err: Error): Promise<void> {
    console.error(`[voice-ws][${this.session.id}] WebSocket error:`, err.message);
    await this.handleClose();
  }

  // ── End session ─────────────────────────────────────────────

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    this.send({
      type: 'session_ended',
      totalTurns: this.turnIndex,
      totalCostUsd: this.session.totalCostUsd,
    });

    if (this.ws.readyState === 1 /* OPEN */) {
      this.ws.close(1000, 'session ended');
    }

    await this.teardown();
  }

  private async teardown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.callbacks.onConnectionChange?.(this.session.id, false);
    await this.callbacks.onSessionEnd?.(this.session.id);
    this.emit('ended');
  }

  // ── Helpers ─────────────────────────────────────────────────

  private send(msg: VoiceWsServerMessage): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed — ignore
    }
  }
}
