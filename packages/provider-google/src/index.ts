/**
 * @weaveintel/provider-google — Google Gemini chat models for weaveIntel.
 *
 * Auto-registers the `google` and `gemini` providers with the model router
 * on import. Use `weaveGoogle(modelId)` for an instance, or rely on routing.
 */

export {
  weaveGoogleModel,
  weaveGoogleConfig,
  weaveGoogle,
  type GoogleProviderOptions,
} from './google.js';
