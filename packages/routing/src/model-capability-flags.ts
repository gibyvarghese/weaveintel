/**
 * @weaveintel/routing — Baseline model capability flags
 *
 * Centralises the per-model capability knowledge that the routing layer and
 * database seed both need.  The flags reflect published model characteristics
 * (thinking/reasoning, vision, native JSON mode) and must be kept in sync as
 * new models are added.
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
}

/**
 * Models known to support extended thinking / chain-of-thought reasoning.
 * Claude Opus 4 and OpenAI o-series reasoning models.
 */
const THINKING_MODELS = new Set([
  'claude-opus-4-20250514',
  'o3',
  'o4-mini',
]);

/**
 * Models that do NOT support vision / image inputs.
 * Most models support vision; exceptions are listed here.
 */
const NON_VISION_MODELS = new Set([
  'gpt-4.1-nano',
]);

/**
 * Models with native JSON-mode / structured-output support.
 * OpenAI GPT and o-series models expose this via response_format.
 */
const JSON_MODE_MODELS = new Set([
  'o3',
  'o4-mini',
]);

/**
 * Return baseline capability flags for a model ID.
 *
 * These flags are used when seeding `model_capability_scores` rows and when
 * the routing layer needs to filter candidates by capability at query time.
 * If a model is not listed in any set above it receives the conservative
 * defaults: no thinking, vision enabled, no JSON mode.
 */
export function getModelCapabilityFlags(modelId: string): ModelCapabilityFlags {
  return {
    supports_thinking: THINKING_MODELS.has(modelId) ? 1 : 0,
    supports_vision: NON_VISION_MODELS.has(modelId) ? 0 : 1,
    supports_json_mode: (JSON_MODE_MODELS.has(modelId) || modelId.startsWith('gpt-')) ? 1 : 0,
  };
}
