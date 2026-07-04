import type { ContentPart, ModelRequest, ModelResponse, StreamChunk } from '@weaveintel/core';
import { anthropicAdapter, translate } from '@weaveintel/tools/schema';
import type { AnthropicContentBlock } from './anthropic-types.js';
import type { AnthropicSSEEvent } from './shared.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export function partToAnthropicBlock(part: ContentPart): AnthropicContentBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      if (part.url) {
        return {
          type: 'image',
          source: { type: 'url', url: part.url },
        };
      }
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType ?? 'image/png',
          data: part.base64 ?? '',
        },
      };
    case 'file':
      if (part.mimeType === 'application/pdf') {
        if (part.url) {
          return {
            type: 'document',
            source: { type: 'url', url: part.url },
          };
        }
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.base64 ?? '',
          },
        };
      }
      return { type: 'text', text: `[file: ${part.filename ?? 'unknown'}]` };
    case 'audio':
      return { type: 'text', text: '[audio content not supported by Anthropic]' };
    default:
      return { type: 'text', text: `[${(part as { type: string }).type} content]` };
  }
}

export function buildAnthropicMessages(
  messages: ModelRequest['messages'],
): { system: string | AnthropicContentBlock[] | undefined; messages: AnthropicMessage[] } {
  let system: string | AnthropicContentBlock[] | undefined;
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        system = system
          ? (typeof system === 'string' ? system + '\n' + msg.content : msg.content)
          : msg.content;
      } else {
        const blocks: AnthropicContentBlock[] = msg.content.map(partToAnthropicBlock);
        system = blocks;
      }
      continue;
    }

    if (msg.role === 'tool' && msg.toolCallId) {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    if (typeof msg.content === 'string') {
      if (role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments || '{}'),
          });
        }
        anthropicMessages.push({ role, content: blocks });
      } else {
        anthropicMessages.push({ role, content: msg.content });
      }
    } else {
      const blocks: AnthropicContentBlock[] = msg.content.map(partToAnthropicBlock);
      if (role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments || '{}'),
          });
        }
      }
      anthropicMessages.push({ role, content: blocks });
    }
  }

  return { system, messages: anthropicMessages };
}

export function buildAnthropicTools(
  tools: ModelRequest['tools'],
): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return translate(tools, anthropicAdapter);
}

/**
 * Apply an `cache_control: ephemeral` breakpoint to the system prompt so that
 * the stable prefix (tools + system, in Anthropic render order) is cached.
 *
 * Converts a string system prompt into a single content block carrying
 * `cache_control`; for an existing block array, marks the LAST block. Returns
 * the system unchanged when it is empty. Anthropic ignores a top-level
 * `cache_control`, so the marker must live on a content block — this is the
 * correct, effective placement.
 */
export function applySystemCacheControl(
  system: string | AnthropicContentBlock[] | undefined,
  ttl: '5m' | '1h' = '5m',
): string | AnthropicContentBlock[] | undefined {
  const cacheControl: AnthropicContentBlock['cache_control'] =
    ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  if (system === undefined) return undefined;
  if (typeof system === 'string') {
    if (system.length === 0) return system;
    return [{ type: 'text', text: system, cache_control: cacheControl }];
  }
  if (system.length === 0) return system;
  const blocks = system.map((b) => ({ ...b }));
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache_control: cacheControl };
  return blocks;
}

export function buildToolChoice(
  toolChoice: ModelRequest['toolChoice'],
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto': return { type: 'auto' };
      case 'none': return { type: 'none' };
      case 'required': return { type: 'any' };
      default: return { type: 'auto' };
    }
  }
  return { type: 'tool', name: toolChoice.name };
}

export function mapStopReason(reason: string | null | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

export function parseResponse(raw: Record<string, unknown>): ModelResponse {
  const content = raw['content'] as Array<Record<string, unknown>> | undefined;
  const usage = raw['usage'] as Record<string, number> | undefined;

  let textContent = '';
  let reasoning = '';
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  if (content) {
    for (const block of content) {
      switch (block['type']) {
        case 'text':
          textContent += String(block['text'] ?? '');
          break;
        case 'thinking':
          reasoning += String(block['thinking'] ?? '');
          break;
        case 'tool_use':
          toolCalls.push({
            id: String(block['id']),
            name: String(block['name']),
            arguments: JSON.stringify(block['input'] ?? {}),
          });
          break;
      }
    }
  }

  const cacheCreation = usage?.['cache_creation_input_tokens'] ?? 0;
  const cacheRead = usage?.['cache_read_input_tokens'] ?? 0;
  const inputTokens = (usage?.['input_tokens'] ?? 0) + cacheCreation + cacheRead;

  return {
    id: String(raw['id'] ?? ''),
    content: textContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: mapStopReason(raw['stop_reason'] as string | null | undefined),
    usage: {
      promptTokens: inputTokens,
      completionTokens: usage?.['output_tokens'] ?? 0,
      totalTokens: inputTokens + (usage?.['output_tokens'] ?? 0),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheCreation,
    },
    model: String(raw['model'] ?? ''),
    reasoning: reasoning || undefined,
    metadata: {
      stopSequence: raw['stop_sequence'],
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      rawContent: content,
    },
  };
}

export function* parseStreamEvent(evt: AnthropicSSEEvent): Iterable<StreamChunk> {
  const data = evt.data as Record<string, unknown>;
  const type = data['type'] as string;

  switch (type) {
    case 'content_block_start': {
      const block = data['content_block'] as Record<string, unknown>;
      if (block['type'] === 'text' && block['text']) {
        yield { type: 'text' as const, text: String(block['text']) };
      }
      if (block['type'] === 'tool_use') {
        yield {
          type: 'tool_call' as const,
          toolCall: {
            id: String(block['id']),
            name: String(block['name']),
            arguments: '',
          },
        };
      }
      break;
    }

    case 'content_block_delta': {
      const delta = data['delta'] as Record<string, unknown>;
      const deltaType = delta['type'] as string;

      switch (deltaType) {
        case 'text_delta':
          yield { type: 'text' as const, text: String(delta['text']) };
          break;
        case 'thinking_delta':
          yield { type: 'reasoning' as const, reasoning: String(delta['thinking']) };
          break;
        case 'input_json_delta':
          yield {
            type: 'tool_call' as const,
            toolCall: { arguments: String(delta['partial_json']) },
          };
          break;
        case 'citations_delta':
          break;
        case 'signature_delta':
          break;
      }
      break;
    }

    case 'message_delta': {
      const delta = data['delta'] as Record<string, unknown>;
      const usage = data['usage'] as Record<string, number> | undefined;
      if (usage) {
        yield {
          type: 'usage' as const,
          usage: {
            promptTokens: 0,
            completionTokens: usage['output_tokens'] ?? 0,
            totalTokens: usage['output_tokens'] ?? 0,
          },
        };
      }
      if (delta['stop_reason']) {
        yield { type: 'done' as const };
      }
      break;
    }

    case 'message_start': {
      const message = data['message'] as Record<string, unknown> | undefined;
      const usage = (message?.['usage'] ?? data['usage']) as Record<string, number> | undefined;
      if (usage && (usage['input_tokens'] || usage['cache_read_input_tokens'] || usage['cache_creation_input_tokens'])) {
        const cacheRead = usage['cache_read_input_tokens'] ?? 0;
        const cacheCreation = usage['cache_creation_input_tokens'] ?? 0;
        const inputTokens = (usage['input_tokens'] ?? 0) + cacheRead + cacheCreation;
        yield {
          type: 'usage' as const,
          usage: {
            promptTokens: inputTokens,
            completionTokens: 0,
            totalTokens: inputTokens,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation,
          },
        };
      }
      break;
    }

    case 'message_stop':
      yield { type: 'done' as const };
      break;
  }
}
