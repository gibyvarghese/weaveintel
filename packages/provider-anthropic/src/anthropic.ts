/**
 * @weaveintel/provider-anthropic — Anthropic Messages API adapter
 *
 * Full-featured chat model covering:
 * - Messages API (generate + stream)
 * - Tool use (function calling)
 * - Vision (image content blocks — base64 & URL)
 * - PDF support (document content blocks)
 * - Extended thinking (manual + adaptive)
 * - Prompt caching (cache_control on content blocks)
 * - Citations (document-based citations)
 * - Structured output (tool_use JSON schema trick)
 * - System messages (top-level, supports content blocks)
 *
 * Uses raw fetch — no vendor SDK dependency.
 */

import type {
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
  ExecutionContext,
  CapabilityId,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  WeaveIntelError,
  normalizeError,
  deadlineSignal,
} from '@weaveintel/core';
import { weaveRegisterModel } from '@weaveintel/models';

import type { AnthropicProviderOptions, AnthropicSSEEvent } from './shared.js';
import {
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  anthropicRequest,
  anthropicStreamRequest,
} from './shared.js';

// Re-export provider options from shared
export type { AnthropicProviderOptions } from './shared.js';

// ─── Anthropic-specific request options ──────────────────────

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
}

export type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' }
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' };

/** Anthropic content block (for system prompt, messages, etc.) */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: Record<string, unknown>;
  cache_control?: { type: 'ephemeral'; ttl?: string };
  citations?: { enabled: boolean };
  [key: string]: unknown;
}

// ─── Build Anthropic messages ────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function buildAnthropicMessages(
  messages: ModelRequest['messages'],
): { system: string | AnthropicContentBlock[] | undefined; messages: AnthropicMessage[] } {
  let system: string | AnthropicContentBlock[] | undefined;
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    // Extract system messages to top-level
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

    // Tool results map to user messages with tool_result content blocks
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
      anthropicMessages.push({ role, content: msg.content });
    } else {
      const blocks: AnthropicContentBlock[] = msg.content.map(partToAnthropicBlock);
      anthropicMessages.push({ role, content: blocks });
    }
  }

  return { system, messages: anthropicMessages };
}

function partToAnthropicBlock(part: import('@weaveintel/core').ContentPart): AnthropicContentBlock {
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

// ─── Build Anthropic tools ───────────────────────────────────

function buildAnthropicTools(
  tools: ModelRequest['tools'],
): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function buildToolChoice(
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

// ─── Capability detection ────────────────────────────────────

function determineCapabilities(modelId: string): CapabilityId[] {
  const caps: CapabilityId[] = [Capabilities.Chat, Capabilities.Streaming, Capabilities.ToolCalling];

  // All Claude models support vision
  caps.push(Capabilities.Vision, Capabilities.Multimodal);

  // All Claude 3+ models support structured output via tool use
  caps.push(Capabilities.StructuredOutput);

  // Reasoning (extended thinking) for Claude 3.5 Sonnet+, Claude 4+
  if (
    modelId.includes('claude-3') ||
    modelId.includes('claude-4') ||
    modelId.includes('claude-sonnet') ||
    modelId.includes('claude-opus') ||
    modelId.includes('claude-haiku') ||
    modelId.includes('claude-mythos')
  ) {
    caps.push(Capabilities.Reasoning);
  }

  // Computer use capability for models that support it
  if (
    modelId.includes('claude-opus') ||
    modelId.includes('claude-sonnet') ||
    modelId.includes('claude-4') ||
    modelId.includes('claude-mythos')
  ) {
    caps.push(Capabilities.ComputerUse);
  }

  return caps;
}

// ─── Model context sizes ─────────────────────────────────────

function getContextWindow(modelId: string): number {
  if (modelId.includes('mythos')) return 1_048_576; // 1M
  if (modelId.includes('opus-4-6') || modelId.includes('opus-4-5')) return 200_000;
  if (modelId.includes('sonnet-4-6') || modelId.includes('sonnet-4-5')) return 200_000;
  if (modelId.includes('claude-4') || modelId.includes('opus-4') || modelId.includes('sonnet-4')) return 200_000;
  if (modelId.includes('haiku-4')) return 200_000;
  if (modelId.includes('claude-3')) return 200_000;
  return 200_000;
}

function getMaxOutputTokens(modelId: string): number {
  if (modelId.includes('mythos')) return 128_000;
  if (modelId.includes('opus-4-6')) return 128_000;
  if (modelId.includes('sonnet-4-6')) return 64_000;
  if (modelId.includes('haiku-4-5')) return 64_000;
  if (modelId.includes('opus-4-5')) return 128_000;
  return 8_192;
}

// ─── Response parsing ────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

function parseResponse(raw: Record<string, unknown>): ModelResponse {
  const content = raw['content'] as Array<Record<string, unknown>> | undefined;
  const usage = raw['usage'] as Record<string, number> | undefined;

  // Extract text content
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
        // redacted_thinking blocks are passed through metadata
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

// ─── Stream parsing ──────────────────────────────────────────

function* parseStreamEvent(evt: AnthropicSSEEvent): Iterable<StreamChunk> {
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
          // Citations are metadata; pass as text annotation
          break;
        case 'signature_delta':
          // Thinking signature — no user-facing content
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
      if (usage && usage['input_tokens']) {
        yield {
          type: 'usage' as const,
          usage: {
            promptTokens: usage['input_tokens'] ?? 0,
            completionTokens: 0,
            totalTokens: usage['input_tokens'] ?? 0,
          },
        };
      }
      break;
    }

    case 'message_stop':
      yield { type: 'done' as const };
      break;

    // 'ping', 'content_block_stop' → no user-facing data
  }
}

// ─── Main model factory ──────────────────────────────────────

/**
 * Creates an Anthropic chat model implementing the WeaveIntel Model interface.
 *
 * Supports all Anthropic Messages API features:
 * - Chat completion with tool use
 * - Vision (images) & PDF documents
 * - Extended thinking (manual + adaptive)
 * - Prompt caching
 * - Citations
 * - Streaming
 *
 * Anthropic-specific options are passed via `ModelRequest.metadata`:
 * ```ts
 * const response = await model.generate(ctx, {
 *   messages: [{ role: 'user', content: 'Hello' }],
 *   maxTokens: 1024,
 *   metadata: {
 *     thinking: { type: 'adaptive' },
 *     citations: { enabled: true },
 *   },
 * });
 * ```
 */
export function weaveAnthropicModel(
  modelId: string,
  providerOptions?: AnthropicProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const caps = weaveCapabilities(...determineCapabilities(modelId));

  const info: ModelInfo = {
    provider: 'anthropic',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: getContextWindow(modelId),
    maxOutputTokens: getMaxOutputTokens(modelId),
  };

  return {
    info,
    ...caps,

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const apiKey = resolveApiKey(opts);
      const meta = (request.metadata ?? {}) as AnthropicRequestOptions;
      const headers = makeHeaders(opts, apiKey, meta.betaFeatures);
      const { system, messages } = buildAnthropicMessages(request.messages);

      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        max_tokens: request.maxTokens ?? 4096,
      };

      // System prompt (from messages or explicit metadata)
      const systemPrompt = meta.systemPrompt ?? system;
      if (systemPrompt) body['system'] = systemPrompt;

      // Tools
      if (request.tools) body['tools'] = buildAnthropicTools(request.tools);
      const tc = buildToolChoice(request.toolChoice);
      if (tc) body['tool_choice'] = tc;

      // Temperature, top_p, top_k, stop
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.topP != null) body['top_p'] = request.topP;
      if (meta.topK != null) body['top_k'] = meta.topK;
      if (request.stop) body['stop_sequences'] = request.stop;

      // Extended thinking
      if (meta.thinking) body['thinking'] = meta.thinking;

      // Citations
      if (meta.citations) body['citations'] = meta.citations;

      // Top-level automatic caching
      if (meta.cacheControl) body['cache_control'] = meta.cacheControl;

      // Structured output via response format
      if (request.responseFormat) {
        if (request.responseFormat.type === 'json_schema') {
          // Anthropic uses output_config.format for structured output
          body['output_config'] = {
            format: {
              type: 'json_schema',
              schema: request.responseFormat.schema,
            },
          };
        }
      }

      // Metadata (user_id for Anthropic)
      if (meta && (request.metadata as Record<string, unknown>)?.['userId']) {
        body['metadata'] = { user_id: (request.metadata as Record<string, unknown>)['userId'] };
      }

      const signal = deadlineSignal(ctx);

      try {
        const raw = (await anthropicRequest(
          baseUrl, '/v1/messages', body, headers, signal,
        )) as Record<string, unknown>;
        return parseResponse(raw);
      } catch (err) {
        throw normalizeError(err, 'anthropic');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const apiKey = resolveApiKey(opts);
      const meta = (request.metadata ?? {}) as AnthropicRequestOptions;
      const headers = makeHeaders(opts, apiKey, meta.betaFeatures);
      const { system, messages } = buildAnthropicMessages(request.messages);

      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      };

      const systemPrompt = meta.systemPrompt ?? system;
      if (systemPrompt) body['system'] = systemPrompt;
      if (request.tools) body['tools'] = buildAnthropicTools(request.tools);
      const tc = buildToolChoice(request.toolChoice);
      if (tc) body['tool_choice'] = tc;
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.topP != null) body['top_p'] = request.topP;
      if (meta.topK != null) body['top_k'] = meta.topK;
      if (request.stop) body['stop_sequences'] = request.stop;
      if (meta.thinking) body['thinking'] = meta.thinking;
      if (meta.citations) body['citations'] = meta.citations;
      if (meta.cacheControl) body['cache_control'] = meta.cacheControl;

      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        for await (const evt of anthropicStreamRequest(baseUrl, '/v1/messages', body, headers, signal)) {
          yield* parseStreamEvent(evt);
        }
      })();
    },
  };
}

// ─── Auto-register with model router ─────────────────────────

let providerOpts: AnthropicProviderOptions = {};

/** Configure global Anthropic provider options */
export function weaveAnthropicConfig(options: AnthropicProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('anthropic', (modelId, options) =>
  weaveAnthropicModel(modelId, { ...providerOpts, ...(options as AnthropicProviderOptions) }),
);

/** Convenience alias */
export function weaveAnthropic(modelId: string, options?: AnthropicProviderOptions): Model {
  return weaveAnthropicModel(modelId, { ...providerOpts, ...options });
}
