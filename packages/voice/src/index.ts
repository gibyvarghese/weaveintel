/**
 * @weaveintel/voice — Public API
 *
 * Production-grade voice agent pipeline for WeaveIntel.
 * Provides full STT→LLM→TTS parity with text-based agents:
 * memory, tools, guardrails, cost governor, evals, contracts,
 * a2a, supervisor/worker, workflows — all inherited via ChatEngine.
 */

export type {
  VoiceConfig,
  VoiceSession,
  VoiceSessionStatus,
  VoiceTurnInput,
  VoiceTurnResult,
  VoiceWsClientMessage,
  VoiceWsServerMessage,
  VoiceModelPricing,
} from './types.js';
export {
  ttsFormatToMime,
  estimateVoiceTurnCost,
  VOICE_FALLBACK_PRICING,
} from './types.js';

export type { VoiceTurnSender, VoicePipelineOptions, TurnStreamCallbacks } from './pipeline.js';
export { VoicePipeline } from './pipeline.js';

export type { VoiceWsHandlerCallbacks, VoiceWsHandlerOptions } from './ws-handler.js';
export { VoiceWsHandler } from './ws-handler.js';

export type {
  RealtimeProxyOptions,
  RealtimeProxyCallbacks,
  RealtimeTool,
  RealtimeToolCall,
  RealtimeUsage,
} from './realtime-proxy.js';
export {
  VoiceRealtimeProxy,
  computeRealtimeCostUsd,
  REALTIME_PRICING,
} from './realtime-proxy.js';
