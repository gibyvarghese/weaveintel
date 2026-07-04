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

/** True for the GPT Image family (gpt-image-1, gpt-image-2, …). These differ from DALL·E. */
export function isGptImageModel(modelId: string): boolean {
  return /^gpt-image/i.test(modelId);
}

/**
 * Build the /v1/images/generations request body PER MODEL, exactly as the OpenAI Image API expects.
 *
 *   • GPT Image models (gpt-image-1/2): return base64 BY DEFAULT and REJECT `response_format`
 *     ("Unknown parameter: 'response_format'"). They instead support `output_format` (png/jpeg/webp),
 *     `output_compression`, `background` (transparent/opaque/auto) and `moderation` (low/auto), and
 *     `quality` is low/medium/high/auto.
 *   • DALL·E models (dall-e-2/3): support `response_format` (url|b64_json), and dall-e-3 supports
 *     `style` (vivid|natural) and `quality` standard|hd.
 *
 * Exported pure so it can be unit-tested without a network call.
 */
export function buildImageGenerationBody(modelId: string, request: ImageGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: modelId, prompt: request.prompt };
  if (request.size) body['size'] = request.size;
  if (request.quality) body['quality'] = request.quality;
  if (request.n) body['n'] = request.n;

  if (isGptImageModel(modelId)) {
    // GPT Image: NEVER send response_format (it errors). Base64 is the default return shape.
    if (request.background) body['background'] = request.background;
    if (request.outputFormat) body['output_format'] = request.outputFormat;
    if (typeof request.outputCompression === 'number') body['output_compression'] = request.outputCompression;
    if (request.moderation) body['moderation'] = request.moderation;
  } else {
    // DALL·E: response_format is supported; ask for base64 so we never depend on a fetchable URL.
    body['response_format'] = 'b64_json';
    if (request.style) body['style'] = request.style;
  }
  return body;
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
      // Model-aware body (GPT Image rejects response_format; DALL·E supports it). See buildImageGenerationBody.
      const body = buildImageGenerationBody(modelId, request);

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/images/generations', body, headers, signal)) as Record<string, unknown>;
        const data = (raw['data'] as Array<Record<string, unknown>> | undefined) ?? [];

        return {
          images: data.map((d) => ({
            base64: d['b64_json'] as string | undefined,
            url: d['url'] as string | undefined,
            revisedPrompt: d['revised_prompt'] as string | undefined,
          })),
          model: modelId,
          ...(raw['usage'] ? { usage: raw['usage'] as Record<string, unknown> } : {}),
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
      // GPT Image rejects response_format (returns base64 by default); only DALL·E accepts it.
      if (!isGptImageModel(modelId)) body['response_format'] = 'b64_json';

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/images/edits', body, headers, signal)) as Record<string, unknown>;
        const data = (raw['data'] as Array<Record<string, unknown>> | undefined) ?? [];

        return {
          images: data.map((d) => ({
            base64: d['b64_json'] as string | undefined,
            url: d['url'] as string | undefined,
            revisedPrompt: d['revised_prompt'] as string | undefined,
          })),
          model: modelId,
          ...(raw['usage'] ? { usage: raw['usage'] as Record<string, unknown> } : {}),
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
