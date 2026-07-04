/**
 * OpenAI Chat Completions / Responses tool adapter.
 *
 * Tool format: `{ type: 'function', function: { name, description, parameters, strict? } }`.
 * Tool results: a `{ role: 'tool', tool_call_id, content }` message.
 * Assistant tool calls: `{ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments } }] }`.
 */

import type { Message, ToolDefinition } from '@weaveintel/core';
import type { NormalisedToolCall, ProviderToolAdapter } from '../types.js';

interface OpenAIToolCallShape {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export const openaiAdapter: ProviderToolAdapter = {
  provider: 'openai',
  displayName: 'OpenAI Chat Completions / Responses',
  systemPromptLocation: 'system_message',
  nameValidationRegex: '^[a-zA-Z0-9_-]{1,64}$',
  maxToolCount: 128,

  translate(tools: readonly ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict ? { strict: true } : {}),
      },
    }));
  },

  parseToolCall(rawResponse: unknown): readonly NormalisedToolCall[] {
    // Accepts either a raw OpenAI body or an already-extracted tool_calls array.
    const calls = extractOpenAIToolCalls(rawResponse);
    const out: NormalisedToolCall[] = [];
    for (const c of calls) {
      const name = c.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      const raw = c.function?.arguments;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          args = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          args = { _raw: raw };
        }
      }
      out.push({ id: c.id ?? '', name, arguments: args });
    }
    return out;
  },

  reshapeMessage(message: Message): Message | null {
    if (message.role === 'tool') {
      // Already in OpenAI shape if it has toolCallId; otherwise treat content as user-visible text.
      if (message.toolCallId) return message;
      // Synthesize a tool_call_id from name when missing — required by OpenAI.
      return { ...message, toolCallId: message.name ?? 'unknown' };
    }
    return message;
  },
};

function extractOpenAIToolCalls(raw: unknown): OpenAIToolCallShape[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  // Already an array of tool call shapes
  if (Array.isArray(raw)) return raw as OpenAIToolCallShape[];
  // Standard shape: { choices: [{ message: { tool_calls: [...] } }] }
  const choices = obj['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const msg = first?.['message'] as Record<string, unknown> | undefined;
    const tc = msg?.['tool_calls'];
    if (Array.isArray(tc)) return tc as OpenAIToolCallShape[];
  }
  // Direct tool_calls field
  const direct = obj['tool_calls'];
  if (Array.isArray(direct)) return direct as OpenAIToolCallShape[];
  return [];
}
