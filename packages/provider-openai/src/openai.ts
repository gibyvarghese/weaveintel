/**
 * @weaveintel/provider-openai — OpenAI chat model adapter
 *
 * Why this is a separate package: Core must not depend on any vendor.
 * This package imports core contracts and implements them for OpenAI's API.
 * It uses the raw fetch API — no vendor SDK dependency — to keep the
 * dependency tree minimal and auditable.
 */

import type {
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
  ExecutionContext,
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
  CapabilityId,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  WeaveIntelError,
  normalizeError,
  deadlineSignal,
} from '@weaveintel/core';
import { weaveRegisterModel, weaveRegisterEmbedding } from '@weaveintel/models';

// ─── Configuration ───────────────────────────────────────────

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30_000;

function resolveApiKey(options?: OpenAIProviderOptions): string {
  const key = options?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!key) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: 'OpenAI API key not provided. Set OPENAI_API_KEY or pass apiKey option.',
      provider: 'openai',
    });
  }
  return key;
}

function makeHeaders(options: OpenAIProviderOptions, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...options.defaultHeaders,
  };
  if (options.organization) {
    headers['OpenAI-Organization'] = options.organization;
  }
  return headers;
}

function parseRetryAfterMs(retryAfterHeader: string | null | undefined, fallbackMs = 60_000): number {
  if (!retryAfterHeader) return fallbackMs;
  const asNumber = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asNumber * 1000));
  }
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asDate - Date.now()));
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, fallbackMs));
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

// ─── HTTP helpers ────────────────────────────────────────────

async function openaiRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(errorBody) as Record<string, unknown>;
    } catch {
      // not JSON
    }

    const errorMessage =
      (parsed['error'] as Record<string, unknown> | undefined)?.['message'] ??
      errorBody ??
      `HTTP ${res.status}`;

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `OpenAI rate limited: ${String(errorMessage)}`,
        provider: 'openai',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(retryAfter),
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `OpenAI auth failed: ${String(errorMessage)}`,
        provider: 'openai',
      });
    }
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `OpenAI error (${res.status}): ${String(errorMessage)}`,
      provider: 'openai',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  return res.json();
}

async function* openaiStreamRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(errorBody) as Record<string, unknown>;
    } catch {
      // non-json payload
    }
    const errorMessage =
      (parsed['error'] as Record<string, unknown> | undefined)?.['message'] ??
      errorBody ??
      `HTTP ${res.status}`;

    if (res.status === 429) {
      throw new WeaveIntelError({
        code: 'RATE_LIMITED',
        message: `OpenAI stream rate limited: ${String(errorMessage)}`,
        provider: 'openai',
        retryable: true,
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new WeaveIntelError({
        code: 'AUTH_FAILED',
        message: `OpenAI stream auth failed: ${String(errorMessage)}`,
        provider: 'openai',
      });
    }

    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `OpenAI stream error (${res.status}): ${String(errorMessage)}`,
      provider: 'openai',
      retryable: res.status >= 500,
      details: parsed,
    });
  }

  const reader = res.body?.getReader();
  if (!reader) throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'No response body', provider: 'openai' });

  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];

  const flushEvent = (): { event: string; data: string } | undefined => {
    if (dataLines.length === 0) {
      eventType = '';
      return undefined;
    }
    const event = { event: eventType, data: dataLines.join('\n') };
    eventType = '';
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          const event = flushEvent();
          if (!event) continue;
          const data = event.data.trim();
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data);
          } catch {
            // skip malformed chunks
          }
          continue;
        }

        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('event:')) {
          eventType = line.slice(6).trimStart();
          continue;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    // Flush trailing event when stream ends without an extra blank line.
    const trailing = flushEvent();
    if (trailing) {
      const data = trailing.data.trim();
      if (data !== '[DONE]') {
        try {
          yield JSON.parse(data);
        } catch {
          // skip malformed trailing chunk
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors on already closed streams.
    }
    reader.releaseLock();
  }
}

// ─── Chat model ──────────────────────────────────────────────

function buildOpenAIMessages(messages: ModelRequest['messages']): unknown[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      const m: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.name) m['name'] = msg.name;
      if (msg.toolCallId) m['tool_call_id'] = msg.toolCallId;
      if (msg.toolCalls?.length) {
        m['tool_calls'] = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return m;
    }
    // Multimodal content parts
    const parts = msg.content.map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image':
          return {
            type: 'image_url',
            image_url: { url: part.url ?? `data:${part.mimeType ?? 'image/png'};base64,${part.base64}` },
          };
        default:
          return { type: 'text', text: `[${part.type} content]` };
      }
    });
    return { role: msg.role, content: parts };
  });
}

function buildOpenAITools(tools: ModelRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.strict ? { strict: true } : {}),
    },
  }));
}

interface OpenAIModelMetadata {
  pattern: RegExp;
  capabilities: CapabilityId[];
  maxContextTokens: number;
}

const OPENAI_MODEL_METADATA: OpenAIModelMetadata[] = [
  {
    pattern: /^gpt-4o/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
      Capabilities.Vision,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 128_000,
  },
  {
    pattern: /^gpt-4(?:$|-)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
    ],
    maxContextTokens: 128_000,
  },
  {
    pattern: /^gpt-3\.5/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
    ],
    maxContextTokens: 16_385,
  },
  {
    pattern: /^o[134](?:$|-)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.Reasoning,
    ],
    maxContextTokens: 128_000,
  },
];

const OPENAI_DEFAULT_METADATA: OpenAIModelMetadata = {
  // Unknown model variants fail conservatively on capability claims.
  pattern: /.*/,
  capabilities: [Capabilities.Chat, Capabilities.Streaming],
  maxContextTokens: 16_385,
};

function resolveOpenAIModelMetadata(modelId: string): OpenAIModelMetadata {
  return OPENAI_MODEL_METADATA.find(m => m.pattern.test(modelId)) ?? OPENAI_DEFAULT_METADATA;
}

function determineCapabilities(modelId: string): CapabilityId[] {
  return [...resolveOpenAIModelMetadata(modelId).capabilities];
}

export function weaveOpenAIModel(
  modelId: string,
  providerOptions?: OpenAIProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);
  const caps = weaveCapabilities(...determineCapabilities(modelId));

  const info: ModelInfo = {
    provider: 'openai',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: resolveOpenAIModelMetadata(modelId).maxContextTokens,
  };

  return {
    info,
    ...caps,

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const body: Record<string, unknown> = {
        model: modelId,
        messages: buildOpenAIMessages(request.messages),
      };
      if (request.tools) body['tools'] = buildOpenAITools(request.tools);
      if (request.toolChoice) {
        body['tool_choice'] =
          typeof request.toolChoice === 'string'
            ? request.toolChoice
            : { type: 'function', function: { name: request.toolChoice.name } };
      }
      if (request.responseFormat) {
        if (request.responseFormat.type === 'json_schema') {
          body['response_format'] = {
            type: 'json_schema',
            json_schema: {
              name: request.responseFormat.name ?? 'response',
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict,
            },
          };
        } else {
          body['response_format'] = { type: request.responseFormat.type };
        }
      }
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.maxTokens != null) body['max_tokens'] = request.maxTokens;
      if (request.topP != null) body['top_p'] = request.topP;
      if (request.stop) body['stop'] = request.stop;

      const signal = deadlineSignal(ctx);

      try {
        const raw = (await openaiRequest(baseUrl, '/chat/completions', body, headers, signal)) as Record<string, unknown>;
        const choices = raw['choices'] as Array<Record<string, unknown>>;
        const choice = choices?.[0];
        const message = choice?.['message'] as Record<string, unknown> | undefined;
        const usage = raw['usage'] as Record<string, number> | undefined;

        const toolCalls = (message?.['tool_calls'] as Array<Record<string, unknown>> | undefined)?.map((tc) => ({
          id: String(tc['id']),
          name: String((tc['function'] as Record<string, unknown>)['name']),
          arguments: String((tc['function'] as Record<string, unknown>)['arguments']),
        }));

        return {
          id: String(raw['id']),
          content: String(message?.['content'] ?? ''),
          toolCalls,
          finishReason: mapFinishReason(String(choice?.['finish_reason'] ?? 'stop')),
          usage: {
            promptTokens: usage?.['prompt_tokens'] ?? 0,
            completionTokens: usage?.['completion_tokens'] ?? 0,
            totalTokens: usage?.['total_tokens'] ?? 0,
          },
          model: String(raw['model']),
        };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const body: Record<string, unknown> = {
        model: modelId,
        messages: buildOpenAIMessages(request.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (request.tools) body['tools'] = buildOpenAITools(request.tools);
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.maxTokens != null) body['max_tokens'] = request.maxTokens;

      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        for await (const chunk of openaiStreamRequest(baseUrl, '/chat/completions', body, headers, signal)) {
          const c = chunk as Record<string, unknown>;
          const choices = c['choices'] as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
          const usage = c['usage'] as Record<string, number> | undefined;

          if (delta?.['content']) {
            yield { type: 'text' as const, text: String(delta['content']) };
          }
          if (delta?.['tool_calls']) {
            const tcs = delta['tool_calls'] as Array<Record<string, unknown>>;
            for (const tc of tcs) {
              const fn = tc['function'] as Record<string, unknown> | undefined;
              yield {
                type: 'tool_call' as const,
                toolCall: {
                  id: tc['id'] as string | undefined,
                  name: fn?.['name'] as string | undefined,
                  arguments: fn?.['arguments'] as string | undefined,
                },
              };
            }
          }
          if (usage) {
            yield {
              type: 'usage' as const,
              usage: {
                promptTokens: usage['prompt_tokens'] ?? 0,
                completionTokens: usage['completion_tokens'] ?? 0,
                totalTokens: usage['total_tokens'] ?? 0,
              },
            };
          }
          if (choices?.[0]?.['finish_reason']) {
            yield { type: 'done' as const };
          }
        }
      })();
    },
  };
}

// ─── OpenAI Embedding model ──────────────────────────────────

export function weaveOpenAIEmbeddingModel(
  modelId: string = 'text-embedding-3-small',
  providerOptions?: OpenAIProviderOptions,
): EmbeddingModel {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);
  const caps = weaveCapabilities(Capabilities.Embedding);

  return {
    info: {
      provider: 'openai',
      modelId,
      capabilities: caps.capabilities,
    },
    ...caps,

    async embed(ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const body: Record<string, unknown> = {
        model: modelId,
        input: request.input,
      };
      if (request.dimensions) body['dimensions'] = request.dimensions;

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/embeddings', body, headers, signal)) as Record<string, unknown>;
        const data = raw['data'] as Array<Record<string, unknown>>;
        const usage = raw['usage'] as Record<string, number> | undefined;

        return {
          embeddings: data.map((d) => d['embedding'] as number[]),
          model: String(raw['model']),
          usage: { totalTokens: usage?.['total_tokens'] ?? 0 },
        };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

// ─── Helper ──────────────────────────────────────────────────

function mapFinishReason(reason: string): ModelResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// ─── Auto-register ───────────────────────────────────────────

let providerOpts: OpenAIProviderOptions = {};

export function weaveOpenAIConfig(options: OpenAIProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('openai', (modelId, options) =>
  weaveOpenAIModel(modelId, { ...providerOpts, ...(options as OpenAIProviderOptions) }),
);

weaveRegisterEmbedding('openai', (modelId, options) =>
  weaveOpenAIEmbeddingModel(modelId, { ...providerOpts, ...(options as OpenAIProviderOptions) }),
);

/** Convenience function matching the ergonomic API */
export function weaveOpenAI(modelId: string, options?: OpenAIProviderOptions): Model {
  return weaveOpenAIModel(modelId, { ...providerOpts, ...options });
}

export function weaveOpenAIEmbedding(
  modelId?: string,
  options?: OpenAIProviderOptions,
): EmbeddingModel {
  return weaveOpenAIEmbeddingModel(modelId, { ...providerOpts, ...options });
}
