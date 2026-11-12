// SPDX-License-Identifier: MIT
/**
 * The adapter for every server that speaks the OpenAI chat-completions and
 * embeddings wire format: Groq, Together, Fireworks, Mistral, OpenRouter,
 * DeepSeek, Databricks model serving, Azure OpenAI, Azure AI Foundry, and local
 * servers such as vLLM, LM Studio, Ollama's `/v1` and text-embeddings-inference.
 *
 * In plain terms: these servers agree on the shape of a request but differ in
 * small ways (what the "maximum reply length" field is called, where the model
 * name goes, which header carries the key). Each difference is a field of
 * `WireQuirks`, which is data. There is no `if (provider === 'groq')` anywhere.
 */

import { WeaveIntelError, type Message, type ModelRequest, type ModelResponse, type StreamChunk, type ToolCall } from '@weaveintel/core';
import { malformed, parseJsonBody, sseData } from '../wire.js';
import type {
  AdapterCall,
  AdapterEmbedInput,
  AdapterEmbedOutput,
  DiscoveredModel,
  ModelDescription,
  ProviderAdapter,
  SecretSlot,
  WireQuirks,
  WireRequest,
} from '../types.js';

type Json = Record<string, unknown>;

export interface OpenAICompatibleAdapterOptions {
  /** The adapter kind providers refer to. Default `openai-compatible`. */
  readonly kind?: string;
  /** Plain name shown to an administrator. */
  readonly label?: string;
  /** Quirks every provider of this kind starts from; a provider's own `quirks` override them. */
  readonly quirks?: WireQuirks;
  /** Settings every provider of this kind starts from (for example `apiVersion`). */
  readonly settings?: Readonly<Record<string, string>>;
  /** Secret slots. Default: one optional API key. */
  readonly secretSlots?: readonly SecretSlot[];
}

const API_KEY_SLOT: SecretSlot = { name: 'apiKey', label: 'API key', required: false };

function invalid(call: AdapterCall, message: string): WeaveIntelError {
  return new WeaveIntelError({ code: 'INVALID_CONFIG', message, provider: call.provider.id, retryable: false });
}

function label(call: AdapterCall): string {
  return call.provider.displayName ?? call.provider.id;
}

/** Translate the library's messages into OpenAI chat messages. */
export function toOpenAIMessages(messages: readonly Message[]): Json[] {
  return messages.map((msg) => {
    const m: Json = { role: msg.role };
    if (typeof msg.content === 'string') {
      m['content'] = msg.content;
    } else {
      m['content'] = msg.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image') {
          return { type: 'image_url', image_url: { url: part.url ?? `data:${part.mimeType ?? 'image/png'};base64,${part.base64 ?? ''}` } };
        }
        throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `Content of type "${part.type}" cannot be sent to an OpenAI-compatible chat endpoint.`, retryable: false });
      });
    }
    if (msg.name) m['name'] = msg.name;
    if (msg.role === 'tool' && msg.toolCallId) m['tool_call_id'] = msg.toolCallId;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      m['tool_calls'] = msg.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
      if (m['content'] === '') m['content'] = null;
    }
    return m;
  });
}

function finishReason(raw: unknown, hasTools: boolean): ModelResponse['finishReason'] {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_calls';
  if (raw === 'length') return 'length';
  if (raw === 'content_filter') return 'content_filter';
  return hasTools ? 'tool_calls' : 'stop';
}

function usageOf(u: Json | undefined): ModelResponse['usage'] {
  const prompt = Number(u?.['prompt_tokens'] ?? 0);
  const completion = Number(u?.['completion_tokens'] ?? 0);
  const cached = Number((u?.['prompt_tokens_details'] as Json | undefined)?.['cached_tokens'] ?? 0);
  const reasoning = Number((u?.['completion_tokens_details'] as Json | undefined)?.['reasoning_tokens'] ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(u?.['total_tokens'] ?? prompt + completion),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Guess what a listed model is for from its name and any hints the server gave. */
function kindOf(id: string, hint?: string): DiscoveredModel['kind'] {
  const h = (hint ?? '').toLowerCase();
  if (h.includes('embed')) return 'embedding';
  if (h.includes('chat') || h.includes('completion')) return 'chat';
  if (/embed|bge-|e5-|gte-|minilm|nomic/i.test(id)) return 'embedding';
  if (/whisper|tts|dall-e|image|moderation|rerank|guard|speech|audio/i.test(id)) return 'unknown';
  return 'chat';
}

export function openAICompatibleAdapter(options: OpenAICompatibleAdapterOptions = {}): ProviderAdapter {
  const kind = options.kind ?? 'openai-compatible';
  const adapterLabel = options.label ?? 'OpenAI-compatible server';

  function quirksOf(call: AdapterCall): WireQuirks {
    return { ...(options.quirks ?? {}), ...(call.provider.quirks ?? {}) };
  }

  function setting(call: AdapterCall, name: string): string | undefined {
    return call.provider.settings?.[name] ?? options.settings?.[name];
  }

  function url(call: AdapterCall, template: string, modelId?: string): string {
    const base = call.provider.baseUrl?.replace(/\/+$/, '');
    if (!base) throw invalid(call, `${label(call)} has no address (base URL) set.`);
    const path = template.replace('{model}', encodeURIComponent(modelId ?? ''));
    const apiVersion = setting(call, 'apiVersion');
    const full = `${base}${path}`;
    if (!apiVersion) return full;
    return `${full}${full.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion)}`;
  }

  async function headers(call: AdapterCall): Promise<Record<string, string>> {
    const q = quirksOf(call);
    const out: Record<string, string> = { 'content-type': 'application/json', ...(call.provider.headers ?? {}) };
    // A bearer token (the Microsoft Entra seam: the host's secret resolver
    // returns the current token) wins over a static key when both are set.
    const token = await call.optionalSecret('bearerToken');
    if (token !== undefined) {
      out['authorization'] = `Bearer ${token}`;
      return out;
    }
    const auth = q.auth ?? 'bearer';
    if (auth === 'none') {
      const key = await call.optionalSecret('apiKey');
      if (key !== undefined) out['authorization'] = `Bearer ${key}`;
      return out;
    }
    const key = await call.secret('apiKey');
    if (auth === 'api-key') out['api-key'] = key;
    else out['authorization'] = `Bearer ${key}`;
    return out;
  }

  function chatBody(call: AdapterCall, model: ModelDescription, request: ModelRequest, stream: boolean): Json {
    const q = quirksOf(call);
    const body: Json = { messages: toOpenAIMessages(request.messages) };
    if (q.modelInBody !== false) body['model'] = model.id;
    if (request.tools && request.tools.length > 0) {
      if (q.tools === false) {
        throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `${label(call)} does not support tools, and this request needs them.`, provider: call.provider.id, retryable: false });
      }
      body['tools'] = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) },
      }));
      if (request.toolChoice !== undefined && q.toolChoice !== false) {
        body['tool_choice'] = typeof request.toolChoice === 'string' ? request.toolChoice : { type: 'function', function: { name: request.toolChoice.name } };
      }
    }
    if (request.responseFormat) {
      if (q.responseFormat === false) {
        throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `${label(call)} does not support structured output, and this request needs it.`, provider: call.provider.id, retryable: false });
      }
      body['response_format'] =
        request.responseFormat.type === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: request.responseFormat.name ?? 'response', schema: request.responseFormat.schema ?? {}, ...(request.responseFormat.strict !== undefined ? { strict: request.responseFormat.strict } : {}) } }
          : { type: 'json_object' };
    }
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.stop && request.stop.length > 0) body['stop'] = [...request.stop];
    if (request.maxTokens !== undefined) body[q.tokenLimitParam ?? 'max_completion_tokens'] = request.maxTokens;
    if (stream) {
      body['stream'] = true;
      if (q.streamUsage !== false) body['stream_options'] = { include_usage: true };
    }
    return body;
  }

  async function post(call: AdapterCall, path: string, modelId: string, body: Json): Promise<WireRequest> {
    return { method: 'POST', url: url(call, path, modelId), headers: await headers(call), body: JSON.stringify(body) };
  }

  async function listModels(call: AdapterCall): Promise<readonly DiscoveredModel[]> {
    const q = quirksOf(call);
    const path = q.modelsPath ?? '/models';
    if (path === '') {
      throw new WeaveIntelError({ code: 'INVALID_CONFIG', message: `${label(call)} cannot list its models.`, provider: call.provider.id, retryable: false, details: { cannotList: true } });
    }
    const res = await call.transport.send({ method: 'GET', url: url(call, path), headers: await headers(call) });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw malformed(label(call), 'the list of models was not JSON');
    }
    const body = parsed as Json;
    // The shapes seen in the wild: OpenAI `{data:[{id}]}`, a bare array
    // (Together), Databricks `{endpoints:[{name,task,state}]}`, and Azure AI
    // Foundry's single `{model_name, model_type}`.
    if (!Array.isArray(parsed) && typeof body['model_name'] === 'string') {
      return [{ id: body['model_name'], kind: kindOf(body['model_name'], String(body['model_type'] ?? '')) }];
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(body['data']) ? body['data'] : Array.isArray(body['endpoints']) ? body['endpoints'] : Array.isArray(body['models']) ? body['models'] : undefined;
    if (!rows) throw malformed(label(call), 'the list of models was not in a known shape');
    const out: DiscoveredModel[] = [];
    for (const row of rows as Json[]) {
      const id = typeof row['id'] === 'string' ? row['id'] : typeof row['name'] === 'string' ? row['name'] : undefined;
      if (!id) continue;
      const caps = row['capabilities'] as Json | undefined;
      const hint = typeof row['task'] === 'string' ? row['task'] : typeof row['type'] === 'string' ? row['type'] : caps?.['embeddings'] === true ? 'embeddings' : caps?.['chat_completion'] === true ? 'chat' : '';
      const ready = (row['state'] as Json | undefined)?.['ready'];
      const context = Number(row['context_length'] ?? row['context_window'] ?? NaN);
      out.push({
        id,
        kind: kindOf(id, hint),
        ...(typeof row['display_name'] === 'string' ? { displayName: row['display_name'] } : {}),
        ...(Number.isFinite(context) ? { maxContextTokens: context } : {}),
        ...(typeof ready === 'string' ? { ready: ready === 'READY' } : {}),
      });
    }
    return out;
  }

  return {
    kind,
    label: adapterLabel,
    secretSlots: options.secretSlots ?? [API_KEY_SLOT],

    async generate(call, model, request): Promise<ModelResponse> {
      const q = quirksOf(call);
      const res = await call.transport.send(await post(call, q.chatPath ?? '/chat/completions', model.id, chatBody(call, model, request, false)));
      const body = parseJsonBody<Json>(label(call), res.text);
      const choice = (body['choices'] as Json[] | undefined)?.[0];
      const message = choice?.['message'] as Json | undefined;
      if (!choice || !message) throw malformed(label(call), 'the reply held no message');
      const toolCalls: ToolCall[] = ((message['tool_calls'] as Json[] | undefined) ?? []).map((tc, i) => {
        const fn = (tc['function'] as Json | undefined) ?? {};
        const args = fn['arguments'];
        return { id: typeof tc['id'] === 'string' ? tc['id'] : `call_${i}`, name: String(fn['name'] ?? ''), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
      });
      const content = message['content'];
      const reasoning = message['reasoning_content'] ?? message['reasoning'];
      return {
        id: typeof body['id'] === 'string' ? body['id'] : '',
        content: typeof content === 'string' ? content : '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: finishReason(choice['finish_reason'], toolCalls.length > 0),
        usage: usageOf(body['usage'] as Json | undefined),
        model: typeof body['model'] === 'string' ? body['model'] : model.id,
        ...(typeof reasoning === 'string' && reasoning !== '' ? { reasoning } : {}),
      };
    },

    async *stream(call, model, request): AsyncIterable<StreamChunk> {
      const q = quirksOf(call);
      const res = await call.transport.open(await post(call, q.chatPath ?? '/chat/completions', model.id, chatBody(call, model, request, true)));
      if (!res.body) throw malformed(label(call), 'the stream had no body');
      for await (const data of sseData(res.body)) {
        let chunk: Json;
        try {
          chunk = JSON.parse(data) as Json;
        } catch {
          throw malformed(label(call), 'a piece of the stream was not JSON');
        }
        const failure = chunk['error'];
        if (failure) {
          const m = typeof failure === 'object' ? (failure as Json)['message'] : failure;
          throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: `${label(call)} stopped the reply: ${String(m ?? 'no reason given')}`, provider: call.provider.id, retryable: true });
        }
        const choice = (chunk['choices'] as Json[] | undefined)?.[0];
        const delta = choice?.['delta'] as Json | undefined;
        if (typeof delta?.['content'] === 'string' && delta['content'] !== '') yield { type: 'text', text: delta['content'] };
        const reasoning = delta?.['reasoning_content'] ?? delta?.['reasoning'];
        if (typeof reasoning === 'string' && reasoning !== '') yield { type: 'reasoning', reasoning };
        for (const tc of (delta?.['tool_calls'] as Json[] | undefined) ?? []) {
          const fn = tc['function'] as Json | undefined;
          yield {
            type: 'tool_call',
            toolCall: {
              ...(typeof tc['id'] === 'string' ? { id: tc['id'] } : {}),
              ...(typeof fn?.['name'] === 'string' ? { name: fn['name'] } : {}),
              ...(typeof fn?.['arguments'] === 'string' ? { arguments: fn['arguments'] } : {}),
            },
          };
        }
        if (chunk['usage']) yield { type: 'usage', usage: usageOf(chunk['usage'] as Json) };
      }
      // "done" is always the last piece: the usage figures arrive after the
      // finish marker on servers that send them in the stream.
      yield { type: 'done' };
    },

    async embed(call, model, input: AdapterEmbedInput): Promise<AdapterEmbedOutput> {
      const q = quirksOf(call);
      const body: Json = { input: [...input.texts] };
      if (q.modelInBody !== false) body['model'] = model.id;
      const sizeParam = q.embeddingSizeParam ?? 'dimensions';
      if (input.dimensions !== undefined && sizeParam !== 'none') body[sizeParam] = input.dimensions;
      if (q.embeddingInputType === true && input.mode !== undefined) body['input_type'] = input.mode;
      const res = await call.transport.send(await post(call, q.embeddingsPath ?? '/embeddings', model.id, body));
      const reply = parseJsonBody<Json>(label(call), res.text);
      const rows = reply['data'];
      if (!Array.isArray(rows)) throw malformed(label(call), 'the reply held no vectors');
      const ordered = [...(rows as Json[])].sort((a, b) => Number(a['index'] ?? 0) - Number(b['index'] ?? 0));
      const vectors = ordered.map((r) => {
        const v = r['embedding'];
        if (!Array.isArray(v)) throw malformed(label(call), 'a vector was missing');
        return v as number[];
      });
      const usage = reply['usage'] as Json | undefined;
      return { vectors, totalTokens: Number(usage?.['total_tokens'] ?? usage?.['prompt_tokens'] ?? 0) };
    },

    listModels,

    async probe(call): Promise<void> {
      const q = quirksOf(call);
      if ((q.modelsPath ?? '/models') !== '') {
        await listModels(call);
        return;
      }
      if (!q.probePath) throw invalid(call, `${label(call)} has no way to test a connection.`);
      await call.transport.send({ method: 'GET', url: url(call, q.probePath), headers: await headers(call) });
    },
  };
}
