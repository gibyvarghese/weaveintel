/**
 * @weaveintel/provider-openai — OpenAI Moderation adapter
 *
 * Implements the generic ModerationModel contract using OpenAI's
 * Moderations API. Supports text and multi-modal moderation inputs.
 */

import type {
  ExecutionContext,
  ModerationModel,
  ModerationRequest,
  ModerationResponse,
  ModerationResult,
  ModerationCategory,
} from '@weaveintel/core';
import { deadlineSignal, normalizeError } from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  openaiRequest,
} from './shared.js';

// ─── Category mapping ────────────────────────────────────────

const OPENAI_CATEGORY_KEYS = [
  'hate',
  'hate/threatening',
  'harassment',
  'harassment/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;

function parseModerationResult(raw: Record<string, unknown>): ModerationResult {
  const rawCategories = raw['categories'] as Record<string, boolean>;
  const scores = raw['category_scores'] as Record<string, number>;
  const applied = raw['category_applied_input_types'] as Record<string, string[]> | undefined;

  const categories: ModerationCategory[] = OPENAI_CATEGORY_KEYS.map((key) => ({
    category: key,
    flagged: Boolean(rawCategories[key]),
    score: scores[key] ?? 0,
    appliedInputTypes: applied?.[key],
  }));

  return {
    id: String(raw['id'] ?? ''),
    model: String(raw['model'] ?? ''),
    flagged: Boolean(raw['flagged']),
    categories,
  };
}

// ─── OpenAI Moderation adapter ───────────────────────────────

export function weaveOpenAIModerationModel(
  modelId: string = 'omni-moderation-latest',
  providerOptions?: OpenAIProviderOptions,
): ModerationModel {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);

  return {
    async moderate(ctx: ExecutionContext, request: ModerationRequest): Promise<ModerationResponse> {
      const signal = deadlineSignal(ctx);
      try {
        // Build input(s)
        let input: unknown;
        if (typeof request.input === 'string') {
          input = request.input;
        } else if (Array.isArray(request.input)) {
          input = request.input.map((item) => {
            if (item.type === 'text') return { type: 'text', text: item.text };
            if (item.type === 'image_url') return { type: 'image_url', image_url: { url: item.imageUrl } };
            return item;
          });
        }

        const body: Record<string, unknown> = {
          model: request.model ?? modelId,
          input,
        };

        const raw = (await openaiRequest(baseUrl, '/moderations', body, headers, signal)) as Record<string, unknown>;
        const results = ((raw['results'] as unknown[]) ?? []).map((r) =>
          parseModerationResult(r as Record<string, unknown>),
        );

        return { results };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIModeration(modelId?: string, options?: OpenAIProviderOptions): ModerationModel {
  return weaveOpenAIModerationModel(modelId, options);
}
