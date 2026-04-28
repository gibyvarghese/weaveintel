/**
 * Google Gemini tool adapter.
 *
 * Tool format: `{ functionDeclarations: [{ name, description, parameters }] }`
 * (one wrapper object containing many declarations).
 *
 * Tool calls live in `candidates[0].content.parts[].functionCall = { name, args }`.
 * Tool results live as a `function` role message with `parts[].functionResponse = { name, response }`.
 */

import type { Message, ToolDefinition } from '@weaveintel/core';
import type { NormalisedToolCall, ProviderToolAdapter } from '../types.js';

interface GooglePart {
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

export const googleAdapter: ProviderToolAdapter = {
  provider: 'google',
  displayName: 'Google Gemini',
  systemPromptLocation: 'system_instruction',
  nameValidationRegex: '^[a-zA-Z0-9_-]{1,64}$',
  maxToolCount: 128,

  translate(tools: readonly ToolDefinition[]): unknown[] {
    if (tools.length === 0) return [];
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  },

  parseToolCall(rawResponse: unknown): readonly NormalisedToolCall[] {
    if (!rawResponse || typeof rawResponse !== 'object') return [];
    const obj = rawResponse as Record<string, unknown>;
    const candidates = obj['candidates'];
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const first = candidates[0] as Record<string, unknown>;
    const content = first['content'] as Record<string, unknown> | undefined;
    const parts = content?.['parts'];
    if (!Array.isArray(parts)) return [];
    const out: NormalisedToolCall[] = [];
    for (const p of parts as GooglePart[]) {
      const fc = p.functionCall;
      if (!fc?.name) continue;
      out.push({ id: '', name: fc.name, arguments: fc.args ?? {} });
    }
    return out;
  },

  reshapeMessage(message: Message): Message | null {
    if (message.role === 'tool') {
      // Gemini uses a 'function' role; the closest core role is 'tool'.
      // We keep core's 'tool' role but ensure name is set so the provider can map it.
      return { ...message, name: message.name ?? message.toolCallId ?? 'unknown' };
    }
    return message;
  },
};
