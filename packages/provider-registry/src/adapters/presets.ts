// SPDX-License-Identifier: MIT
/**
 * Ready-made descriptions of well-known OpenAI-compatible servers.
 *
 * In plain terms: each row says where the server lives and how it differs from
 * the plain OpenAI format. A host shows these as a pick-list; choosing one
 * fills in a provider description of kind `openai-compatible`. Adding a server
 * to this list is adding a row, never adding code.
 *
 * The rows were written from each provider's public documentation
 * (checked 2026-11-12). None has been exercised against the real service.
 */

import type { SecretSlot, WireQuirks } from '../types.js';
import { openAICompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter } from '../types.js';

export interface OpenAICompatiblePreset {
  readonly key: string;
  /** Plain name for a pick-list. */
  readonly label: string;
  /** The usual address. Empty for servers the operator hosts themselves. */
  readonly baseUrl: string;
  /** Whether the usual address is on the operator's own machine or network. */
  readonly local: boolean;
  readonly chat: boolean;
  readonly embeddings: boolean;
  readonly quirks: WireQuirks;
}

export const OPENAI_COMPATIBLE_PRESETS: readonly OpenAICompatiblePreset[] = [
  { key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', local: false, chat: true, embeddings: false, quirks: { tokenLimitParam: 'max_completion_tokens' } },
  { key: 'together', label: 'Together AI', baseUrl: 'https://api.together.ai/v1', local: false, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens', embeddingSizeParam: 'none' } },
  { key: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', local: false, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens' } },
  { key: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', local: false, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens', embeddingSizeParam: 'output_dimension', streamUsage: false } },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', local: false, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens' } },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', local: false, chat: true, embeddings: false, quirks: { tokenLimitParam: 'max_tokens' } },
  { key: 'vllm', label: 'vLLM server', baseUrl: '', local: true, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_completion_tokens', auth: 'none', embeddingSizeParam: 'none' } },
  { key: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens', auth: 'none', embeddingSizeParam: 'none', streamUsage: false } },
  { key: 'ollama', label: 'Ollama (OpenAI-compatible address)', baseUrl: 'http://localhost:11434/v1', local: true, chat: true, embeddings: true, quirks: { tokenLimitParam: 'max_tokens', auth: 'none', toolChoice: false, embeddingSizeParam: 'none' } },
  { key: 'tei', label: 'Text Embeddings Inference', baseUrl: '', local: true, chat: false, embeddings: true, quirks: { auth: 'none', embeddingsPath: '/v1/embeddings', embeddingSizeParam: 'none', modelsPath: '', probePath: '/info' } },
];

const KEY_OR_TOKEN: readonly SecretSlot[] = [
  { name: 'apiKey', label: 'API key', required: false },
  { name: 'bearerToken', label: 'Microsoft Entra access token', required: false },
];

/**
 * Azure OpenAI: the model is a "deployment" named in the path, the key travels
 * in an `api-key` header, and the dated address needs an API version.
 *
 * `baseUrl` is the resource address, for example
 * `https://my-resource.openai.azure.com`. To use the newer version-less
 * address instead, set `baseUrl` to `https://my-resource.openai.azure.com/openai/v1`
 * and the quirks to `{ chatPath: '/chat/completions', embeddingsPath:
 * '/embeddings', modelsPath: '/models', modelInBody: true }` with an empty
 * `apiVersion` setting.
 *
 * Signing in with Microsoft Entra instead of a key: fill the
 * `bearerToken` slot. The registry asks the host's secret resolver for it on
 * every call, so a host that mints Entra tokens returns the current one.
 */
export function azureOpenAIAdapter(): ProviderAdapter {
  return openAICompatibleAdapter({
    kind: 'azure-openai',
    label: 'Azure OpenAI',
    secretSlots: KEY_OR_TOKEN,
    settings: { apiVersion: '2024-10-21' },
    quirks: {
      auth: 'api-key',
      modelInBody: false,
      chatPath: '/openai/deployments/{model}/chat/completions',
      embeddingsPath: '/openai/deployments/{model}/embeddings',
      modelsPath: '/openai/models',
      tokenLimitParam: 'max_completion_tokens',
    },
  });
}

/**
 * Azure AI Foundry model inference: one address for many models, the model
 * named in the body. `baseUrl` is `https://my-resource.services.ai.azure.com`.
 */
export function azureFoundryAdapter(): ProviderAdapter {
  return openAICompatibleAdapter({
    kind: 'azure-foundry',
    label: 'Azure AI Foundry',
    secretSlots: KEY_OR_TOKEN,
    settings: { apiVersion: '2024-05-01-preview' },
    quirks: {
      auth: 'api-key',
      modelInBody: true,
      chatPath: '/models/chat/completions',
      embeddingsPath: '/models/embeddings',
      modelsPath: '/models/info',
      tokenLimitParam: 'max_tokens',
      streamUsage: false,
      embeddingInputType: true,
    },
  });
}

/**
 * Databricks model serving: the serving endpoint's name is in the path and the
 * body carries no model field. `baseUrl` is the workspace address, for example
 * `https://dbc-1234.cloud.databricks.com`. The key is a personal access token
 * or a service-principal token.
 */
export function databricksAdapter(): ProviderAdapter {
  return openAICompatibleAdapter({
    kind: 'databricks',
    label: 'Databricks model serving',
    secretSlots: [{ name: 'apiKey', label: 'access token', required: true }],
    quirks: {
      auth: 'bearer',
      modelInBody: false,
      chatPath: '/serving-endpoints/{model}/invocations',
      embeddingsPath: '/serving-endpoints/{model}/invocations',
      modelsPath: '/api/2.0/serving-endpoints',
      tokenLimitParam: 'max_tokens',
      streamUsage: false,
      embeddingSizeParam: 'none',
    },
  });
}
