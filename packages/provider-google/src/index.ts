// SPDX-License-Identifier: MIT
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

// Google as a provider described by data, for `@weaveintel/provider-registry`:
// the Gemini API (one key) and Vertex AI (a service-account file).
export { geminiAdapter, vertexAdapter, googleChatBody, googleErrorOverride, signServiceAccountAssertion } from './registry-adapters.js';
