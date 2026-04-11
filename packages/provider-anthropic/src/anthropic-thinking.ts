/**
 * @weaveintel/provider-anthropic — Extended thinking helpers
 *
 * Provides high-level helpers for working with Anthropic's extended thinking:
 * - Manual mode (budget_tokens)
 * - Adaptive mode (recommended for Claude 4.6+)
 * - Display control (summarized / omitted)
 * - Thinking block extraction from responses
 * - Multi-turn thinking block preservation
 */

import type {
  Model,
  ModelRequest,
  ModelResponse,
  ExecutionContext,
} from '@weaveintel/core';
import type { AnthropicRequestOptions, AnthropicThinkingConfig } from './anthropic.js';

// ─── Thinking block types ────────────────────────────────────

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ThinkingContentBlock = ThinkingBlock | RedactedThinkingBlock;

// ─── Thinking config presets ─────────────────────────────────

/** Manual thinking with explicit budget (Claude 3.7, Claude 4) */
export function manualThinking(
  budgetTokens: number,
  display?: 'summarized' | 'omitted',
): AnthropicThinkingConfig {
  return { type: 'enabled', budget_tokens: budgetTokens, display };
}

/** Adaptive thinking (recommended for Claude 4.6+) */
export function adaptiveThinking(
  display?: 'summarized' | 'omitted',
): AnthropicThinkingConfig {
  return { type: 'adaptive', display };
}

/** Disable thinking */
export function disableThinking(): AnthropicThinkingConfig {
  return { type: 'disabled' };
}

// ─── Thinking extraction ─────────────────────────────────────

/**
 * Extract thinking blocks from an Anthropic response.
 * The raw content blocks are stored in `response.metadata.rawContent`.
 */
export function extractThinkingBlocks(response: ModelResponse): ThinkingContentBlock[] {
  const rawContent = (response.metadata?.['rawContent'] as Array<Record<string, unknown>>) ?? [];
  const blocks: ThinkingContentBlock[] = [];

  for (const block of rawContent) {
    if (block['type'] === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: String(block['thinking'] ?? ''),
        signature: String(block['signature'] ?? ''),
      });
    }
    if (block['type'] === 'redacted_thinking') {
      blocks.push({
        type: 'redacted_thinking',
        data: String(block['data'] ?? ''),
      });
    }
  }

  return blocks;
}

/**
 * Get all raw content blocks from response including tool_use for multi-turn.
 * These must be passed back unchanged when continuing tool use conversations.
 */
export function extractRawContentBlocks(response: ModelResponse): Array<Record<string, unknown>> {
  return (response.metadata?.['rawContent'] as Array<Record<string, unknown>>) ?? [];
}

// ─── High-level thinking wrapper ─────────────────────────────

/**
 * Wraps a generate call with extended thinking enabled.
 *
 * @example
 * ```ts
 * const result = await generateWithThinking(
 *   model, ctx, request,
 *   manualThinking(10000)
 * );
 * console.log('Reasoning:', result.reasoning);
 * console.log('Thinking blocks:', result.thinkingBlocks);
 * ```
 */
export async function generateWithThinking(
  model: Model,
  ctx: ExecutionContext,
  request: ModelRequest,
  thinkingConfig: AnthropicThinkingConfig,
): Promise<ModelResponse & { thinkingBlocks: ThinkingContentBlock[] }> {
  const meta: AnthropicRequestOptions = {
    ...(request.metadata as AnthropicRequestOptions | undefined),
    thinking: thinkingConfig,
  };

  const updatedRequest: ModelRequest = {
    ...request,
    metadata: meta as unknown as Record<string, unknown>,
  };

  const response = await model.generate(ctx, updatedRequest);
  const thinkingBlocks = extractThinkingBlocks(response);

  return { ...response, thinkingBlocks };
}
