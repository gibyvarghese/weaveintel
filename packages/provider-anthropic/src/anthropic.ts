/**
 * @weaveintel/provider-anthropic — Anthropic Messages API adapter
 *
 * Full-featured chat model covering:
 * - Messages API (generate + stream)
 * - Tool use (function calling)
 * - Vision (image content blocks — base64 & URL)
 * - PDF support (document content blocks)
 * - Extended thinking (manual + adaptive)
 * - Prompt caching (cache_control on content blocks)
 * - Citations (document-based citations)
 * - Structured output (tool_use JSON schema trick)
 * - System messages (top-level, supports content blocks)
 *
 * Uses raw fetch — no vendor SDK dependency.
 */

import type {
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveCapabilities, normalizeError, deadlineSignal } from '@weaveintel/core';
import { weaveRegisterModel } from '@weaveintel/models';

import type { AnthropicProviderOptions } from './shared.js';
import {
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  anthropicRequest,
  anthropicStreamRequest,
} from './shared.js';
import type { AnthropicRequestOptions } from './anthropic-types.js';

import {
  buildAnthropicMessages,
  buildAnthropicTools,
  buildToolChoice,
  parseResponse,
  parseStreamEvent,
} from './anthropic-format.js';
import {
  determineCapabilities,
  getContextWindow,
  getMaxOutputTokens,
} from './anthropic-models.js';

// Re-export provider options from shared
export type { AnthropicProviderOptions } from './shared.js';
export type { AnthropicContentBlock, AnthropicThinkingConfig, AnthropicRequestOptions } from './anthropic-types.js';

// ─── Main model factory ──────────────────────────────────────

/**
 * Creates an Anthropic chat model implementing the weaveIntel Model interface.
 *
 * Supports all Anthropic Messages API features:
 * - Chat completion with tool use
 * - Vision (images) & PDF documents
 * - Extended thinking (manual + adaptive)
 * - Prompt caching
 * - Citations
 * - Streaming
 *
 * Anthropic-specific options are passed via `ModelRequest.metadata`:
 * ```ts
 * const response = await model.generate(ctx, {
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 *   metadata: {
 *     thinking: { type: 'adaptive' },
 *     citations: { enabled: true },
 *   },
 * });
 * ```
 */
export function weaveAnthropicModel(
  modelId: string,
  providerOptions?: AnthropicProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const caps = weaveCapabilities(...determineCapabilities(modelId));

  const info: ModelInfo = {
    provider: 'anthropic',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: getContextWindow(modelId),
    maxOutputTokens: getMaxOutputTokens(modelId),
  };

  return {
    info,
    ...caps,

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const apiKey = resolveApiKey(opts);
      const meta = (request.metadata ?? {}) as AnthropicRequestOptions;
      const headers = makeHeaders(opts, apiKey, meta.betaFeatures);
      const { system, messages } = buildAnthropicMessages(request.messages);

      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        max_tokens: request.maxTokens ?? 4096,
      };

      const systemPrompt = meta.systemPrompt ?? system;
      if (systemPrompt) body['system'] = systemPrompt;

      if (request.tools) body['tools'] = buildAnthropicTools(request.tools);
      const tc = buildToolChoice(request.toolChoice);
      if (tc) body['tool_choice'] = tc;

      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.topP != null) body['top_p'] = request.topP;
      if (meta.topK != null) body['top_k'] = meta.topK;
      if (request.stop) body['stop_sequences'] = request.stop;

      if (meta.thinking) body['thinking'] = meta.thinking;
      if (meta.citations) body['citations'] = meta.citations;
      if (meta.cacheControl) body['cache_control'] = meta.cacheControl;

      if (request.responseFormat) {
        if (request.responseFormat.type === 'json_schema') {
          body['output_config'] = {
            format: {
              type: 'json_schema',
              schema: request.responseFormat.schema,
            },
          };
        }
      }

      if (meta && (request.metadata as Record<string, unknown>)?.['userId']) {
        body['metadata'] = { user_id: (request.metadata as Record<string, unknown>)['userId'] };
      }

      const signal = deadlineSignal(ctx);

      try {
        const raw = (await anthropicRequest(
          baseUrl, '/v1/messages', body, headers, signal,
        )) as Record<string, unknown>;
        return parseResponse(raw);
      } catch (err) {
        throw normalizeError(err, 'anthropic');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const apiKey = resolveApiKey(opts);
      const meta = (request.metadata ?? {}) as AnthropicRequestOptions;
      const headers = makeHeaders(opts, apiKey, meta.betaFeatures);
      const { system, messages } = buildAnthropicMessages(request.messages);

      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      };

      const systemPrompt = meta.systemPrompt ?? system;
      if (systemPrompt) body['system'] = systemPrompt;
      if (request.tools) body['tools'] = buildAnthropicTools(request.tools);
      const tc = buildToolChoice(request.toolChoice);
      if (tc) body['tool_choice'] = tc;
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.topP != null) body['top_p'] = request.topP;
      if (meta.topK != null) body['top_k'] = meta.topK;
      if (request.stop) body['stop_sequences'] = request.stop;
      if (meta.thinking) body['thinking'] = meta.thinking;
      if (meta.citations) body['citations'] = meta.citations;
      if (meta.cacheControl) body['cache_control'] = meta.cacheControl;

      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        for await (const evt of anthropicStreamRequest(baseUrl, '/v1/messages', body, headers, signal)) {
          yield* parseStreamEvent(evt);
        }
      })();
    },
  };
}

// ─── Auto-register with model router ─────────────────────────

let providerOpts: AnthropicProviderOptions = {};

/** Configure global Anthropic provider options */
export function weaveAnthropicConfig(options: AnthropicProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('anthropic', (modelId, options) =>
  weaveAnthropicModel(modelId, { ...providerOpts, ...(options as AnthropicProviderOptions) }),
);

/** Convenience alias */
export function weaveAnthropic(modelId: string, options?: AnthropicProviderOptions): Model {
  return weaveAnthropicModel(modelId, { ...providerOpts, ...options });
}
