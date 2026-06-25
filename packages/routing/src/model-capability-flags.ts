/**
 * @weaveintel/routing — Baseline model capability flags
 *
 * Centralises the per-model capability knowledge that the routing layer and
 * database seed both need.  The flags reflect published model characteristics
 * (thinking/reasoning, vision, native JSON mode, computer use, long context,
 * realtime audio) and must be kept in sync as new models are added.
 *
 * Convention: 1 = supported, 0 = not supported (matches the DB column type).
 */

export interface ModelCapabilityFlags {
  /** Extended thinking / chain-of-thought reasoning mode. */
  supports_thinking: 0 | 1;
  /** Image / multimodal vision input. */
  supports_vision: 0 | 1;
  /** Native structured JSON output mode (e.g. OpenAI response_format). */
  supports_json_mode: 0 | 1;
  /** GUI / desktop computer-use tool actions (mid-2026 capability). */
  supports_computer_use: 0 | 1;
  /** Realtime audio streaming I/O. */
  supports_realtime_audio: 0 | 1;
  /** Long-context window ≥ 512k tokens effectively usable. */
  supports_long_context: 0 | 1;
}

/**
 * Models known to support extended thinking / chain-of-thought reasoning.
 */
const THINKING_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
  'o3',
  'o3-mini',
  'o4-mini',
  'gpt-5',
  'gpt-5-mini',
  'deepseek-r1',
  'deepseek-r1-api',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);

/**
 * Models that do NOT support vision / image inputs.
 * Most models support vision; only well-known text-only exceptions are listed.
 */
const NON_VISION_MODELS = new Set([
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
  'mistral-large-2',
  'mistral-medium-3',
  'deepseek-v3',
  'deepseek-r1',
  'deepseek-r1-api',
  'llama-4-scout',
  'llama-4-maverick',
  'llama3.1',
  'llama3',
  'llama3.3',
  'qwen2.5',
  'qwen3',
  'mistral',
  'phi3',
  'phi4',
  'gemma2',
  'gemma3',
  'mistral-nemo',
  'codestral',
  'codestral-local',
  'local',
]);

/**
 * Models with native JSON-mode / structured-output support.
 */
const JSON_MODE_MODELS = new Set([
  'o3',
  'o4-mini',
  'mistral-large-2',
  'mistral-medium-3',
  'codestral',
  'codestral-local',
]);

/**
 * Models that support GUI computer-use tool actions (mid-2026).
 * Primarily claude-opus-4-8 which ships with native computer-use via Anthropic API.
 */
const COMPUTER_USE_MODELS = new Set([
  'claude-opus-4-8',
]);

/**
 * Models with realtime audio streaming capability.
 * Currently limited to GPT-4o Realtime (accessed via special endpoint, not
 * standard completions — the flag indicates the model family supports it).
 */
const REALTIME_AUDIO_MODELS = new Set([
  'gpt-4o',
]);

/**
 * Models with effective long-context support (≥ 512k tokens).
 * Includes 1M+ context models and 512k+ context models confirmed mid-2026.
 */
const LONG_CONTEXT_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'grok-4',
  'llama-4-scout',
  'llama-4-maverick',
]);

/**
 * Return baseline capability flags for a model ID.
 *
 * These flags are used when seeding `model_capability_scores` rows and when
 * the routing layer needs to filter candidates by capability at query time.
 */
export function getModelCapabilityFlags(modelId: string): ModelCapabilityFlags {
  return {
    supports_thinking:       THINKING_MODELS.has(modelId) ? 1 : 0,
    supports_vision:         NON_VISION_MODELS.has(modelId) ? 0 : 1,
    supports_json_mode:      (JSON_MODE_MODELS.has(modelId) || modelId.startsWith('gpt-')) ? 1 : 0,
    supports_computer_use:   COMPUTER_USE_MODELS.has(modelId) ? 1 : 0,
    supports_realtime_audio: REALTIME_AUDIO_MODELS.has(modelId) ? 1 : 0,
    supports_long_context:   LONG_CONTEXT_MODELS.has(modelId) ? 1 : 0,
  };
}

/**
 * Return the advertised context window size in thousands of tokens.
 * Used by the migration and seed to populate context_window_k.
 */
export function getModelContextWindowK(modelId: string): number | null {
  const MAP: Record<string, number> = {
    'claude-sonnet-4-6':         200,
    'claude-opus-4-7':           200,
    'claude-haiku-4-5-20251001': 200,
    'claude-fable-5':            1000,
    'claude-opus-4-8':           1000,
    'gpt-4o':                    128,
    'gpt-4o-mini':               128,
    'gpt-4.1':                   1000,
    'gpt-4.1-mini':              1000,
    'gpt-4.1-nano':              1000,
    'o3':                        200,
    'o4-mini':                   200,
    'gemini-2.5-pro':            1000,
    'gemini-2.5-flash':          1000,
    'gemini-2.5-flash-lite':     1000,
    'gemini-1.5-pro':            2000,
    'gemini-1.5-flash':          1000,
    'grok-3':                    131,
    'grok-4':                    1000,
    'deepseek-v3':               128,
    'deepseek-r1':               128,
    'deepseek-r1-api':           164,
    'mistral-large-2':           128,
    'mistral-medium-3':          128,
    'codestral':                 256,
    'amazon-nova-pro':           300,
    'amazon-nova-lite':          300,
    'amazon-nova-micro':         128,
    'llama-4-scout':             10000,
    'llama-4-maverick':          512,
    'llama3.1':                  128,
    'llama3':                    8,
    'llama3.3':                  128,
    'qwen2.5':                   128,
    'qwen3':                     128,
    'mistral':                   32,
    'phi3':                      128,
    'phi4':                      128,
    'gemma2':                    8,
    'gemma3':                    128,
    'mistral-nemo':              128,
    'codestral-local':           256,
    'local':                     8,
  };
  return MAP[modelId] ?? null;
}

/**
 * Return the max output tokens in thousands for a given model.
 */
export function getModelMaxOutputK(modelId: string): number | null {
  const MAP: Record<string, number> = {
    'claude-sonnet-4-6':         64,
    'claude-opus-4-7':           32,
    'claude-haiku-4-5-20251001': 8,
    'claude-fable-5':            64,
    'claude-opus-4-8':           32,
    'gpt-4o':                    16,
    'gpt-4o-mini':               16,
    'gpt-4.1':                   32,
    'gpt-4.1-mini':              32,
    'gpt-4.1-nano':              32,
    'o3':                        100,
    'o4-mini':                   100,
    'gemini-2.5-pro':            65,
    'gemini-2.5-flash':          65,
    'gemini-2.5-flash-lite':     8,
    'gemini-1.5-pro':            8,
    'gemini-1.5-flash':          8,
    'grok-3':                    32,
    'grok-4':                    32,
    'deepseek-v3':               8,
    'deepseek-r1':               8,
    'deepseek-r1-api':           64,
    'mistral-large-2':           32,
    'mistral-medium-3':          32,
    'codestral':                 32,
    'amazon-nova-pro':           5,
    'amazon-nova-lite':          5,
    'amazon-nova-micro':         5,
    'llama-4-scout':             16,
    'llama-4-maverick':          16,
  };
  return MAP[modelId] ?? null;
}
