import type { ContentPart, ModelCapabilityProfile, ModelRequest, ModelResponse, StreamChunk } from '@weaveintel/core';
import { WeaveIntelError, profileFromCapabilities, unsupportedPart } from '@weaveintel/core';
import { resolveAnthropicModelMetadata } from './anthropic-models.js';
import { anthropicAdapter, translate } from '@weaveintel/tools/schema';
import type { AnthropicContentBlock } from './anthropic-types.js';
import type { AnthropicSSEEvent } from './shared.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

const ANTHROPIC_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function mimeOf(mimeType: string | undefined, fallback: string): string {
  return (mimeType ?? fallback).split(';')[0]!.trim().toLowerCase();
}

/** Who a refusal is about, for its message. */
export interface AnthropicPartContext {
  readonly modelId?: string;
}

function imageBlock(part: { url?: string; base64?: string; mimeType?: string; type: string }, who: AnthropicPartContext): AnthropicContentBlock {
  if (part.base64) {
    const mediaType = mimeOf(part.mimeType, 'image/png');
    if (!ANTHROPIC_IMAGE_TYPES.has(mediaType)) {
      throw unsupportedPart(part as ContentPart, { provider: 'anthropic', ...who, reason: `images of type ${mediaType} are not accepted` });
    }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: part.base64 } };
  }
  if (part.url) return { type: 'image', source: { type: 'url', url: part.url } };
  throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'An image part has neither content nor a link.', provider: 'anthropic', retryable: false });
}

/**
 * Translate one content part into an Anthropic block. Every part is either
 * sent properly or refused with an `UnsupportedContentError` naming the
 * capability: nothing is replaced with placeholder text.
 *
 * - images: base64 (png, jpeg, gif, webp) or a URL;
 * - PDF files: a `document` block, base64 or URL;
 * - text files (`text/*`): a `document` block with a plain-text source;
 * - image files: an `image` block;
 * - audio and every other file type: refused (Anthropic reads neither).
 */
export function partToAnthropicBlock(part: ContentPart, who: AnthropicPartContext = {}): AnthropicContentBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return imageBlock(part, who);
    case 'file': {
      const mime = mimeOf(part.mimeType, 'application/octet-stream');
      if (mime === 'application/pdf') {
        if (part.base64) {
          return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.base64 } };
        }
        if (part.url) return { type: 'document', source: { type: 'url', url: part.url } };
        throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'A PDF part has neither content nor a link.', provider: 'anthropic', retryable: false });
      }
      if (mime.startsWith('image/')) return imageBlock(part, who);
      if (mime.startsWith('text/')) {
        if (!part.base64) {
          throw unsupportedPart(part, { provider: 'anthropic', ...who, reason: 'a text file must be sent as content, not a link' });
        }
        return {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: Buffer.from(part.base64, 'base64').toString('utf8') },
        };
      }
      throw unsupportedPart(part, { provider: 'anthropic', ...who });
    }
    case 'audio':
      throw unsupportedPart(part, { provider: 'anthropic', ...who });
    default:
      throw unsupportedPart(part, { provider: 'anthropic', ...who });
  }
}

/** What Anthropic chat models read, as a capability profile (Claude models with vision). */
export function anthropicCapabilityProfile(modelId: string): ModelCapabilityProfile {
  const meta = resolveAnthropicModelMetadata(modelId);
  return profileFromCapabilities(
    meta.capabilities,
    { maxContextTokens: meta.contextWindow, maxOutputTokens: meta.maxOutputTokens },
    { documentMimeTypes: ['text/*'], imageMimeTypes: [...ANTHROPIC_IMAGE_TYPES], acceptsUrls: true },
  );
}

export function buildAnthropicMessages(
  messages: ModelRequest['messages'],
  who: AnthropicPartContext = {},
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
        const blocks: AnthropicContentBlock[] = msg.content.map((part) => partToAnthropicBlock(part, who));
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
      const blocks: AnthropicContentBlock[] = msg.content.map((part) => partToAnthropicBlock(part, who));
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
