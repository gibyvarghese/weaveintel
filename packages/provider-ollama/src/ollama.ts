/**
 * @weaveintel/provider-ollama — Ollama local LLM adapter
 *
 * Talks to a local (or remote) Ollama server via its native `/api/chat`
 * endpoint. NDJSON streaming. No API key required by default.
 *
 * Default base URL: http://localhost:11434  (overridable via OLLAMA_BASE_URL).
 *
 * Capability detection inspects the model id (e.g. `llama3.1`, `qwen2.5`,
 * `deepseek-r1`, `llava`) and assigns a conservative capability set. Operators
 * may override per-instance by passing `capabilities` in `OllamaProviderOptions`.
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

export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Default: http://localhost:11434 */
  baseUrl?: string;
  /** Optional bearer token for token-gated proxies. Ollama itself is unauthenticated. */
  apiKey?: string;
  /** Override the auto-detected capability set for the model. */
  capabilities?: CapabilityId[];
  /** Override max context window (defaults to family-detected value). */
  maxContextTokens?: number;
  defaultHeaders?: Record<string, string>;
  /** Extra Ollama-specific options merged into request `options`. */
  options?: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000; // local generation can be slow

function resolveBaseUrl(options?: OllamaProviderOptions): string {
  return (options?.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function makeHeaders(options: OllamaProviderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
  };
  const apiKey = options.apiKey ?? process.env['OLLAMA_API_KEY'];
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

async function ollamaErrorFromResponse(res: Response): Promise<WeaveIntelError> {
  const errorBody = await res.text().catch(() => '');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(errorBody) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const errorMessage = parsed['error'] ?? errorBody ?? `HTTP ${res.status}`;

  if (res.status === 404) {
    return new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `Ollama model not found (404): ${String(errorMessage)}. Did you run \`ollama pull <model>\`?`,
      provider: 'ollama',
      details: parsed,
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: `Ollama auth failed: ${String(errorMessage)}`,
      provider: 'ollama',
    });
  }
  return new WeaveIntelError({
    code: 'PROVIDER_ERROR',
    message: `Ollama error (${res.status}): ${String(errorMessage)}`,
    provider: 'ollama',
    retryable: res.status >= 500,
    details: parsed,
  });
}

// ─── Message construction ────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

function partToOllama(part: ContentPart): { text?: string; image?: string } {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      // Ollama expects raw base64 (no data: prefix). URLs are not natively supported.
      if (part.base64) return { image: part.base64 };
      return { text: `[image url: ${part.url ?? 'unknown'}]` };
    default:
      return { text: `[${part.type} content]` };
  }
}

function buildOllamaMessages(messages: ModelRequest['messages']): OllamaMessage[] {
  return messages.map((msg) => {
    const out: OllamaMessage = { role: msg.role as OllamaMessage['role'], content: '' };

    if (msg.role === 'tool') {
      out.role = 'tool';
      out.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (msg.name) out.tool_name = msg.name;
      return out;
    }

    if (typeof msg.content === 'string') {
      out.content = msg.content;
    } else {
      const texts: string[] = [];
      const images: string[] = [];
      for (const cp of msg.content) {
        const piece = partToOllama(cp);
        if (piece.text) texts.push(piece.text);
        if (piece.image) images.push(piece.image);
      }
      out.content = texts.join('\n');
      if (images.length > 0) out.images = images;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      out.tool_calls = msg.toolCalls.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          // empty
        }
        return { function: { name: tc.name, arguments: args } };
      });
    }

    return out;
  });
}

function buildOllamaTools(tools: ModelRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  // Ollama tool format mirrors OpenAI: { type: 'function', function: {...} }
  return translate(tools, openaiAdapter);
}

// ─── Capability detection ────────────────────────────────────

interface OllamaModelMetadata {
  pattern: RegExp;
  capabilities: CapabilityId[];
  maxContextTokens: number;
}

const OLLAMA_MODEL_METADATA: OllamaModelMetadata[] = [
  {
    pattern: /(deepseek-r1|qwq|qwen3.*reasoner|o1)/i,
    capabilities: [Capabilities.Chat, Capabilities.Streaming, Capabilities.Reasoning],
    maxContextTokens: 128_000,
  },
  {
    pattern: /(llava|bakllava|moondream|llama3\.2-vision|qwen2\.5-vl|minicpm-v)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.Vision,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 32_768,
  },
  {
    pattern: /(llama3(\.[12])?(:|$)|llama-3\.[12]|mistral|qwen2\.5|qwen3|phi[34]|firefunction|command-r)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
    ],
    maxContextTokens: 128_000,
  },
  {
    pattern: /(gemma|llama2|codellama|tinyllama|orca|vicuna)/i,
    capabilities: [Capabilities.Chat, Capabilities.Streaming],
    maxContextTokens: 8_192,
  },
];

const OLLAMA_DEFAULT_METADATA: OllamaModelMetadata = {
  pattern: /.*/,
  capabilities: [Capabilities.Chat, Capabilities.Streaming],
  maxContextTokens: 8_192,
};

function resolveOllamaMetadata(modelId: string): OllamaModelMetadata {
  return OLLAMA_MODEL_METADATA.find((m) => m.pattern.test(modelId)) ?? OLLAMA_DEFAULT_METADATA;
}

// ─── Response parsing ────────────────────────────────────────

function mapDoneReason(reason: string | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'load':
    case 'unload':
      return 'stop';
    default:
      return 'stop';
  }
}

interface OllamaResponseMessage {
  role?: string;
  content?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
}

// ─── NDJSON streaming ────────────────────────────────────────

async function* ollamaNdjsonStream(
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
  if (!res.ok) throw await ollamaErrorFromResponse(res);

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'No response body', provider: 'ollama' });
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          // skip malformed line
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      try {
        yield JSON.parse(trailing) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
}

// ─── Model factory ───────────────────────────────────────────

export function weaveOllamaModel(
  modelId: string,
  providerOptions?: OllamaProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const baseUrl = resolveBaseUrl(opts);
  const detected = resolveOllamaMetadata(modelId);
  const capabilityIds = opts.capabilities ?? detected.capabilities;
  const caps = weaveCapabilities(...capabilityIds);

  const info: ModelInfo = {
    provider: 'ollama',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: opts.maxContextTokens ?? detected.maxContextTokens,
  };

  function buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: buildOllamaMessages(request.messages),
      stream,
    };

    const ollamaOptions: Record<string, unknown> = { ...(opts.options ?? {}) };
    if (request.temperature != null) ollamaOptions['temperature'] = request.temperature;
    if (request.topP != null) ollamaOptions['top_p'] = request.topP;
    if (request.maxTokens != null) ollamaOptions['num_predict'] = request.maxTokens;
    if (request.stop) {
      ollamaOptions['stop'] = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (Object.keys(ollamaOptions).length > 0) body['options'] = ollamaOptions;

    const tools = buildOllamaTools(request.tools);
    if (tools) body['tools'] = tools;

    if (request.responseFormat?.type === 'json_schema') {
      body['format'] = request.responseFormat.schema;
    } else if (request.responseFormat?.type === 'json_object') {
      body['format'] = 'json';
    }

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
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: composeRequestSignal(signal),
        });
        if (!res.ok) throw await ollamaErrorFromResponse(res);
        const raw = (await res.json()) as Record<string, unknown>;

        const message = (raw['message'] as OllamaResponseMessage | undefined) ?? {};
        const promptTokens = (raw['prompt_eval_count'] as number | undefined) ?? 0;
        const completionTokens = (raw['eval_count'] as number | undefined) ?? 0;

        const toolCalls = message.tool_calls?.map((tc, idx) => ({
          id: `ollama-tool-${idx}`,
          name: String(tc.function?.name ?? ''),
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        }));

        return {
          id: '',
          content: String(message.content ?? ''),
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: mapDoneReason(raw['done_reason'] as string | undefined),
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          model: String(raw['model'] ?? modelId),
          metadata: {
            createdAt: raw['created_at'],
            totalDurationNs: raw['total_duration'],
            evalDurationNs: raw['eval_duration'],
          },
        };
      } catch (err) {
        throw normalizeError(err, 'ollama');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const headers = makeHeaders(opts);
      const body = buildBody(request, true);
      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        let toolIndex = 0;
        for await (const chunk of ollamaNdjsonStream(`${baseUrl}/api/chat`, body, headers, signal)) {
          const message = chunk['message'] as OllamaResponseMessage | undefined;
          if (message?.content) {
            yield { type: 'text' as const, text: String(message.content) };
          }
          if (message?.tool_calls?.length) {
            for (const tc of message.tool_calls) {
              yield {
                type: 'tool_call' as const,
                toolCall: {
                  id: `ollama-tool-${toolIndex++}`,
                  name: String(tc.function?.name ?? ''),
                  arguments: JSON.stringify(tc.function?.arguments ?? {}),
                },
              };
            }
          }
          if (chunk['done'] === true) {
            const promptTokens = (chunk['prompt_eval_count'] as number | undefined) ?? 0;
            const completionTokens = (chunk['eval_count'] as number | undefined) ?? 0;
            if (promptTokens || completionTokens) {
              yield {
                type: 'usage' as const,
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                },
              };
            }
            yield { type: 'done' as const };
          }
        }
      })();
    },
  };
}

// ─── Embedding model ─────────────────────────────────────────

export function weaveOllamaEmbeddingModel(
  modelId: string = 'nomic-embed-text',
  providerOptions?: OllamaProviderOptions,
): EmbeddingModel {
  const opts = providerOptions ?? {};
  const baseUrl = resolveBaseUrl(opts);
  const caps = weaveCapabilities(Capabilities.Embedding);

  return {
    info: {
      provider: 'ollama',
      modelId,
      capabilities: caps.capabilities,
    },
    ...caps,

    async embed(ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const headers = makeHeaders(opts);
      const inputArray = Array.isArray(request.input) ? request.input : [request.input];
      const signal = deadlineSignal(ctx);

      try {
        const res = await fetch(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: modelId, input: inputArray }),
          signal: composeRequestSignal(signal),
        });
        if (!res.ok) throw await ollamaErrorFromResponse(res);
        const raw = (await res.json()) as Record<string, unknown>;
        const embeddings = (raw['embeddings'] as number[][] | undefined) ?? [];
        const promptTokens = (raw['prompt_eval_count'] as number | undefined) ?? 0;

        return {
          embeddings,
          model: modelId,
          usage: { totalTokens: promptTokens },
        };
      } catch (err) {
        throw normalizeError(err, 'ollama');
      }
    },
  };
}

// ─── Auto-register ───────────────────────────────────────────

let providerOpts: OllamaProviderOptions = {};

export function weaveOllamaConfig(options: OllamaProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('ollama', (modelId, options) =>
  weaveOllamaModel(modelId, { ...providerOpts, ...(options as OllamaProviderOptions) }),
);

weaveRegisterEmbedding('ollama', (modelId, options) =>
  weaveOllamaEmbeddingModel(modelId, { ...providerOpts, ...(options as OllamaProviderOptions) }),
);

export function weaveOllama(modelId: string, options?: OllamaProviderOptions): Model {
  return weaveOllamaModel(modelId, { ...providerOpts, ...options });
}

export function weaveOllamaEmbedding(
  modelId?: string,
  options?: OllamaProviderOptions,
): EmbeddingModel {
  return weaveOllamaEmbeddingModel(modelId, { ...providerOpts, ...options });
}
