/**
 * @weaveintel/provider-anthropic — Token Counting API
 *
 * Count the number of tokens in a message request before sending,
 * useful for cost estimation, context window management, and
 * prompt optimization.
 *
 * Endpoint: POST /v1/messages/count_tokens
 */

import type { AnthropicProviderOptions } from './shared.js';
import { DEFAULT_BASE_URL, resolveApiKey, makeHeaders, anthropicRequest } from './shared.js';

// ─── Types ───────────────────────────────────────────────────

export interface TokenCountRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }>;
  system?: string | Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
}

export interface TokenCountResponse {
  input_tokens: number;
}

// ─── API function ────────────────────────────────────────────

/**
 * Count the number of input tokens for a message request.
 *
 * This calls the Anthropic token counting endpoint which counts
 * tokens exactly as the model would count them, accounting for
 * the model's specific tokenizer and any system prompts or tools.
 *
 * @example
 * ```ts
 * const count = await weaveAnthropicCountTokens({
 *   model: 'claude-sonnet-4-20250514',
 *   messages: [
 *     { role: 'user', content: 'What is the meaning of life?' },
 *   ],
 *   system: 'You are a helpful assistant.',
 * });
 * console.log(`Input tokens: ${count.input_tokens}`);
 * ```
 */
export async function weaveAnthropicCountTokens(
  request: TokenCountRequest,
  options?: AnthropicProviderOptions,
): Promise<TokenCountResponse> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);

  // The token counting endpoint requires the beta header
  headers['anthropic-beta'] = headers['anthropic-beta']
    ? `${headers['anthropic-beta']},token-counting-2024-11-01`
    : 'token-counting-2024-11-01';

  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  return anthropicRequest(
    baseUrl, '/v1/messages/count_tokens', request, headers,
  ) as Promise<TokenCountResponse>;
}
