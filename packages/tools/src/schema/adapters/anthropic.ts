/**
 * Anthropic Messages tool adapter.
 *
 * Tool format: `{ name, description, input_schema }`.
 * Tool calls live in `content` as `{ type: 'tool_use', id, name, input }` blocks.
 * Tool results live in a `user` message as `{ type: 'tool_result', tool_use_id, content }` blocks.
 */

import type { ContentPart, Message, ToolDefinition } from '@weaveintel/core';
import type { NormalisedToolCall, ProviderToolAdapter } from '../types.js';

interface AnthropicToolUseBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export const anthropicAdapter: ProviderToolAdapter = {
  provider: 'anthropic',
  displayName: 'Anthropic Messages',
  systemPromptLocation: 'top_level_field',
  nameValidationRegex: '^[a-zA-Z0-9_-]{1,64}$',
  maxToolCount: 128,

  translate(tools: readonly ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  },

  parseToolCall(rawResponse: unknown): readonly NormalisedToolCall[] {
    const blocks = extractAnthropicContent(rawResponse);
    const out: NormalisedToolCall[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !b.name) continue;
      out.push({
        id: b.id ?? '',
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      });
    }
    return out;
  },

  reshapeMessage(message: Message): Message | null {
    // Anthropic conversation shapes:
    //  - assistant tool calls live as tool_use content blocks (we leave string content alone).
    //  - tool results are user messages with a tool_result content block.
    if (message.role === 'tool') {
      // Convert role:'tool' into a user message carrying a tool_result content block.
      const blockId = message.toolCallId ?? message.name ?? 'unknown';
      const text = typeof message.content === 'string'
        ? message.content
        : stringifyContentParts(message.content);
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[tool_result tool_use_id=${blockId}]\n${text}`,
          } satisfies ContentPart,
        ],
      };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      // Render tool calls as a textual stub appended after any existing content.
      // The provider package builds the real tool_use blocks from `toolCalls`;
      // this reshaping is for foreign-history replay only.
      const calls = message.toolCalls
        .map((c) => `[tool_use id=${c.id} name=${c.name} input=${c.arguments}]`)
        .join('\n');
      const base = typeof message.content === 'string'
        ? message.content
        : stringifyContentParts(message.content);
      return { role: 'assistant', content: [base, calls].filter(Boolean).join('\n') };
    }
    return message;
  },
};

function extractAnthropicContent(raw: unknown): AnthropicToolUseBlock[] {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) return raw as AnthropicToolUseBlock[];
  const obj = raw as Record<string, unknown>;
  const content = obj['content'];
  if (Array.isArray(content)) return content as AnthropicToolUseBlock[];
  return [];
}

function stringifyContentParts(parts: readonly ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
    .join('\n');
}
