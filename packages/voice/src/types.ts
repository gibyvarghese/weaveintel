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
 */
export type VoiceWsClientMessage =
  | { type: 'audio'; payload: string; mimeType?: string }   // base64-encoded audio chunk
  | { type: 'text'; text: string }                           // text-only turn (skips STT)
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end' }
  | { type: 'ping' };

/**
 * Messages sent SERVER → CLIENT over the voice WebSocket.
 */
export type VoiceWsServerMessage =
  | { type: 'session_ready'; sessionId: string; chatId: string; config: VoiceConfig }
  | { type: 'transcript'; turnIndex: number; text: string }
  | { type: 'llm_text'; turnIndex: number; text: string }
  | { type: 'audio'; turnIndex: number; payload: string; mimeType: string; done: boolean }
  | { type: 'turn_complete'; turnIndex: number; costUsd: number; durationMs: number }
  | { type: 'guardrail_denied'; turnIndex: number; reason: string }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'session_ended'; totalTurns: number; totalCostUsd: number }
  | { type: 'pong' };

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
