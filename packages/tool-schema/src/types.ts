/**
 * @weaveintel/tool-schema — core types
 *
 * A `ProviderToolAdapter` is a small object describing how to translate a
 * canonical {@link ToolSchema} into a provider-specific tool definition,
 * how to parse tool calls back from the provider response, and how to
 * shape conversation messages so that prior tool calls / results survive
 * a mid-conversation provider switch.
 *
 * Adapters are pure data + pure functions — no classes, no provider SDKs.
 * This keeps them safely DB-driven (`provider_tool_adapters` table).
 */

import type { Message, ToolCall, ToolDefinition } from '@weaveintel/core';

/** A normalised tool call — provider-agnostic. */
export interface NormalisedToolCall {
  /** Provider-specific id (OpenAI: call_…, Anthropic: toolu_…). May be empty for Google. */
  readonly id: string;
  readonly name: string;
  /** JSON-decoded arguments object. */
  readonly arguments: Record<string, unknown>;
}

/**
 * Where the provider expects the system prompt to live in the request body.
 * - `system_message`: a `{ role: 'system', content }` entry in `messages` (OpenAI).
 * - `top_level_field`: a top-level `system` field (Anthropic).
 * - `system_instruction`: a top-level `system_instruction` field (Google).
 */
export type SystemPromptLocation =
  | 'system_message'
  | 'top_level_field'
  | 'system_instruction';

export interface ProviderToolAdapter {
  /** Provider key — must match `provider_tool_adapters.provider`. */
  readonly provider: string;
  readonly displayName: string;
  /** Where the system prompt belongs. */
  readonly systemPromptLocation: SystemPromptLocation;
  /** Regex (string form) used to validate tool names. */
  readonly nameValidationRegex: string;
  readonly maxToolCount: number;

  /** Translate canonical tool definitions → provider-specific tool array. */
  translate(tools: readonly ToolDefinition[]): unknown[];

  /** Parse a raw provider response body → normalised tool calls. */
  parseToolCall(rawResponse: unknown): readonly NormalisedToolCall[];

  /**
   * Reshape a single conversation message so it conforms to this provider's
   * tool-call / tool-result conventions. Used by
   * {@link translateConversationHistory}.
   *
   * Should return `null` to drop the message (e.g. an empty assistant turn
   * after stripping a provider-specific block that has no equivalent).
   */
  reshapeMessage(message: Message): Message | null;
}

export interface ValidationIssue {
  readonly toolName: string;
  readonly code: 'name_invalid' | 'too_many_tools';
  readonly message: string;
}
