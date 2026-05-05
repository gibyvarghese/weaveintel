/**
 * @weaveintel/provider-google — Google Gemini chat model adapter
 *
 * Implements the Generative Language API (`generativelanguage.googleapis.com`)
 * v1beta endpoints. Uses raw fetch — no vendor SDK dependency.
 *
 * Supports:
 * - Chat completion (`generateContent`) + streaming (`streamGenerateContent`)
 * - Tool use (functionDeclarations / functionCall / functionResponse)
 * - Vision (inlineData parts: images, audio, PDF)
 * - System instruction (top-level `system_instruction`)
 * - JSON-mode structured output via `responseMimeType` + `responseSchema`
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
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  WeaveIntelError,
  normalizeError,
  deadlineSignal,
  parseRetryAfterMs,
} from '@weaveintel/core';
import { weaveRegisterModel } from '@weaveintel/models';
import { createResilientCallable, type ResilientCallable } from '@weaveintel/resilience';
import { googleAdapter, translate } from '@weaveintel/tool-schema';

// ─── Configuration ───────────────────────────────────────────

export interface GoogleProviderOptions {
  apiKey?: string;
  /** Override the API base URL (default: https://generativelanguage.googleapis.com/v1beta) */
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function resolveApiKey(options?: GoogleProviderOptions): string {
  const key =
    options?.apiKey ??
    process.env['GEMINI_API_KEY'] ??
    process.env['GOOGLE_API_KEY'] ??
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  if (!key) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message:
        'Google API key not provided. Set GEMINI_API_KEY (or GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) or pass apiKey option.',
      provider: 'google',
    });
  }
  return key;
}

function makeHeaders(options: GoogleProviderOptions): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
  };
}

function composeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

// ─── HTTP helpers ────────────────────────────────────────────

async function googleErrorFromResponse(res: Response): Promise<WeaveIntelError> {
  const errorBody = await res.text().catch(() => '');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(errorBody) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const errorObj = parsed['error'] as Record<string, unknown> | undefined;
  const errorMessage = errorObj?.['message'] ?? errorBody ?? `HTTP ${res.status}`;

  if (res.status === 429) {
    return new WeaveIntelError({
      code: 'RATE_LIMITED',
      message: `Google rate limited: ${String(errorMessage)}`,
      provider: 'google',
      retryable: true,
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: `Google auth failed: ${String(errorMessage)}`,
      provider: 'google',
    });
  }
  return new WeaveIntelError({
    code: 'PROVIDER_ERROR',
    message: `Google error (${res.status}): ${String(errorMessage)}`,
    provider: 'google',
    retryable: res.status >= 500,
    details: parsed,
  });
}

async function googleRequest(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  return getRequestCallable(DEFAULT_ENDPOINT_ID)(url, body, headers, signal);
}

async function googleRequestRaw(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });
  if (!res.ok) throw await googleErrorFromResponse(res);
  return res.json();
}

async function* googleStreamRequest(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  // Initial fetch wrapped by resilience pipeline; iteration runs outside the
  // pipeline so streaming reads aren't bound by the per-call timeout.
  const reader = await getStreamFetchCallable(DEFAULT_ENDPOINT_ID)(url, body, headers, signal);
  yield* iterateGoogleStream(reader);
}

async function googleStreamFetchRaw(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composeRequestSignal(signal),
  });
  if (!res.ok) throw await googleErrorFromResponse(res);

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'No response body', provider: 'google' });
  }
  return reader;
}

async function* iterateGoogleStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Gemini SSE uses `data: {json}\n\n` — same shape as OpenAI but no [DONE].
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (!data) continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // skip malformed chunks
        }
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

// ─── Resilience pipeline (process-wide, endpoint-scoped) ────

const DEFAULT_ENDPOINT_ID = 'google:rest';

const RESILIENCE_DEFAULTS = {
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
  circuit: { failureThreshold: 8, cooldownMs: 30_000 },
} as const;

type RequestArgs = [
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
];

const requestCallables = new Map<string, ResilientCallable<RequestArgs, unknown>>();
const streamFetchCallables = new Map<
  string,
  ResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>>
>();

function getRequestCallable(endpoint: string): ResilientCallable<RequestArgs, unknown> {
  let c = requestCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<RequestArgs, unknown>(googleRequestRaw, {
      endpoint,
      retry: RESILIENCE_DEFAULTS.retry,
      circuit: RESILIENCE_DEFAULTS.circuit,
    });
    requestCallables.set(endpoint, c);
  }
  return c;
}

function getStreamFetchCallable(
  endpoint: string,
): ResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>> {
  let c = streamFetchCallables.get(endpoint);
  if (!c) {
    c = createResilientCallable<RequestArgs, ReadableStreamDefaultReader<Uint8Array>>(
      googleStreamFetchRaw,
      {
        endpoint,
        retry: RESILIENCE_DEFAULTS.retry,
        circuit: RESILIENCE_DEFAULTS.circuit,
      },
    );
    streamFetchCallables.set(endpoint, c);
  }
  return c;
}

// ─── Message construction ────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

function partToGeminiPart(part: ContentPart): GeminiPart {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      if (part.url && part.url.startsWith('http')) {
        return { fileData: { mimeType: part.mimeType ?? 'image/png', fileUri: part.url } };
      }
      return {
        inlineData: { mimeType: part.mimeType ?? 'image/png', data: part.base64 ?? '' },
      };
    case 'audio':
      return {
        inlineData: { mimeType: part.mimeType ?? 'audio/wav', data: part.base64 ?? '' },
      };
    case 'file':
      if (part.url && part.url.startsWith('http')) {
        return {
          fileData: {
            mimeType: part.mimeType ?? 'application/octet-stream',
            fileUri: part.url,
          },
        };
      }
      return {
        inlineData: {
          mimeType: part.mimeType ?? 'application/octet-stream',
          data: part.base64 ?? '',
        },
      };
    default:
      return { text: `[${(part as { type: string }).type} content]` };
  }
}

function buildGeminiRequest(
  request: ModelRequest,
): { contents: GeminiContent[]; systemInstruction?: GeminiContent } {
  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiContent | undefined;

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : msg.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const existing = systemInstruction?.parts[0]?.text ?? '';
      systemInstruction = {
        role: 'user',
        parts: [{ text: existing ? `${existing}\n${text}` : text }],
      };
      continue;
    }

    if (msg.role === 'tool' && msg.toolCallId) {
      let payload: Record<string, unknown>;
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      try {
        const parsed = JSON.parse(raw) as unknown;
        payload = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : { result: parsed };
      } catch {
        payload = { result: raw };
      }
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: { name: msg.name ?? msg.toolCallId, response: payload },
        }],
      });
      continue;
    }

    const role: GeminiContent['role'] = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else {
      for (const cp of msg.content) parts.push(partToGeminiPart(cp));
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          // keep empty
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
    }

    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role, parts });
  }

  return { contents, systemInstruction };
}

function buildGeminiTools(tools: ModelRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return translate(tools, googleAdapter);
}

function buildGeminiToolConfig(
  toolChoice: ModelRequest['toolChoice'],
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
        return { functionCallingConfig: { mode: 'AUTO' } };
      case 'none':
        return { functionCallingConfig: { mode: 'NONE' } };
      case 'required':
        return { functionCallingConfig: { mode: 'ANY' } };
      default:
        return { functionCallingConfig: { mode: 'AUTO' } };
    }
  }
  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] },
  };
}

// ─── Capability detection ────────────────────────────────────

interface GeminiModelMetadata {
  pattern: RegExp;
  capabilities: CapabilityId[];
  maxContextTokens: number;
  maxOutputTokens: number;
}

const GEMINI_MODEL_METADATA: GeminiModelMetadata[] = [
  {
    // Gemini 2.5 / 2.0 Pro & Flash families
    pattern: /gemini-(2\.\d|3\.\d|2|3)(?:\.\d)?-(pro|flash)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.Reasoning,
    ],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    pattern: /gemini-1\.5-(pro|flash)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
      Capabilities.Vision,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
  },
  {
    pattern: /gemini/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
];

const GEMINI_DEFAULT_METADATA: GeminiModelMetadata = {
  pattern: /.*/,
  capabilities: [Capabilities.Chat, Capabilities.Streaming],
  maxContextTokens: 32_768,
  maxOutputTokens: 8_192,
};

function resolveGeminiMetadata(modelId: string): GeminiModelMetadata {
  return GEMINI_MODEL_METADATA.find((m) => m.pattern.test(modelId)) ?? GEMINI_DEFAULT_METADATA;
}

// ─── Response parsing ────────────────────────────────────────

function mapFinishReason(reason: string | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'TOOL_CODE':
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

interface ParsedCandidate {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | undefined;
}

function parseCandidate(candidate: Record<string, unknown> | undefined): ParsedCandidate {
  const result: ParsedCandidate = {
    text: '',
    reasoning: '',
    toolCalls: [],
    finishReason: candidate?.['finishReason'] as string | undefined,
  };
  const content = candidate?.['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'];
  if (!Array.isArray(parts)) return result;

  let toolIndex = 0;
  for (const raw of parts as Array<Record<string, unknown>>) {
    if (typeof raw['text'] === 'string') {
      if (raw['thought'] === true) {
        result.reasoning += raw['text'] as string;
      } else {
        result.text += raw['text'] as string;
      }
      continue;
    }
    const fc = raw['functionCall'] as Record<string, unknown> | undefined;
    if (fc && typeof fc['name'] === 'string') {
      result.toolCalls.push({
        id: `gemini-tool-${toolIndex++}`,
        name: String(fc['name']),
        arguments: JSON.stringify(fc['args'] ?? {}),
      });
    }
  }
  return result;
}

function parseUsage(raw: Record<string, unknown>): ModelResponse['usage'] {
  const usage = raw['usageMetadata'] as Record<string, number> | undefined;
  return {
    promptTokens: usage?.['promptTokenCount'] ?? 0,
    completionTokens: usage?.['candidatesTokenCount'] ?? 0,
    totalTokens:
      usage?.['totalTokenCount'] ??
      ((usage?.['promptTokenCount'] ?? 0) + (usage?.['candidatesTokenCount'] ?? 0)),
  };
}

// ─── Model factory ───────────────────────────────────────────

export function weaveGoogleModel(
  modelId: string,
  providerOptions?: GoogleProviderOptions,
): Model {
  const opts = providerOptions ?? {};
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const meta = resolveGeminiMetadata(modelId);
  const caps = weaveCapabilities(...meta.capabilities);

  const info: ModelInfo = {
    provider: 'google',
    modelId,
    capabilities: caps.capabilities,
    maxContextTokens: meta.maxContextTokens,
    maxOutputTokens: meta.maxOutputTokens,
  };

  return {
    info,
    ...caps,

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const apiKey = resolveApiKey(opts);
      const headers = makeHeaders(opts);
      const { contents, systemInstruction } = buildGeminiRequest(request);

      const generationConfig: Record<string, unknown> = {};
      if (request.temperature != null) generationConfig['temperature'] = request.temperature;
      if (request.topP != null) generationConfig['topP'] = request.topP;
      if (request.maxTokens != null) generationConfig['maxOutputTokens'] = request.maxTokens;
      if (request.stop) {
        generationConfig['stopSequences'] = Array.isArray(request.stop) ? request.stop : [request.stop];
      }
      if (request.responseFormat?.type === 'json_schema') {
        generationConfig['responseMimeType'] = 'application/json';
        generationConfig['responseSchema'] = request.responseFormat.schema;
      } else if (request.responseFormat?.type === 'json_object') {
        generationConfig['responseMimeType'] = 'application/json';
      }

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body['systemInstruction'] = systemInstruction;
      if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

      const tools = buildGeminiTools(request.tools);
      if (tools) body['tools'] = tools;
      const toolConfig = buildGeminiToolConfig(request.toolChoice);
      if (toolConfig) body['toolConfig'] = toolConfig;

      const url = `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const signal = deadlineSignal(ctx);

      try {
        const raw = (await googleRequest(url, body, headers, signal)) as Record<string, unknown>;
        const candidates = raw['candidates'] as Array<Record<string, unknown>> | undefined;
        const candidate = candidates?.[0];
        const parsed = parseCandidate(candidate);
        const usage = parseUsage(raw);

        return {
          id: String(raw['responseId'] ?? ''),
          content: parsed.text,
          toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
          finishReason: mapFinishReason(parsed.finishReason),
          usage,
          model: modelId,
          reasoning: parsed.reasoning || undefined,
          metadata: { rawCandidate: candidate },
        };
      } catch (err) {
        throw normalizeError(err, 'google');
      }
    },

    stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
      const apiKey = resolveApiKey(opts);
      const headers = makeHeaders(opts);
      const { contents, systemInstruction } = buildGeminiRequest(request);

      const generationConfig: Record<string, unknown> = {};
      if (request.temperature != null) generationConfig['temperature'] = request.temperature;
      if (request.topP != null) generationConfig['topP'] = request.topP;
      if (request.maxTokens != null) generationConfig['maxOutputTokens'] = request.maxTokens;
      if (request.stop) {
        generationConfig['stopSequences'] = Array.isArray(request.stop) ? request.stop : [request.stop];
      }

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body['systemInstruction'] = systemInstruction;
      if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

      const tools = buildGeminiTools(request.tools);
      if (tools) body['tools'] = tools;
      const toolConfig = buildGeminiToolConfig(request.toolChoice);
      if (toolConfig) body['toolConfig'] = toolConfig;

      const url = `${baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<StreamChunk> {
        let toolIndex = 0;
        let lastUsage: ModelResponse['usage'] | undefined;
        for await (const chunk of googleStreamRequest(url, body, headers, signal)) {
          const candidates = chunk['candidates'] as Array<Record<string, unknown>> | undefined;
          const candidate = candidates?.[0];
          const content = candidate?.['content'] as Record<string, unknown> | undefined;
          const parts = content?.['parts'];

          if (Array.isArray(parts)) {
            for (const raw of parts as Array<Record<string, unknown>>) {
              if (typeof raw['text'] === 'string') {
                if (raw['thought'] === true) {
                  yield { type: 'reasoning' as const, reasoning: String(raw['text']) };
                } else {
                  yield { type: 'text' as const, text: String(raw['text']) };
                }
              }
              const fc = raw['functionCall'] as Record<string, unknown> | undefined;
              if (fc && typeof fc['name'] === 'string') {
                yield {
                  type: 'tool_call' as const,
                  toolCall: {
                    id: `gemini-tool-${toolIndex++}`,
                    name: String(fc['name']),
                    arguments: JSON.stringify(fc['args'] ?? {}),
                  },
                };
              }
            }
          }

          const usageMeta = chunk['usageMetadata'] as Record<string, number> | undefined;
          if (usageMeta) {
            lastUsage = {
              promptTokens: usageMeta['promptTokenCount'] ?? 0,
              completionTokens: usageMeta['candidatesTokenCount'] ?? 0,
              totalTokens:
                usageMeta['totalTokenCount'] ??
                ((usageMeta['promptTokenCount'] ?? 0) + (usageMeta['candidatesTokenCount'] ?? 0)),
            };
          }

          if (candidate?.['finishReason']) {
            if (lastUsage) {
              yield { type: 'usage' as const, usage: lastUsage };
              lastUsage = undefined;
            }
            yield { type: 'done' as const };
          }
        }
        if (lastUsage) {
          yield { type: 'usage' as const, usage: lastUsage };
        }
      })();
    },
  };
}

// ─── Auto-register ───────────────────────────────────────────

let providerOpts: GoogleProviderOptions = {};

export function weaveGoogleConfig(options: GoogleProviderOptions): void {
  providerOpts = options;
}

weaveRegisterModel('google', (modelId, options) =>
  weaveGoogleModel(modelId, { ...providerOpts, ...(options as GoogleProviderOptions) }),
);

// Also register under `gemini` alias for ergonomic configuration.
weaveRegisterModel('gemini', (modelId, options) =>
  weaveGoogleModel(modelId, { ...providerOpts, ...(options as GoogleProviderOptions) }),
);

export function weaveGoogle(modelId: string, options?: GoogleProviderOptions): Model {
  return weaveGoogleModel(modelId, { ...providerOpts, ...options });
}
