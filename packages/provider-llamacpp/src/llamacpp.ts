/**
 * @weaveintel/provider-llamacpp — llama.cpp HTTP server adapter
 *
 * Targets the `llama-server` (and llamafile) HTTP server that ships with
 * llama.cpp. The server exposes OpenAI-compatible endpoints under `/v1`,
 * which we use directly: `/v1/chat/completions` (with SSE streaming) and
 * `/v1/embeddings`.
 *
 * Default base URL: http://localhost:8080  (overridable via LLAMACPP_BASE_URL).
 *
 * Capabilities are GGUF-dependent. Operators can override per-instance via
 * `capabilities` and `maxContextTokens` in `LlamaCppProviderOptions`. The
 * default assumes Chat + Streaming + ToolCalling for modern instruct models.
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
  ContentPart,
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  WeaveIntelError,
  normalizeError,
  deadlineSignal,
} from '@weaveintel/core';
import { weaveRegisterModel, weaveRegisterEmbedding } from '@weaveintel/models';
import { openaiAdapter, translate } from '@weaveintel/tool-schema';

// ─── Configuration ───────────────────────────────────────────

export interface LlamaCppProviderOptions {
  /** Base URL of the llama-server. Default: http://localhost:8080 */
  baseUrl?: string;
  /** Optional API key if the server was started with `--api-key`. */
  apiKey?: string;
  /** Override capability set (default: chat + streaming + tool calling). */
  capabilities?: CapabilityId[];
  /** Override max context window (default: 8192). */
  maxContextTokens?: number;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

const DEFAULT_CAPABILITIES: CapabilityId[] = [
  Capabilities.Chat,
  Capabilities.Streaming,
  Capabilities.ToolCalling,
  Capabilities.StructuredOutput,
];

function resolveBaseUrl(options?: LlamaCppProviderOptions): string {
  return (options?.baseUrl ?? process.env['LLAMACPP_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function makeHeaders(options: LlamaCppProviderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
  };
  const apiKey = options.apiKey ?? process.env['LLAMACPP_API_KEY'];
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

async function llamaCppErrorFromResponse(res: Response): Promise<WeaveIntelError> {
  const errorBody = await res.text().catch(() => '');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(errorBody) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const errorObj = parsed['error'] as Record<string, unknown> | string | undefined;
  const errorMessage =
    (typeof errorObj === 'object' ? errorObj?.['message'] : errorObj) ??
    errorBody ??
    `HTTP ${res.status}`;

  if (res.status === 401 || res.status === 403) {
    return new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: `llama.cpp auth failed: ${String(errorMessage)}. Did you start llama-server with --api-key?`,
      provider: 'llamacpp',
    });
  }
  return new WeaveIntelError({
    code: 'PROVIDER_ERROR',
    message: `llama.cpp error (${res.status}): ${String(errorMessage)}`,
    provider: 'llamacpp',
    retryable: res.status >= 500,
    details: parsed,
  });
}

// ─── Message construction (OpenAI-compatible) ───────────────

function buildChatMessages(messages: ModelRequest['messages']): unknown[] {
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
    const parts = msg.content.map((part: ContentPart) => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'image':
          return {
            type: 'image_url',
            image_url: {
              url: part.url ?? `data:${part.mimeType ?? 'image/png'};base64,${part.base64}`,
            },
          };
        default:
          return { type: 'text', text: `[${part.type} content]` };
      }
    });
    return { role: msg.role, content: parts };
  });
}

function buildTools(tools: ModelRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return translate(tools, openaiAdapter);
}

// ─── SSE streaming (OpenAI-compatible) ───────────────────────

async function* sseStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });
  if (!res.ok) throw await llamaCppErrorFromResponse(res);

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: 'No response body',
      provider: 'llamacpp',
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): Record<string, unknown> | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return undefined;
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return undefined;
    }
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
          const evt = flush();
          if (evt) yield evt;
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function mapFinishReason(reason: string | undefined): ModelResponse['finishReason'] {
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

// ─── Model factory ───────────────────────────────────────────

export function weaveLlamaCppModel(
  modelId: string = 'local',
  providerOptions?: LlamaCppProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const baseUrl = resolveBaseUrl(opts);
  const capabilityIds = opts.capabilities ?? DEFAULT_CAPABILITIES;
  const caps = weaveCapabilities(...capabilityIds);

  const info: ModelInfo = {
    provider: 'llamacpp',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: opts.maxContextTokens ?? 8_192,
  };

  function buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: buildChatMessages(request.messages),
      stream,
    };
    if (stream) body['stream_options'] = { include_usage: true };

    const tools = buildTools(request.tools);
    if (tools) body['tools'] = tools;
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
    return body;
  }

  return {
    info,
    ...caps,

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const headers = makeHeaders(opts);
      const body = buildBody(request, false);
      const signal = deadlineSignal(ctx);

      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: composeRequestSignal(signal),
        });
        if (!res.ok) throw await llamaCppErrorFromResponse(res);
        const raw = (await res.json()) as Record<string, unknown>;

        const choices = raw['choices'] as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const message = choice?.['message'] as Record<string, unknown> | undefined;
        const usage = raw['usage'] as Record<string, number> | undefined;

        const toolCalls = (message?.['tool_calls'] as Array<Record<string, unknown>> | undefined)?.map(
          (tc) => ({
            id: String(tc['id'] ?? ''),
            name: String((tc['function'] as Record<string, unknown>)['name']),
            arguments: String((tc['function'] as Record<string, unknown>)['arguments']),
          }),
        );

        return {
          id: String(raw['id'] ?? ''),
          content: String(message?.['content'] ?? ''),
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: mapFinishReason(choice?.['finish_reason'] as string | undefined),
          usage: {
            promptTokens: usage?.['prompt_tokens'] ?? 0,
            completionTokens: usage?.['completion_tokens'] ?? 0,
            totalTokens: usage?.['total_tokens'] ?? 0,
          },
          model: String(raw['model'] ?? modelId),
        };
      } catch (err) {
        throw normalizeError(err, 'llamacpp');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const headers = makeHeaders(opts);
      const body = buildBody(request, true);
      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        for await (const chunk of sseStream(`${baseUrl}/v1/chat/completions`, body, headers, signal)) {
          const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
          const usage = chunk['usage'] as Record<string, number> | undefined;

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

// ─── Embedding model ─────────────────────────────────────────

export function weaveLlamaCppEmbeddingModel(
  modelId: string = 'local',
  providerOptions?: LlamaCppProviderOptions,
): EmbeddingModel {
  const opts = providerOptions ?? {};
  const baseUrl = resolveBaseUrl(opts);
  const caps = weaveCapabilities(Capabilities.Embedding);

  return {
    info: {
      provider: 'llamacpp',
      modelId,
      capabilities: caps.capabilities,
    },
    ...caps,

    async embed(ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const headers = makeHeaders(opts);
      const signal = deadlineSignal(ctx);

      try {
        const res = await fetch(`${baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: modelId, input: request.input }),
          signal: composeRequestSignal(signal),
        });
        if (!res.ok) throw await llamaCppErrorFromResponse(res);
        const raw = (await res.json()) as Record<string, unknown>;
        const data = (raw['data'] as Array<Record<string, unknown>> | undefined) ?? [];
        const usage = raw['usage'] as Record<string, number> | undefined;

        return {
          embeddings: data.map((d) => d['embedding'] as number[]),
          model: String(raw['model'] ?? modelId),
          usage: { totalTokens: usage?.['total_tokens'] ?? 0 },
        };
      } catch (err) {
        throw normalizeError(err, 'llamacpp');
      }
    },
  };
}

// ─── Auto-register ───────────────────────────────────────────

let providerOpts: LlamaCppProviderOptions = {};

export function weaveLlamaCppConfig(options: LlamaCppProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('llamacpp', (modelId, options) =>
  weaveLlamaCppModel(modelId, { ...providerOpts, ...(options as LlamaCppProviderOptions) }),
);

weaveRegisterEmbedding('llamacpp', (modelId, options) =>
  weaveLlamaCppEmbeddingModel(modelId, { ...providerOpts, ...(options as LlamaCppProviderOptions) }),
);

export function weaveLlamaCpp(modelId?: string, options?: LlamaCppProviderOptions): Model {
  return weaveLlamaCppModel(modelId, { ...providerOpts, ...options });
}

export function weaveLlamaCppEmbedding(
  modelId?: string,
  options?: LlamaCppProviderOptions,
): EmbeddingModel {
  return weaveLlamaCppEmbeddingModel(modelId, { ...providerOpts, ...options });
}
