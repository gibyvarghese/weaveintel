import type { AnthropicComputerUseTool } from './anthropic-computer-use.js';

/** Anthropic content block (for system prompt, messages, etc.) */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: Record<string, unknown>;
  cache_control?: { type: 'ephemeral'; ttl?: string };
  citations?: { enabled: boolean };
  [key: string]: unknown;
}

export type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' }
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' };

/**
 * Anthropic-specific request options passed via ModelRequest.metadata.
 *
 * @example
 * ```ts
 * const response = await model.generate(ctx, {
 *   messages: [...],
 *   metadata: {
 *     thinking: { type: 'enabled', budget_tokens: 10000 },
 *     citations: { enabled: true },
 *     cacheControl: { type: 'ephemeral' },
 *     topK: 40,
 *   } satisfies AnthropicRequestOptions,
 * });
 * ```
 */
export interface AnthropicRequestOptions {
  /** Extended thinking configuration */
  thinking?: AnthropicThinkingConfig;
  /** Enable citations on documents */
  citations?: { enabled: boolean };
  /** Top-level automatic caching */
  cacheControl?: { type: 'ephemeral'; ttl?: string };
  /** Anthropic-specific top_k parameter */
  topK?: number;
  /** Additional beta features for this request */
  betaFeatures?: string[];
  /** System prompt (string or content blocks with cache_control) */
  systemPrompt?: string | AnthropicContentBlock[];
  /**
   * Anthropic Computer Use tools (computer_20241022, bash_20241022,
   * str_replace_editor_20241022). When set, these are merged into the
   * Anthropic API `tools` array alongside any standard function-calling
   * tools, and the `computer-use-2024-10-22` beta header is added
   * automatically.
   */
  computerUseTools?: AnthropicComputerUseTool[];
}
