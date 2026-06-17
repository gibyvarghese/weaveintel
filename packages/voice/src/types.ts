/**
 * @weaveintel/voice — Core types
 *
 * All types used across the voice agent pipeline: session state, config,
 * pipeline results, WebSocket message framing.
 */

// ─── Session ──────────────────────────────────────────────────

export type VoiceSessionStatus = 'active' | 'paused' | 'ended' | 'error';

export interface VoiceConfig {
  /** STT provider (default: 'openai') */
  sttProvider: string;
  /** STT model (default: 'whisper-1') */
  sttModel: string;
  /** STT language hint (BCP-47, e.g. 'en', 'fr') — optional */
  sttLanguage?: string;
  /** TTS provider (default: 'openai') */
  ttsProvider: string;
  /** TTS model (default: 'tts-1') */
  ttsModel: string;
  /** Voice name (default: 'alloy') */
  ttsVoice: string;
  /** Playback speed 0.25–4.0 (default: 1.0) */
  ttsSpeed: number;
  /** Audio response format (mp3 | opus | aac | flac | wav | pcm) — default: 'mp3' */
  ttsFormat: string;
  /** Tools enabled for this voice session (null → use agent defaults) */
  enabledTools?: string[] | null;
  /** Agent mode: 'agent' | 'direct' | 'supervisor' */
  mode: string;
  /** Guardrail policy key override */
  guardrailPolicy?: string;
  /** Cost policy key override */
  costPolicy?: string;
  /**
   * Pipeline mode:
   *   'chained'  — Whisper STT → ChatEngine LLM → tts-1 TTS (default, turn-based REST)
   *   'realtime' — OpenAI Realtime API (native speech-to-speech, low-latency WebSocket)
   */
  pipelineMode?: 'chained' | 'realtime';
  /** OpenAI Realtime model (default: 'gpt-realtime-2') — realtime mode only */
  realtimeModel?: string;
  /**
   * Number of turns after which the realtime upstream WebSocket is transparently
   * rotated to prevent context-window latency drift.  0 = disabled.  Default: 8.
   */
  realtimeSessionRotateAfterTurns?: number;
  /**
   * Max wall-clock time (ms) per tool call before the proxy returns a timeout
   * error to the model.  0 = unlimited.  Default: 800.
   */
  realtimeToolBudgetMs?: number;
  /**
   * Highest tool risk level that may be invoked automatically in a realtime
   * session.  Tools above this level are silently excluded from the session
   * (pending a future approval-gate UI).  Default: 'low'.
   *
   * Maps to ToolRiskLevel: 'low' → 'read-only', 'medium' → 'write' and below,
   * 'high' → all tools.
   */
  realtimeMaxAutoToolRisk?: 'low' | 'medium' | 'high';
  /**
   * Whether to run input guardrails on user transcripts in the realtime
   * pipeline.  Default: true.  Set to false to skip guardrail checks (e.g.
   * for trusted internal sessions or when latency is critical).
   */
  realtimeInputGuardrails?: boolean;
  /**
   * Whether to run output guardrails on agent response transcripts in the
   * realtime pipeline.  Default: true.  Output guardrails are checked after
   * the audio has streamed — deny truncates the response from model context
   * and notifies the client.
   */
  realtimeOutputGuardrails?: boolean;
}

export interface VoiceSession {
  id: string;
  userId: string;
  tenantId: string | null;
  /** Chat ID shared with text agent — conversation history, memory, tools are identical */
  chatId: string;
  status: VoiceSessionStatus;
  config: VoiceConfig;
  totalTurns: number;
  totalSttMs: number;
  totalTtsMs: number;
  totalLlmMs: number;
  totalCostUsd: number;
  totalAudioBytes: number;
  wsConnected: boolean;
  lastActiveAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Turn (one STT→LLM→TTS round-trip) ───────────────────────

export interface VoiceTurnInput {
  /** Raw audio bytes (WAV, MP3, OGG, FLAC, WEBM …) */
  audio: Buffer;
  /** MIME type of the audio (e.g. 'audio/wav', 'audio/mpeg') */
  mimeType?: string;
  /** Pre-transcribed text — skips STT when provided (e.g. hybrid UI) */
  textOverride?: string;
}

export interface VoiceTurnResult {
  /** Full session ID */
  sessionId: string;
  /** 0-based turn index within the session */
  turnIndex: number;
  /** Transcript produced by STT (or textOverride if provided) */
  transcript: string;
  /** LLM text response */
  responseText: string;
  /** TTS audio bytes (format determined by VoiceConfig.ttsFormat) */
  responseAudio: Buffer;
  /** MIME type of responseAudio (e.g. 'audio/mpeg') */
  responseAudioMimeType: string;
  /** Guardrail decision for this turn */
  guardrailDecision: 'allow' | 'warn' | 'deny';
  /** LLM provider + model chosen for this turn */
  llmProvider: string;
  llmModel: string;
  /** Token usage */
  promptTokens: number;
  completionTokens: number;
  /** Per-phase wall-clock durations */
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  /** Estimated USD cost (STT + LLM + TTS) */
  costUsd: number;
  /** OpenTelemetry trace ID (if available) */
  traceId?: string;
}

// ─── WebSocket framing ────────────────────────────────────────

/**
 * Messages sent CLIENT → SERVER over the voice WebSocket.
 *
 * barge_in — realtime pipeline only.  Client sends this immediately after
 * receiving a server `barge_in` event, reporting exactly how many ms of
 * audio were played before the user started speaking.  The proxy uses
 * audioPlayedMs in the `conversation.item.truncate` it sends to OpenAI so
 * transcript alignment is accurate.
 *
 * tool_approved / tool_denied — realtime pipeline only.  Sent when a high-risk
 * tool call triggered a `tool_approval_required` prompt and the user approved
 * or denied it.
 */
export type VoiceWsClientMessage =
  | { type: 'audio'; payload: string; mimeType?: string }
  | { type: 'text'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end' }
  | { type: 'ping' }
  | { type: 'barge_in'; itemId: string; audioPlayedMs: number }
  | { type: 'tool_approved'; callId: string }
  | { type: 'tool_denied'; callId: string; reason?: string };

/**
 * Messages sent SERVER → CLIENT over the voice WebSocket.
 *
 * Realtime-specific additions:
 *   realtime_ready    — proxy connected to OpenAI; session configured
 *   speech_started    — VAD detected user speech (normal turn, agent was silent)
 *   speech_stopped    — VAD silence: user finished speaking
 *   barge_in          — user spoke WHILE agent was generating audio; client
 *                       must stop playback immediately and reply with a
 *                       client-side `barge_in` message (audioPlayedMs)
 *   barge_in_ack      — proxy sent conversation.item.truncate to OpenAI;
 *                       audioEndMs is what was committed (for telemetry)
 */
export type VoiceWsServerMessage =
  | { type: 'session_ready'; sessionId: string; chatId: string; config: VoiceConfig }
  | { type: 'transcript'; turnIndex: number; text: string }
  | { type: 'llm_text'; turnIndex: number; text: string }
  | { type: 'audio'; turnIndex: number; payload: string; mimeType: string; done: boolean; itemId?: string }
  | { type: 'turn_complete'; turnIndex: number; costUsd: number; durationMs: number }
  | { type: 'guardrail_denied'; turnIndex: number; reason: string; phase: 'input' | 'output' }
  | { type: 'error'; code: string; message: string; retryable: boolean; fallbackToChained?: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'session_ended'; totalTurns: number; totalCostUsd: number }
  | { type: 'pong' }
  | { type: 'realtime_ready' }
  | { type: 'speech_started' }
  | { type: 'speech_stopped' }
  | { type: 'barge_in'; itemId: string }
  | { type: 'barge_in_ack'; audioEndMs: number }
  | { type: 'session_rotating' }
  | { type: 'tool_executing'; callId: string; toolName: string }
  | { type: 'tool_complete'; callId: string; durationMs: number }
  | { type: 'tool_approval_required'; callId: string; toolName: string; args: unknown }
  | { type: 'cost_update'; turnIndex: number; costUsd: number; totalCostUsd: number };

// ─── Cost estimate ────────────────────────────────────────────

/** Audio-specific pricing (USD per second of audio) */
export interface VoiceModelPricing {
  /** USD per 1 000 input characters for TTS */
  ttsPerKChar: number;
  /** USD per minute of audio for STT */
  sttPerMinute: number;
}

/** Built-in fallback pricing (OpenAI tts-1 + whisper-1 as of 2025) */
export const VOICE_FALLBACK_PRICING: VoiceModelPricing = {
  ttsPerKChar: 0.015,   // $15 / 1M chars → $0.015 per 1K chars
  sttPerMinute: 0.006,  // $0.006 / min
};

/** Return the MIME type string for a given TTS format */
export function ttsFormatToMime(format: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/ogg',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
  };
  return map[format] ?? 'audio/mpeg';
}

/** Estimate cost for one voice turn */
export function estimateVoiceTurnCost(opts: {
  transcriptChars: number;
  responseChars: number;
  audioDurationSec: number;
  pricing?: VoiceModelPricing;
}): number {
  const p = opts.pricing ?? VOICE_FALLBACK_PRICING;
  const sttCost = (opts.audioDurationSec / 60) * p.sttPerMinute;
  const ttsCost = (opts.responseChars / 1000) * p.ttsPerKChar;
  return sttCost + ttsCost;
}
