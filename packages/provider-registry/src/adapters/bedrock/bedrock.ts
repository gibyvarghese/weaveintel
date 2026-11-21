// SPDX-License-Identifier: MIT
/**
 * AWS Bedrock: chat through the Converse API (with tools and streaming),
 * embeddings through InvokeModel (Amazon Titan and Cohere), and the list of
 * foundation models.
 *
 * In plain terms: Bedrock is Amazon's shop window for many companies' models.
 * It has its own request shape, its own way of proving who is calling
 * (a signature computed from two keys, or a single Bedrock API key) and its own
 * binary streaming format. This file translates all three. No AWS SDK is used.
 *
 * A provider row needs a `region`. The keys are slots: either `apiKey`
 * (a Bedrock API key) or `accessKeyId` + `secretAccessKey` (+ `sessionToken`
 * for temporary credentials).
 */

import { WeaveIntelError, featureForPart, profileSupports, unsupportedPart, type Message, type ModelRequest, type ModelResponse, type StreamChunk, type ToolCall } from '@weaveintel/core';
import { malformed, parseJsonBody } from '../../wire.js';
import type {
  AdapterCall,
  AdapterEmbedInput,
  AdapterEmbedOutput,
  DiscoveredModel,
  ModelDescription,
  ProviderAdapter,
  WireErrorOverride,
  WireRequest,
} from '../../types.js';
import { EventStreamFormatError, readEventStream } from './event-stream.js';
import { signRequest } from './sigv4.js';
import { profileOfModel } from '../../profile.js';

type Json = Record<string, unknown>;

function label(call: AdapterCall): string {
  return call.provider.displayName ?? call.provider.id;
}

function invalidConfig(call: AdapterCall, message: string): WeaveIntelError {
  return new WeaveIntelError({ code: 'INVALID_CONFIG', message, provider: call.provider.id, retryable: false });
}

function invalidInput(call: AdapterCall, message: string): WeaveIntelError {
  return new WeaveIntelError({ code: 'INVALID_INPUT', message, provider: call.provider.id, retryable: false });
}

function region(call: AdapterCall): string {
  const r = call.provider.region;
  if (!r) throw invalidConfig(call, `${label(call)} has no AWS region set.`);
  if (!/^[a-z0-9-]+$/.test(r)) throw invalidConfig(call, `${label(call)} has an AWS region that is not a region name.`);
  return r;
}

/** Where model calls go. A provider's own base URL (a private endpoint, a test server) wins. */
function runtimeBase(call: AdapterCall): string {
  const own = call.provider.baseUrl?.replace(/\/+$/, '');
  return own && own !== '' ? own : `https://bedrock-runtime.${region(call)}.amazonaws.com`;
}

/** Where "what models are there" goes. */
function controlBase(call: AdapterCall): string {
  const control = call.provider.settings?.['controlBaseUrl']?.replace(/\/+$/, '');
  if (control && control !== '') return control;
  const own = call.provider.baseUrl?.replace(/\/+$/, '');
  return own && own !== '' ? own : `https://bedrock.${region(call)}.amazonaws.com`;
}

/**
 * Add the proof of who is calling. A Bedrock API key is sent as a bearer token;
 * otherwise the request is signed with the access key pair.
 */
async function authorise(call: AdapterCall, request: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body: string }): Promise<WireRequest> {
  const apiKey = await call.optionalSecret('apiKey');
  if (apiKey !== undefined) {
    return { method: request.method, url: request.url, headers: { ...request.headers, authorization: `Bearer ${apiKey}` }, ...(request.method === 'POST' ? { body: request.body } : {}) };
  }
  const accessKeyId = await call.optionalSecret('accessKeyId');
  const secretAccessKey = await call.optionalSecret('secretAccessKey');
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new WeaveIntelError({
      code: 'AUTH_FAILED',
      message: `No key has been set for ${label(call)}. It needs either a Bedrock API key, or an access key ID together with a secret access key.`,
      provider: call.provider.id,
      retryable: false,
      details: { missingSecret: accessKeyId === undefined ? 'accessKeyId' : 'secretAccessKey' },
    });
  }
  const sessionToken = await call.optionalSecret('sessionToken');
  const headers = signRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    region: region(call),
    service: 'bedrock',
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken !== undefined ? { sessionToken } : {}) },
    now: new Date(),
  });
  return { method: request.method, url: request.url, headers, ...(request.method === 'POST' ? { body: request.body } : {}) };
}

// ─── Converse: request ───────────────────────────────────────

function parseArguments(call: AdapterCall, raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidInput(call, 'A tool call in the message history has arguments that are not JSON.');
  }
}

function toolResultContent(text: string): Json[] {
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return [{ json: value }];
  } catch {
    /* plain text result */
  }
  return [{ text }];
}

const IMAGE_FORMATS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Converse `document` formats (Bedrock API reference, DocumentBlock: pdf, csv, doc, docx, xls, xlsx, html, txt, md). */
export const BEDROCK_DOCUMENT_FORMATS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/** Converse `audio` formats (Bedrock API reference, AudioBlock). */
export const BEDROCK_AUDIO_FORMATS: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
};

const mimeOf = (m: string | undefined, fallback: string): string => (m ?? fallback).split(';')[0]!.trim().toLowerCase();

/**
 * Translate content parts into Converse blocks. Each part is sent properly or
 * refused with an `UnsupportedContentError` naming the capability:
 *
 * - images: bytes only (Bedrock takes no image links);
 * - PDF: a `document` block when the model row declares `pdf`;
 * - csv, doc, docx, xls, xlsx, html, txt, md: a `document` block when the row
 *   declares `document:<mime type>` (or a wildcard such as `document:text/*`);
 * - audio: an `audio` block when the row declares `audio_in`.
 *
 * Documents get neutral names (`document 1`, ...): Bedrock warns that the name
 * field is open to prompt injection, so the uploader's file name is never used.
 */
function contentBlocks(call: AdapterCall, model: ModelDescription, msg: Message, counter: { n: number }): Json[] {
  if (typeof msg.content === 'string') return msg.content === '' ? [] : [{ text: msg.content }];
  const profile = profileOfModel(model);
  const who = { provider: call.provider.id, modelId: model.id };
  return msg.content.map((part) => {
    if (part.type === 'text') return { text: part.text };
    const isImage = part.type === 'image' || (part.type === 'file' && mimeOf(part.mimeType, '').startsWith('image/'));
    if (isImage) {
      if (!part.base64) throw unsupportedPart(part, { ...who, capability: 'vision', reason: 'Bedrock needs the image itself, not a link to it' });
      const format = IMAGE_FORMATS[mimeOf(part.mimeType, 'image/png')];
      if (!format) throw unsupportedPart(part, { ...who, capability: 'vision', reason: `images of type ${mimeOf(part.mimeType, '')} are not accepted` });
      return { image: { format, source: { bytes: part.base64 } } };
    }
    if (part.type === 'file') {
      const mime = mimeOf(part.mimeType, 'application/octet-stream');
      const format = BEDROCK_DOCUMENT_FORMATS[mime];
      const feature = featureForPart(part)!;
      if (!format || !profileSupports(profile, feature)) throw unsupportedPart(part, who);
      if (!part.base64) throw unsupportedPart(part, { ...who, reason: 'Bedrock needs the document itself, not a link to it' });
      counter.n += 1;
      return { document: { format, name: `document ${counter.n}`, source: { bytes: part.base64 } } };
    }
    if (part.type === 'audio') {
      if (!profile.audioIn) throw unsupportedPart(part, who);
      const format = BEDROCK_AUDIO_FORMATS[mimeOf(part.mimeType, 'audio/wav')];
      if (!format) throw unsupportedPart(part, { ...who, reason: `audio of type ${mimeOf(part.mimeType, '')} is not accepted` });
      if (!part.base64) throw unsupportedPart(part, { ...who, reason: 'Bedrock needs the audio itself, not a link to it' });
      return { audio: { format, source: { bytes: part.base64 } } };
    }
    throw unsupportedPart(part, who);
  });
}

/** Translate the library's messages into Converse `system` and `messages`. */
export function toConverseMessages(
  call: AdapterCall,
  messages: readonly Message[],
  model: ModelDescription = { id: '', kind: 'chat' },
): { system: Json[]; messages: Json[] } {
  const system: Json[] = [];
  const counter = { n: 0 };
  // System prompts and tool results carry text only on Converse. Any other
  // part there is refused, never dropped.
  const textOnly = (msg: Message, where: string): string => {
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .map((p) => {
        if (p.type === 'text') return p.text;
        throw unsupportedPart(p, { provider: call.provider.id, ...(model.id ? { modelId: model.id } : {}), reason: `Converse takes only text in ${where}` });
      })
      .join('');
  };
  const out: Array<{ role: 'user' | 'assistant'; content: Json[] }> = [];
  const push = (role: 'user' | 'assistant', content: Json[]): void => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    // Converse wants turns to alternate, so neighbours with the same role are
    // joined (several tool results in a row become one user turn).
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content: [...content] });
  };
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = textOnly(msg, 'a system prompt');
      if (text !== '') system.push({ text });
      continue;
    }
    if (msg.role === 'tool') {
      push('user', [{ toolResult: { toolUseId: msg.toolCallId ?? '', content: toolResultContent(textOnly(msg, 'a tool result')) } }]);
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = contentBlocks(call, model, msg, counter);
      for (const tc of msg.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: parseArguments(call, tc.arguments) } });
      push('assistant', blocks);
      continue;
    }
    push('user', contentBlocks(call, model, msg, counter));
  }
  return { system, messages: out };
}

function converseBody(call: AdapterCall, model: ModelDescription, request: ModelRequest): Json {
  if (request.responseFormat) {
    throw invalidInput(call, `${label(call)} (Bedrock Converse) does not take a structured-output format through this adapter, and this request needs one.`);
  }
  const { system, messages } = toConverseMessages(call, request.messages, model);
  const body: Json = { messages };
  if (system.length > 0) body['system'] = system;
  const inference: Json = {};
  if (request.maxTokens !== undefined) inference['maxTokens'] = request.maxTokens;
  if (request.temperature !== undefined) inference['temperature'] = request.temperature;
  if (request.topP !== undefined) inference['topP'] = request.topP;
  if (request.stop && request.stop.length > 0) inference['stopSequences'] = [...request.stop];
  if (Object.keys(inference).length > 0) body['inferenceConfig'] = inference;
  // Converse has no way to say "do not use a tool", so 'none' sends no tools at all.
  if (request.tools && request.tools.length > 0 && request.toolChoice !== 'none') {
    const toolConfig: Json = {
      tools: request.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })),
    };
    const choice = request.toolChoice;
    if (choice === 'required') toolConfig['toolChoice'] = { any: {} };
    else if (choice === 'auto') toolConfig['toolChoice'] = { auto: {} };
    else if (choice !== undefined && typeof choice === 'object') toolConfig['toolChoice'] = { tool: { name: choice.name } };
    body['toolConfig'] = toolConfig;
  }
  return body;
}

// ─── Converse: response ──────────────────────────────────────

function finishReason(raw: unknown): ModelResponse['finishReason'] {
  if (raw === 'tool_use') return 'tool_calls';
  if (raw === 'max_tokens' || raw === 'model_context_window_exceeded') return 'length';
  if (raw === 'guardrail_intervened' || raw === 'content_filtered') return 'content_filter';
  return 'stop';
}

function usageOf(u: Json | undefined): ModelResponse['usage'] {
  const prompt = Number(u?.['inputTokens'] ?? 0);
  const completion = Number(u?.['outputTokens'] ?? 0);
  const cacheRead = Number(u?.['cacheReadInputTokens'] ?? 0);
  const cacheWrite = Number(u?.['cacheWriteInputTokens'] ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(u?.['totalTokens'] ?? prompt + completion),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function modelPath(modelId: string, action: string): string {
  // A model id may be an ARN with ":" and "/" in it; the whole id is one path segment.
  return `/model/${encodeURIComponent(modelId)}/${action}`;
}

/** Errors that arrive inside a stream, after the 200. */
function streamFailure(call: AdapterCall, kind: string, payloadText: string): WeaveIntelError {
  let message = '';
  try {
    const body = JSON.parse(payloadText) as Json;
    message = String(body['message'] ?? body['Message'] ?? '');
  } catch {
    /* no readable reason */
  }
  const k = kind.toLowerCase();
  const code = k.includes('throttling') ? 'RATE_LIMITED' : k.includes('timeout') ? 'TIMEOUT' : k.includes('validation') ? 'INVALID_INPUT' : 'PROVIDER_ERROR';
  return new WeaveIntelError({
    code,
    message: `${label(call)} stopped the reply${message ? `: ${message}` : ` (${kind}).`}`,
    provider: call.provider.id,
    retryable: code !== 'INVALID_INPUT',
  });
}

// ─── Embeddings ──────────────────────────────────────────────

type EmbeddingFamily = 'titan' | 'cohere';

function embeddingFamily(call: AdapterCall, modelId: string): EmbeddingFamily {
  if (/titan-embed/i.test(modelId)) return 'titan';
  if (/cohere\.embed/i.test(modelId)) return 'cohere';
  throw invalidConfig(call, `"${modelId}" is not an embedding model this adapter knows how to call on Bedrock (Amazon Titan and Cohere Embed are supported).`);
}

/** Which Bedrock error names mean something other than what the status code says. */
export function bedrockErrorOverride(status: number, headers: Headers, _bodyText: string): WireErrorOverride | undefined {
  const raw = headers.get('x-amzn-errortype');
  if (!raw) return undefined;
  const name = (raw.split(':')[0] ?? '').split('#').pop() ?? '';
  if (/Throttling|ModelNotReady|TooManyRequests|ServiceQuotaExceeded/i.test(name)) return { code: 'RATE_LIMITED', retryable: true };
  if (/ExpiredToken|UnrecognizedClient|InvalidSignature|IncompleteSignature|InvalidClientTokenId|AccessDenied|MissingAuthenticationToken/i.test(name)) {
    return { code: 'AUTH_FAILED', retryable: false };
  }
  if (/ModelTimeout/i.test(name)) return { code: 'TIMEOUT', retryable: true };
  if (/ResourceNotFound/i.test(name)) return { code: 'NOT_FOUND', retryable: false };
  if (/Validation/i.test(name)) return { code: 'INVALID_INPUT', retryable: false };
  if (status === 424 || /ModelError|ServiceUnavailable|InternalServer/i.test(name)) return { code: 'PROVIDER_ERROR', retryable: true };
  return undefined;
}

export function bedrockAdapter(): ProviderAdapter {
  async function post(call: AdapterCall, path: string, body: Json, accept = 'application/json'): Promise<WireRequest> {
    return authorise(call, {
      method: 'POST',
      url: `${runtimeBase(call)}${path}`,
      headers: { ...(call.provider.headers ?? {}), 'content-type': 'application/json', accept },
      body: JSON.stringify(body),
    });
  }

  async function listModels(call: AdapterCall): Promise<readonly DiscoveredModel[]> {
    const res = await call.transport.send(
      await authorise(call, { method: 'GET', url: `${controlBase(call)}/foundation-models`, headers: { ...(call.provider.headers ?? {}), accept: 'application/json' }, body: '' }),
    );
    const body = parseJsonBody<Json>(label(call), res.text);
    const rows = body['modelSummaries'];
    if (!Array.isArray(rows)) throw malformed(label(call), 'the list of models was not in a known shape');
    const out: DiscoveredModel[] = [];
    for (const row of rows as Json[]) {
      const id = row['modelId'];
      if (typeof id !== 'string') continue;
      const outputs = Array.isArray(row['outputModalities']) ? (row['outputModalities'] as unknown[]).map(String) : [];
      const kind: DiscoveredModel['kind'] = outputs.includes('EMBEDDING') ? 'embedding' : outputs.includes('TEXT') ? 'chat' : 'unknown';
      const status = (row['modelLifecycle'] as Json | undefined)?.['status'];
      out.push({
        id,
        kind,
        ...(typeof row['modelName'] === 'string' ? { displayName: `${typeof row['providerName'] === 'string' ? `${row['providerName']} ` : ''}${row['modelName']}` } : {}),
        ...(typeof status === 'string' ? { ready: status === 'ACTIVE' } : {}),
      });
    }
    return out;
  }

  return {
    kind: 'bedrock',
    label: 'AWS Bedrock',
    secretSlots: [
      { name: 'apiKey', label: 'Bedrock API key', required: false },
      { name: 'accessKeyId', label: 'Access key ID', required: false },
      { name: 'secretAccessKey', label: 'Secret access key', required: false },
      { name: 'sessionToken', label: 'Session token (temporary credentials only)', required: false },
    ],

    mapError: bedrockErrorOverride,

    async generate(call, model, request): Promise<ModelResponse> {
      const res = await call.transport.send(await post(call, modelPath(model.id, 'converse'), converseBody(call, model, request)));
      const body = parseJsonBody<Json>(label(call), res.text);
      const message = (body['output'] as Json | undefined)?.['message'] as Json | undefined;
      const blocks = message?.['content'];
      if (!message || !Array.isArray(blocks)) throw malformed(label(call), 'the reply held no message');
      let content = '';
      let reasoning = '';
      const toolCalls: ToolCall[] = [];
      for (const block of blocks as Json[]) {
        if (typeof block['text'] === 'string') content += block['text'];
        const use = block['toolUse'] as Json | undefined;
        if (use) toolCalls.push({ id: String(use['toolUseId'] ?? `call_${toolCalls.length}`), name: String(use['name'] ?? ''), arguments: JSON.stringify(use['input'] ?? {}) });
        const thought = ((block['reasoningContent'] as Json | undefined)?.['reasoningText'] as Json | undefined)?.['text'];
        if (typeof thought === 'string') reasoning += thought;
      }
      return {
        id: res.headers.get('x-amzn-requestid') ?? '',
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason(body['stopReason']),
        usage: usageOf(body['usage'] as Json | undefined),
        model: model.id,
        ...(reasoning !== '' ? { reasoning } : {}),
      };
    },

    async *stream(call, model, request): AsyncIterable<StreamChunk> {
      const res = await call.transport.open(await post(call, modelPath(model.id, 'converse-stream'), converseBody(call, model, request), 'application/vnd.amazon.eventstream'));
      if (!res.body) throw malformed(label(call), 'the stream had no body');
      const decoder = new TextDecoder();
      try {
        for await (const message of readEventStream(res.body)) {
          const type = message.headers[':message-type'];
          const text = decoder.decode(message.payload);
          if (type === 'exception') throw streamFailure(call, message.headers[':exception-type'] ?? 'exception', text);
          if (type === 'error') throw streamFailure(call, message.headers[':error-code'] ?? 'error', JSON.stringify({ message: message.headers[':error-message'] ?? '' }));
          const event = message.headers[':event-type'];
          let payload: Json;
          try {
            payload = JSON.parse(text) as Json;
          } catch {
            throw malformed(label(call), 'a piece of the stream was not JSON');
          }
          if (event === 'contentBlockStart') {
            const use = (payload['start'] as Json | undefined)?.['toolUse'] as Json | undefined;
            if (use) yield { type: 'tool_call', toolCall: { id: String(use['toolUseId'] ?? ''), name: String(use['name'] ?? '') } };
          } else if (event === 'contentBlockDelta') {
            const delta = payload['delta'] as Json | undefined;
            if (typeof delta?.['text'] === 'string' && delta['text'] !== '') yield { type: 'text', text: delta['text'] };
            const input = (delta?.['toolUse'] as Json | undefined)?.['input'];
            if (typeof input === 'string' && input !== '') yield { type: 'tool_call', toolCall: { arguments: input } };
            const thought = (delta?.['reasoningContent'] as Json | undefined)?.['text'];
            if (typeof thought === 'string' && thought !== '') yield { type: 'reasoning', reasoning: thought };
          } else if (event === 'metadata') {
            if (payload['usage']) yield { type: 'usage', usage: usageOf(payload['usage'] as Json) };
          }
        }
      } catch (err) {
        if (err instanceof EventStreamFormatError) throw malformed(label(call), `the stream was damaged: ${err.message}`);
        throw err;
      }
      yield { type: 'done' };
    },

    async embed(call, model, input: AdapterEmbedInput): Promise<AdapterEmbedOutput> {
      const family = embeddingFamily(call, model.id);
      const path = modelPath(model.id, 'invoke');
      if (family === 'titan') {
        // Titan takes one text per request.
        const vectors: number[][] = [];
        let totalTokens = 0;
        for (const text of input.texts) {
          const body: Json = { inputText: text, normalize: true };
          if (input.dimensions !== undefined) body['dimensions'] = input.dimensions;
          const res = await call.transport.send(await post(call, path, body));
          const reply = parseJsonBody<Json>(label(call), res.text);
          const vector = reply['embedding'];
          if (!Array.isArray(vector)) throw malformed(label(call), 'the reply held no vector');
          vectors.push(vector as number[]);
          totalTokens += Number(reply['inputTextTokenCount'] ?? res.headers.get('x-amzn-bedrock-input-token-count') ?? 0);
        }
        return { vectors, totalTokens };
      }
      const body: Json = {
        texts: [...input.texts],
        input_type: input.mode === 'query' ? 'search_query' : 'search_document',
        embedding_types: ['float'],
      };
      if (input.dimensions !== undefined) body['output_dimension'] = input.dimensions;
      const res = await call.transport.send(await post(call, path, body));
      const reply = parseJsonBody<Json>(label(call), res.text);
      const raw = reply['embeddings'];
      const vectors = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as Json)['float'] : undefined;
      if (!Array.isArray(vectors)) throw malformed(label(call), 'the reply held no vectors');
      return { vectors: vectors as number[][], totalTokens: Number(res.headers.get('x-amzn-bedrock-input-token-count') ?? 0) };
    },

    listModels,

    async probe(call): Promise<void> {
      await listModels(call);
    },
  };
}
