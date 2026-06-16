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
 * In GeneWeave this is implemented by wrapping ChatEngine.sendMessage().
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

  /**
   * Execute one voice turn (STT → LLM → TTS).
   *
   * @param sessionId - Voice session ID (for trace / audit).
   * @param turnIndex - 0-based turn counter within the session.
   * @param userId    - Authenticated user ID.
   * @param chatId    - Chat ID shared with the text agent.
   * @param config    - Voice configuration snapshot for this session.
   * @param input     - Raw audio (or text override).
   * @param ctx       - Optional parent execution context; a child is derived
   *                    so tracing stays coherent across STT/LLM/TTS.
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

    const responseText = llmResult.assistantContent.trim();
    const guardrailDecision = llmResult.guardrailDecision ?? 'allow';

    if (guardrailDecision === 'deny') {
      // Return a zero-audio response when guardrails block the LLM output.
      // The caller (route / WS handler) surfaces this as a guardrail_denied event.
      return {
        sessionId,
        turnIndex,
        transcript,
        responseText,
        responseAudio: Buffer.alloc(0),
        responseAudioMimeType: ttsFormatToMime(config.ttsFormat),
        guardrailDecision: 'deny',
        llmProvider: llmResult.provider,
        llmModel: llmResult.model,
        promptTokens: llmResult.promptTokens,
        completionTokens: llmResult.completionTokens,
        sttMs,
        llmMs,
        ttsMs: 0,
        costUsd: llmResult.costUsd,
        traceId: llmResult.traceId,
      };
    }

    // ── Phase 3: TTS ──────────────────────────────────────────
    // Truncate to maxTtsChars to stay within provider limits.
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

    // ── Cost estimation ───────────────────────────────────────
    // STT cost estimated from audio duration (rough: 1 byte ≈ 16-bit PCM at
    // 16 kHz → 0.5 sec per 16 000 bytes; for compressed formats we assume
    // 8× compression → 1 sec per 1 000 bytes).  This is advisory only; the
    // exact charge comes from the provider invoice.
    const estimatedAudioSec = input.textOverride ? 0 : input.audio.length / 8_000;
    const audioCost = estimateVoiceTurnCost({
      transcriptChars: transcript.length,
      responseChars: ttsInput.length,
      audioDurationSec: estimatedAudioSec,
      pricing: this.pricing,
    });
    const totalCost = llmResult.costUsd + audioCost;

    return {
      sessionId,
      turnIndex,
      transcript,
      responseText,
      responseAudio,
      responseAudioMimeType: ttsFormatToMime(config.ttsFormat),
      guardrailDecision: guardrailDecision as 'allow' | 'warn' | 'deny',
      llmProvider: llmResult.provider,
      llmModel: llmResult.model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
      sttMs,
      llmMs,
      ttsMs,
      costUsd: totalCost,
      traceId: llmResult.traceId,
    };
  }
}
