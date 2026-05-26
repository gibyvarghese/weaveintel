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
} from '@weaveintel/core';
import { weaveCapabilities, normalizeError, deadlineSignal } from '@weaveintel/core';
import { weaveRegisterModel } from '@weaveintel/models';
import { type GoogleProviderOptions } from './google-types.js';
import {
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  googleRequest,
  googleStreamRequest,
} from './google-client.js';
import {
  resolveGeminiMetadata,
  buildGeminiRequest,
  buildGeminiTools,
  buildGeminiToolConfig,
  parseCandidate,
  parseUsage,
  mapFinishReason,
} from './google-format.js';

export type { GoogleProviderOptions } from './google-types.js';

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
