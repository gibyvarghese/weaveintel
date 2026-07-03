/**
 * @weaveintel/voice — VoicePipeline
 *
 * The core STT → LLM → TTS pipeline.  Intentionally provider-agnostic:
 * callers supply an `AudioModel` (for STT and TTS) and a generic `sendTurn`
 * callback that wraps the text-based `ChatEngine.sendMessage()`.  This means
 * the voice pipeline inherits the full capability set of the text agent
 * (memory, tools, guardrails, cost governor, evals, contracts, a2a,
 * supervisor/worker, etc.) without duplicating any of that logic here.
 *
 * Lifecycle per turn:
 *   1. STT  — transcribe incoming audio → text transcript
 *   2. LLM  — send transcript to the agent, get text response + metadata
 *   3. TTS  — synthesise the LLM response → audio bytes
 *
 * Each phase is timed independently and the results are returned in a
 * `VoiceTurnResult` so callers can stream progress events to the client.
 *
 * Phase 6 addition: `processTurnStreaming()` variant that begins sending TTS
 * audio chunks to the caller as the provider generates them, via callbacks,
 * instead of buffering the full response before returning.
 *
 * Phase 7 addition: `processTurnStreaming()` accepts an optional `AbortSignal`.
 * When the signal fires during TTS, the stream is terminated immediately and an
 * `AbortError` is thrown — the terminal `onAudioChunk(done=true)` is NOT emitted.
 * The caller is responsible for sending a `paused` event to the client.
 */

import type { AudioModel, ExecutionContext } from '@weaveintel/core';
import { weaveContext, normalizeError } from '@weaveintel/core';
import {
  type VoiceConfig,
  type VoiceTurnInput,
  type VoiceTurnResult,
  type VoiceModelPricing,
  VOICE_FALLBACK_PRICING,
  ttsFormatToMime,
  estimateVoiceTurnCost,
} from './types.js';

// ─── Callback types ───────────────────────────────────────────

/**
 * Minimal interface for what VoicePipeline needs from the LLM layer.
 * In a consuming application this is implemented by wrapping ChatEngine.sendMessage().
 */
export interface VoiceTurnSender {
  /**
   * Process one text turn and return the agent response.
   * The implementation must integrate the full agent stack (tools, memory,
   * guardrails, cost governor, evals…).
   */
  send(opts: {
    userId: string;
    chatId: string;
    content: string;
    model?: string;
    provider?: string;
    enabledTools?: string[] | null;
    mode?: string;
  }): Promise<{
    assistantContent: string;
    guardrailDecision?: 'allow' | 'warn' | 'deny';
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    traceId?: string;
  }>;
}

// ─── Streaming callbacks (Phase 6) ───────────────────────────

/**
 * Callbacks for `processTurnStreaming()`.
 *
 * `onLlmComplete` fires once the LLM response is available but before TTS
 * begins.  This lets the caller emit `transcript` and `llm_text` WS events
 * to the client immediately, cutting the perceived latency of the chained
 * pipeline.
 *
 * `onAudioChunk` fires for every TTS chunk yielded by the provider, and
 * once at the end with `done=true` and an empty buffer as a stream-end
 * signal.  It is NOT called when the guardrail decision is 'deny' (TTS is
 * skipped in that case).
 */
export interface TurnStreamCallbacks {
  onLlmComplete(
    transcript: string,
    responseText: string,
    guardrailDecision: 'allow' | 'warn' | 'deny',
  ): void;
  onAudioChunk(chunk: Buffer, done: boolean): void;
}

// ─── Pipeline ─────────────────────────────────────────────────

export interface VoicePipelineOptions {
  /** AudioModel that implements `transcribe()` (STT) and `speak()` (TTS). */
  audioModel: AudioModel;
  /** Callback that runs the LLM turn through the text agent stack. */
  sender: VoiceTurnSender;
  /** Optional audio pricing for cost estimation. */
  pricing?: VoiceModelPricing;
  /** Maximum audio input size in bytes (default 25 MB — OpenAI Whisper limit). */
  maxAudioBytes?: number;
  /** Maximum TTS response characters (default 4096). */
  maxTtsChars?: number;
}

// Internal type for the result of STT + LLM phases
interface EarlyPhaseResult {
  transcript: string;
  sttMs: number;
  llmResult: Awaited<ReturnType<VoiceTurnSender['send']>>;
  llmMs: number;
}

export class VoicePipeline {
  private readonly audioModel: AudioModel;
  private readonly sender: VoiceTurnSender;
  private readonly pricing: VoiceModelPricing;
  private readonly maxAudioBytes: number;
  private readonly maxTtsChars: number;

  constructor(opts: VoicePipelineOptions) {
    this.audioModel = opts.audioModel;
    this.sender = opts.sender;
    this.pricing = opts.pricing ?? VOICE_FALLBACK_PRICING;
    this.maxAudioBytes = opts.maxAudioBytes ?? 25 * 1024 * 1024;
    this.maxTtsChars = opts.maxTtsChars ?? 4096;
  }

  // ── Shared STT + LLM phases ───────────────────────────────

  private async runEarlyPhases(
    _sessionId: string,
    _turnIndex: number,
    userId: string,
    chatId: string,
    config: VoiceConfig,
    input: VoiceTurnInput,
    execCtx: ExecutionContext,
  ): Promise<EarlyPhaseResult> {
    // ── Phase 1: STT ──────────────────────────────────────────
    let transcript: string;
    let sttMs = 0;

    if (input.textOverride) {
      transcript = input.textOverride.trim();
      sttMs = 0;
    } else {
      if (input.audio.length > this.maxAudioBytes) {
        throw new Error(
          `Audio chunk too large: ${input.audio.length} bytes exceeds limit of ${this.maxAudioBytes} bytes`,
        );
      }

      const t0 = Date.now();
      try {
        if (!this.audioModel.transcribe) {
          throw new Error('AudioModel does not support transcription (STT)');
        }
        transcript = await this.audioModel.transcribe(execCtx, {
          audio: input.audio,
          language: config.sttLanguage,
        });
      } catch (err) {
        throw normalizeError(err, config.sttProvider);
      }
      sttMs = Date.now() - t0;

      transcript = transcript.trim();
      if (!transcript) {
        throw new Error('STT produced empty transcript — audio may be silent or too short');
      }
    }

    // ── Phase 2: LLM (via text agent stack) ──────────────────
    const t1 = Date.now();
    let llmResult: Awaited<ReturnType<VoiceTurnSender['send']>>;
    try {
      llmResult = await this.sender.send({
        userId,
        chatId,
        content: transcript,
        enabledTools: config.enabledTools ?? null,
        mode: config.mode,
      });
    } catch (err) {
      throw normalizeError(err, 'llm');
    }
    const llmMs = Date.now() - t1;

    return { transcript, sttMs, llmResult, llmMs };
  }

  // ── Cost helper ───────────────────────────────────────────

  private buildCostAndResult(
    sessionId: string,
    turnIndex: number,
    input: VoiceTurnInput,
    transcript: string,
    sttMs: number,
    llmMs: number,
    ttsMs: number,
    llmResult: EarlyPhaseResult['llmResult'],
    ttsInput: string,
    responseAudio: Buffer,
    responseAudioMimeType: string,
    guardrailDecision: 'allow' | 'warn' | 'deny',
  ): VoiceTurnResult {
    const estimatedAudioSec = input.textOverride ? 0 : input.audio.length / 8_000;
    const audioCost = estimateVoiceTurnCost({
      transcriptChars: transcript.length,
      responseChars: ttsInput.length,
      audioDurationSec: estimatedAudioSec,
      pricing: this.pricing,
    });

    return {
      sessionId,
      turnIndex,
      transcript,
      responseText: llmResult.assistantContent.trim(),
      responseAudio,
      responseAudioMimeType,
      guardrailDecision,
      llmProvider: llmResult.provider,
      llmModel: llmResult.model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
      sttMs,
      llmMs,
      ttsMs,
      costUsd: llmResult.costUsd + audioCost,
      traceId: llmResult.traceId,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute one voice turn (STT → LLM → TTS), buffering the full TTS audio
   * before returning.  Preserved for backward compatibility; new callers
   * should prefer `processTurnStreaming()` for lower latency.
   *
   * @param sessionId - Voice session ID (for trace / audit).
   * @param turnIndex - 0-based turn counter within the session.
   * @param userId    - Authenticated user ID.
   * @param chatId    - Chat ID shared with the text agent.
   * @param config    - Voice configuration snapshot for this session.
   * @param input     - Raw audio (or text override).
   * @param ctx       - Optional parent execution context.
   */
  async processTurn(
    sessionId: string,
    turnIndex: number,
    userId: string,
    chatId: string,
    config: VoiceConfig,
    input: VoiceTurnInput,
    ctx?: ExecutionContext,
  ): Promise<VoiceTurnResult> {
    const execCtx = ctx ?? weaveContext({ deadline: Date.now() + 120_000 });
    const { transcript, sttMs, llmResult, llmMs } = await this.runEarlyPhases(
      sessionId, turnIndex, userId, chatId, config, input, execCtx,
    );

    const responseText = llmResult.assistantContent.trim();
    const guardrailDecision = (llmResult.guardrailDecision ?? 'allow') as 'allow' | 'warn' | 'deny';
    const mimeType = ttsFormatToMime(config.ttsFormat);

    if (guardrailDecision === 'deny') {
      return this.buildCostAndResult(
        sessionId, turnIndex, input, transcript, sttMs, llmMs, 0,
        llmResult, '', Buffer.alloc(0), mimeType, 'deny',
      );
    }

    const ttsInput = responseText.slice(0, this.maxTtsChars);

    const t2 = Date.now();
    let responseAudio: Buffer;
    try {
      if (!this.audioModel.speak) {
        throw new Error('AudioModel does not support speech synthesis (TTS)');
      }
      responseAudio = await this.audioModel.speak(execCtx, {
        input: ttsInput,
        voice: config.ttsVoice,
        speed: config.ttsSpeed,
        responseFormat: config.ttsFormat,
      });
    } catch (err) {
      throw normalizeError(err, config.ttsProvider);
    }
    const ttsMs = Date.now() - t2;

    return this.buildCostAndResult(
      sessionId, turnIndex, input, transcript, sttMs, llmMs, ttsMs,
      llmResult, ttsInput, responseAudio, mimeType, guardrailDecision,
    );
  }

  /**
   * Execute one voice turn with streaming TTS output (Phase 6).
   *
   * STT and LLM run synchronously first.  Once the LLM response is available,
   * `callbacks.onLlmComplete` is called so the caller can emit `transcript`
   * and `llm_text` events immediately.  TTS chunks are then yielded one at a
   * time via `callbacks.onAudioChunk(chunk, done=false)`, with a terminal
   * `callbacks.onAudioChunk(Buffer.alloc(0), done=true)` to signal the end of
   * the stream.
   *
   * When the guardrail decision is 'deny', TTS is skipped entirely and
   * `onAudioChunk` is NOT called.
   *
   * If the `AudioModel` does not implement `speakStream`, this method falls
   * back to `speak()` and yields a single chunk (same content, higher
   * latency) — backward-compatible.
   *
   * If `signal` is provided and fires during the TTS phase, the stream is
   * aborted immediately.  `onAudioChunk(done=true)` is NOT emitted and the
   * returned Promise rejects with a DOMException AbortError.
   *
   * Returns a `VoiceTurnResult` with the accumulated `responseAudio` buffer
   * for callers that need the full audio (e.g. for byte-count stats).
   */
  async processTurnStreaming(
    sessionId: string,
    turnIndex: number,
    userId: string,
    chatId: string,
    config: VoiceConfig,
    input: VoiceTurnInput,
    callbacks: TurnStreamCallbacks,
    ctx?: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<VoiceTurnResult> {
    const execCtx = ctx ?? weaveContext({ deadline: Date.now() + 120_000 });
    const { transcript, sttMs, llmResult, llmMs } = await this.runEarlyPhases(
      sessionId, turnIndex, userId, chatId, config, input, execCtx,
    );

    const responseText = llmResult.assistantContent.trim();
    const guardrailDecision = (llmResult.guardrailDecision ?? 'allow') as 'allow' | 'warn' | 'deny';
    const mimeType = ttsFormatToMime(config.ttsFormat);

    // Notify caller that LLM is done — client can render transcript immediately
    callbacks.onLlmComplete(transcript, responseText, guardrailDecision);

    if (guardrailDecision === 'deny') {
      // TTS is skipped; onAudioChunk is NOT called so client sends no audio frames
      return this.buildCostAndResult(
        sessionId, turnIndex, input, transcript, sttMs, llmMs, 0,
        llmResult, '', Buffer.alloc(0), mimeType, 'deny',
      );
    }

    const ttsInput = responseText.slice(0, this.maxTtsChars);
    const t2 = Date.now();
    const chunks: Buffer[] = [];

    try {
      if (this.audioModel.speakStream) {
        // Streaming path: yield chunks as the provider generates them
        for await (const chunk of this.audioModel.speakStream(execCtx, {
          input: ttsInput,
          voice: config.ttsVoice,
          speed: config.ttsSpeed,
          responseFormat: config.ttsFormat,
          signal,
        })) {
          // Check signal at top of each iteration — abort fires between yields
          if (signal?.aborted) {
            throw new DOMException('TTS streaming cancelled', 'AbortError');
          }
          chunks.push(chunk);
          callbacks.onAudioChunk(chunk, false);
        }
      } else if (this.audioModel.speak) {
        // Fallback: buffer entire response then yield once
        const buf = await this.audioModel.speak(execCtx, {
          input: ttsInput,
          voice: config.ttsVoice,
          speed: config.ttsSpeed,
          responseFormat: config.ttsFormat,
          signal,
        });
        // If signal aborted while speak() was running, discard the result
        if (signal?.aborted) {
          throw new DOMException('TTS synthesis cancelled', 'AbortError');
        }
        if (buf.length > 0) {
          chunks.push(buf);
          callbacks.onAudioChunk(buf, false);
        }
      } else {
        throw new Error('AudioModel does not support speech synthesis (TTS)');
      }
    } catch (err) {
      // Re-throw AbortError without wrapping — caller checks signal.aborted
      if (signal?.aborted) throw err;
      throw normalizeError(err, config.ttsProvider);
    }

    // Terminal done signal — only sent when TTS completed without cancellation
    callbacks.onAudioChunk(Buffer.alloc(0), true);

    const ttsMs = Date.now() - t2;
    const responseAudio = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);

    return this.buildCostAndResult(
      sessionId, turnIndex, input, transcript, sttMs, llmMs, ttsMs,
      llmResult, ttsInput, responseAudio, mimeType, guardrailDecision,
    );
  }
}
