/**
 * @weaveintel/provider-openai — OpenAI Image generation adapter
 *
 * Implements the generic ImageModel contract using OpenAI's Image API.
 * Supports generation, editing, and variation via GPT Image and DALL-E models.
 */

import type {
  ImageModel,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelInfo,
  ExecutionContext,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  deadlineSignal,
  normalizeError,
} from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  openaiRequest,
} from './shared.js';

export interface OpenAIImageEditRequest {
  readonly image: string; // base64 or URL
  readonly prompt: string;
  readonly mask?: string; // base64 or URL
  readonly size?: string;
  readonly quality?: string;
  readonly n?: number;
}

export function weaveOpenAIImageModel(
  modelId: string = 'gpt-image-1',
  providerOptions?: OpenAIProviderOptions,
): ImageModel & { edit(ctx: ExecutionContext, request: OpenAIImageEditRequest): Promise<ImageGenerationResponse> } {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);
  const caps = weaveCapabilities(Capabilities.ImageGeneration, Capabilities.ImageEditing);

  const info: ModelInfo = {
    provider: 'openai',
    modelId,
    capabilities: caps.capabilities,
  };

  return {
    info,
    ...caps,

    async generateImage(ctx: ExecutionContext, request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
      const body: Record<string, unknown> = {
        model: modelId,
        prompt: request.prompt,
      };
      if (request.size) body['size'] = request.size;
      if (request.quality) body['quality'] = request.quality;
      if (request.n) body['n'] = request.n;
      body['response_format'] = 'b64_json';

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/images/generations', body, headers, signal)) as Record<string, unknown>;
        const data = raw['data'] as Array<Record<string, unknown>>;

        return {
          images: data.map((d) => ({
            base64: d['b64_json'] as string | undefined,
            url: d['url'] as string | undefined,
            revisedPrompt: d['revised_prompt'] as string | undefined,
          })),
          model: modelId,
        };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async edit(ctx: ExecutionContext, request: OpenAIImageEditRequest): Promise<ImageGenerationResponse> {
      const body: Record<string, unknown> = {
        model: modelId,
        prompt: request.prompt,
        image: request.image,
      };
      if (request.mask) body['mask'] = request.mask;
      if (request.size) body['size'] = request.size;
      if (request.quality) body['quality'] = request.quality;
      if (request.n) body['n'] = request.n;
      body['response_format'] = 'b64_json';

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/images/edits', body, headers, signal)) as Record<string, unknown>;
        const data = raw['data'] as Array<Record<string, unknown>>;

        return {
          images: data.map((d) => ({
            base64: d['b64_json'] as string | undefined,
            url: d['url'] as string | undefined,
            revisedPrompt: d['revised_prompt'] as string | undefined,
          })),
          model: modelId,
        };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIImage(modelId?: string, options?: OpenAIProviderOptions): ReturnType<typeof weaveOpenAIImageModel> {
  return weaveOpenAIImageModel(modelId, options);
}
