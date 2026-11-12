// SPDX-License-Identifier: MIT
/**
 * Google as a provider described by data: the Gemini API (one API key) and
 * Vertex AI (a service-account file, a project and a location).
 *
 * In plain terms: these two adapters plug into `@weaveintel/provider-registry`.
 * They only translate between the library's requests and Google's wire format.
 * They never call the network themselves and never hold a key: the registry
 * hands them a guarded transport and fetches the key at the moment of each
 * call. Chat, streaming, tool use, embeddings, "list models" and "test
 * connection" all work the same way for both.
 *
 * Vertex AI does not accept a pasted key. It accepts a short-lived access
 * token, which this adapter obtains by signing a small statement with the
 * service account's private key (an RS256 JWT, made with `node:crypto`) and
 * exchanging it at Google's token address. The token is kept for its lifetime
 * in the registry's token cache, keyed by a hash of the service-account file,
 * so a rotated file never reuses an old token.
 */

import { createSign } from 'node:crypto';
import { WeaveIntelError, type ModelRequest, type ModelResponse, type StreamChunk } from '@weaveintel/core';
import {
  malformed,
  parseJsonBody,
  sseData,
  type AdapterCall,
  type AdapterEmbedInput,
  type AdapterEmbedOutput,
  type DiscoveredModel,
  type ModelDescription,
  type ProviderAdapter,
  type WireErrorOverride,
  type WireRequest,
} from '@weaveintel/provider-registry';
import {
  buildGeminiRequest,
  buildGeminiToolConfig,
  buildGeminiTools,
  mapFinishReason,
  parseCandidate,
  parseUsage,
  type GeminiContent,
} from './google-format.js';

type Json = Record<string, unknown>;

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_LIFETIME_SECONDS = 3600;

function label(call: AdapterCall): string {
  return call.provider.displayName ?? call.provider.id;
}

function invalid(call: AdapterCall, message: string): WeaveIntelError {
  return new WeaveIntelError({ code: 'INVALID_CONFIG', message, provider: call.provider.id, retryable: false });
}

// ─── The request and reply shapes both Google services share ──

/**
 * The body of a `generateContent` call. Tool results go back as a `user` turn
 * (the documented shape), and several results in a row share one turn.
 */
export function googleChatBody(request: ModelRequest): Json {
  const { contents, systemInstruction } = buildGeminiRequest(request);
  const turns: GeminiContent[] = [];
  for (const turn of contents) {
    const isToolResult = turn.role === 'function';
    const previous = turns[turns.length - 1];
    const previousIsToolResult = previous !== undefined && previous.role === 'user' && previous.parts.every((p) => p.functionResponse !== undefined);
    if (isToolResult && previousIsToolResult) previous.parts.push(...turn.parts);
    else turns.push(isToolResult ? { role: 'user', parts: [...turn.parts] } : turn);
  }

  const generationConfig: Json = {};
  if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
  if (request.topP !== undefined) generationConfig['topP'] = request.topP;
  if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
  if (request.stop && request.stop.length > 0) generationConfig['stopSequences'] = [...request.stop];
  if (request.responseFormat?.type === 'json_schema') {
    generationConfig['responseMimeType'] = 'application/json';
    if (request.responseFormat.schema) generationConfig['responseSchema'] = request.responseFormat.schema;
  } else if (request.responseFormat?.type === 'json_object') {
    generationConfig['responseMimeType'] = 'application/json';
  }

  const body: Json = { contents: turns };
  if (systemInstruction) body['systemInstruction'] = systemInstruction;
  if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
  const tools = buildGeminiTools(request.tools);
  if (tools) {
    body['tools'] = tools;
    const toolConfig = buildGeminiToolConfig(request.toolChoice);
    if (toolConfig) body['toolConfig'] = toolConfig;
  }
  return body;
}

function readReply(call: AdapterCall, model: ModelDescription, text: string): ModelResponse {
  const raw = parseJsonBody<Json>(label(call), text);
  const candidate = (raw['candidates'] as Json[] | undefined)?.[0];
  if (!candidate) {
    const blocked = (raw['promptFeedback'] as Json | undefined)?.['blockReason'];
    if (typeof blocked === 'string') {
      return { id: String(raw['responseId'] ?? ''), content: '', finishReason: 'content_filter', usage: parseUsage(raw), model: model.id };
    }
    throw malformed(label(call), 'the reply held no answer');
  }
  const parsed = parseCandidate(candidate);
  // Google gives tool calls no id; make one that is unique within the reply.
  const toolCalls = parsed.toolCalls.map((tc, i) => ({ ...tc, id: `call_${i}_${tc.name}` }));
  return {
    id: String(raw['responseId'] ?? ''),
    content: parsed.text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(parsed.finishReason),
    usage: parseUsage(raw),
    model: typeof raw['modelVersion'] === 'string' ? raw['modelVersion'] : model.id,
    ...(parsed.reasoning !== '' ? { reasoning: parsed.reasoning } : {}),
  };
}

async function* readStream(call: AdapterCall, body: ReadableStream<Uint8Array> | null): AsyncIterable<StreamChunk> {
  if (!body) throw malformed(label(call), 'the stream had no body');
  let toolIndex = 0;
  let usage: ModelResponse['usage'] | undefined;
  for await (const data of sseData(body)) {
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      throw malformed(label(call), 'a piece of the stream was not JSON');
    }
    const failure = chunk['error'] as Json | undefined;
    if (failure) {
      throw new WeaveIntelError({
        code: 'PROVIDER_ERROR',
        message: `${label(call)} stopped the reply: ${String(failure['message'] ?? 'no reason given')}`,
        provider: call.provider.id,
        retryable: true,
      });
    }
    const candidate = (chunk['candidates'] as Json[] | undefined)?.[0];
    const parsed = parseCandidate(candidate);
    if (parsed.reasoning !== '') yield { type: 'reasoning', reasoning: parsed.reasoning };
    if (parsed.text !== '') yield { type: 'text', text: parsed.text };
    for (const tc of parsed.toolCalls) {
      yield { type: 'tool_call', toolCall: { id: `call_${toolIndex}_${tc.name}`, name: tc.name, arguments: tc.arguments } };
      toolIndex += 1;
    }
    if (chunk['usageMetadata']) usage = parseUsage(chunk);
  }
  if (usage) yield { type: 'usage', usage };
  yield { type: 'done' };
}

/** Google's name for "this text is being stored" and "this text is a question". */
function taskType(mode: AdapterEmbedInput['mode']): string | undefined {
  if (mode === 'document') return 'RETRIEVAL_DOCUMENT';
  if (mode === 'query') return 'RETRIEVAL_QUERY';
  return undefined;
}

function vectorOf(call: AdapterCall, holder: unknown): number[] {
  const values = (holder as Json | undefined)?.['values'];
  if (!Array.isArray(values)) throw malformed(label(call), 'a vector was missing');
  return values as number[];
}

/** One `embedContent` request body. `nested` is the current shape; `top-level` the older one. */
function embedContentBody(call: AdapterCall, text: string, input: AdapterEmbedInput, modelPath?: string): Json {
  const style = call.provider.settings?.['embeddingConfigStyle'] ?? 'nested';
  const config: Json = {};
  const task = taskType(input.mode);
  if (task !== undefined) config['taskType'] = task;
  if (input.dimensions !== undefined) config['outputDimensionality'] = input.dimensions;
  const body: Json = { ...(modelPath !== undefined ? { model: modelPath } : {}), content: { parts: [{ text }] } };
  if (Object.keys(config).length === 0) return body;
  if (style === 'top-level') return { ...body, ...config };
  return { ...body, embedContentConfig: config };
}

// ─── Gemini API ──────────────────────────────────────────────

/**
 * Gemini answers a wrong key with status 400, which would otherwise read as
 * "your request was invalid". This says what it really is.
 */
export function googleErrorOverride(status: number, _headers: Headers, bodyText: string): WireErrorOverride | undefined {
  if (status === 400 && (bodyText.includes('API_KEY_INVALID') || bodyText.includes('API key not valid'))) {
    return { code: 'AUTH_FAILED', message: 'the API key was not accepted', retryable: false };
  }
  // The token exchange: a service-account file Google does not accept.
  if ((status === 400 || status === 401) && (bodyText.includes('invalid_grant') || bodyText.includes('invalid_client'))) {
    return { code: 'AUTH_FAILED', message: 'the service-account file was not accepted', retryable: false };
  }
  if (status === 429 || bodyText.includes('RESOURCE_EXHAUSTED')) return { code: 'RATE_LIMITED', retryable: true };
  return undefined;
}

/** The Gemini API (Google AI Studio): one API key, sent in the `x-goog-api-key` header. */
export function geminiAdapter(): ProviderAdapter {
  const base = (call: AdapterCall): string => (call.provider.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');

  async function headers(call: AdapterCall): Promise<Record<string, string>> {
    return { 'content-type': 'application/json', ...(call.provider.headers ?? {}), 'x-goog-api-key': await call.secret('apiKey') };
  }

  async function post(call: AdapterCall, modelId: string, action: string, body: Json): Promise<WireRequest> {
    return { method: 'POST', url: `${base(call)}/models/${encodeURIComponent(modelId)}:${action}`, headers: await headers(call), body: JSON.stringify(body) };
  }

  async function listModels(call: AdapterCall): Promise<readonly DiscoveredModel[]> {
    const out: DiscoveredModel[] = [];
    let pageToken: string | undefined;
    // A hard stop on pages, so a server that never ends its list cannot loop us.
    for (let page = 0; page < 10; page++) {
      const url = `${base(call)}/models?pageSize=200${pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await call.transport.send({ method: 'GET', url, headers: await headers(call) });
      const body = parseJsonBody<Json>(label(call), res.text);
      const rows = body['models'];
      if (!Array.isArray(rows)) throw malformed(label(call), 'the list of models was not in a known shape');
      for (const row of rows as Json[]) {
        const name = typeof row['name'] === 'string' ? row['name'].replace(/^models\//, '') : '';
        if (name === '') continue;
        const methods = Array.isArray(row['supportedGenerationMethods']) ? (row['supportedGenerationMethods'] as unknown[]).map(String) : [];
        const kind: DiscoveredModel['kind'] = methods.includes('generateContent') ? 'chat' : methods.some((m) => m === 'embedContent' || m === 'batchEmbedContents') ? 'embedding' : 'unknown';
        const context = Number(row['inputTokenLimit'] ?? NaN);
        out.push({
          id: name,
          kind,
          ...(typeof row['displayName'] === 'string' ? { displayName: row['displayName'] } : {}),
          ...(Number.isFinite(context) ? { maxContextTokens: context } : {}),
        });
      }
      pageToken = typeof body['nextPageToken'] === 'string' && body['nextPageToken'] !== '' ? body['nextPageToken'] : undefined;
      if (pageToken === undefined) break;
    }
    return out;
  }

  return {
    kind: 'gemini',
    label: 'Google Gemini',
    secretSlots: [{ name: 'apiKey', label: 'API key', required: true }],
    mapError: googleErrorOverride,

    async generate(call, model, request): Promise<ModelResponse> {
      const res = await call.transport.send(await post(call, model.id, 'generateContent', googleChatBody(request)));
      return readReply(call, model, res.text);
    },

    async *stream(call, model, request): AsyncIterable<StreamChunk> {
      const res = await call.transport.open(await post(call, model.id, 'streamGenerateContent?alt=sse', googleChatBody(request)));
      yield* readStream(call, res.body);
    },

    async embed(call, model, input): Promise<AdapterEmbedOutput> {
      const modelPath = `models/${model.id}`;
      const body = { requests: input.texts.map((text) => embedContentBody(call, text, input, modelPath)) };
      const res = await call.transport.send(await post(call, model.id, 'batchEmbedContents', body));
      const reply = parseJsonBody<Json>(label(call), res.text);
      const rows = reply['embeddings'];
      if (!Array.isArray(rows)) throw malformed(label(call), 'the reply held no vectors');
      const usage = reply['usageMetadata'] as Json | undefined;
      return { vectors: rows.map((r) => vectorOf(call, r)), totalTokens: Number(usage?.['promptTokenCount'] ?? usage?.['totalTokenCount'] ?? 0) };
    },

    listModels,
  };
}

// ─── Vertex AI ───────────────────────────────────────────────

interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string | undefined;
  readonly tokenUrl: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Read the pasted service-account file. Its contents never appear in the error. */
function readServiceAccount(call: AdapterCall, raw: string): ServiceAccount {
  let parsed: Json;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object') throw new Error('not an object');
    parsed = value as Json;
  } catch {
    throw invalid(call, `The service-account file for ${label(call)} could not be read. Paste the whole JSON file exactly as Google supplied it.`);
  }
  const clientEmail = parsed['client_email'];
  const privateKey = parsed['private_key'];
  if (typeof clientEmail !== 'string' || clientEmail === '' || typeof privateKey !== 'string' || privateKey === '') {
    throw invalid(call, `The service-account file for ${label(call)} is missing its account address or its private key.`);
  }
  const tokenUri = parsed['token_uri'];
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof parsed['private_key_id'] === 'string' && parsed['private_key_id'] !== '' ? parsed['private_key_id'] : undefined,
    tokenUrl: typeof tokenUri === 'string' && tokenUri !== '' ? tokenUri : DEFAULT_TOKEN_URL,
  };
}

/** Sign the statement Google exchanges for an access token. Exported for tests. */
export function signServiceAccountAssertion(account: { clientEmail: string; privateKey: string; privateKeyId?: string | undefined; tokenUrl: string }, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(account.privateKeyId !== undefined ? { kid: account.privateKeyId } : {}) };
  const claims = { iss: account.clientEmail, scope: CLOUD_PLATFORM_SCOPE, aud: account.tokenUrl, iat: now, exp: now + TOKEN_LIFETIME_SECONDS };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

/**
 * Vertex AI: Google Cloud's hosted models. Needs `settings.project`, a
 * location in `region` (for example `us-central1`, or `global`), and a
 * service-account file in the `serviceAccount` slot.
 *
 * Settings, all plain data:
 * - `project`: the Google Cloud project id (required).
 * - `publisher`: whose models to call. Default `google`.
 * - `embeddingMethod`: `predict` (default; the `text-embedding-*` and
 *   `gemini-embedding-001` models) or `embedContent` (the newer method, one
 *   text per request).
 */
export function vertexAdapter(): ProviderAdapter {
  function base(call: AdapterCall): string {
    if (call.provider.baseUrl) return call.provider.baseUrl.replace(/\/+$/, '');
    const location = call.provider.region ?? '';
    if (location === '') throw invalid(call, `${label(call)} has no location set (for example "us-central1").`);
    if (!/^[a-z0-9-]+$/.test(location)) throw invalid(call, `${label(call)} has a location that is not a Google Cloud location name.`);
    return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
  }

  function modelUrl(call: AdapterCall, modelId: string, action: string): string {
    const project = call.provider.settings?.['project'] ?? '';
    if (project === '') throw invalid(call, `${label(call)} has no Google Cloud project set.`);
    const location = call.provider.region ?? '';
    if (location === '') throw invalid(call, `${label(call)} has no location set (for example "us-central1").`);
    const publisher = call.provider.settings?.['publisher'] ?? 'google';
    return `${base(call)}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/${encodeURIComponent(publisher)}/models/${encodeURIComponent(modelId)}:${action}`;
  }

  async function accessToken(call: AdapterCall): Promise<string> {
    const raw = await call.secret('serviceAccount');
    const cached = call.tokens.get('accessToken', raw);
    if (cached !== undefined) return cached;
    const account = readServiceAccount(call, raw);
    let assertion: string;
    try {
      assertion = signServiceAccountAssertion(account, Date.now());
    } catch {
      // The reason from the crypto library can quote key material: leave it out.
      throw invalid(call, `The private key in the service-account file for ${label(call)} could not be used to sign a request.`);
    }
    // The signed statement is as good as a key for an hour: keep it out of errors too.
    call.protect(assertion);
    const res = await call.transport.send({
      method: 'POST',
      url: account.tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = parseJsonBody<Json>(label(call), res.text);
    const token = body['access_token'];
    if (typeof token !== 'string' || token === '') throw malformed(label(call), 'the sign-in reply held no access token');
    call.protect(token);
    const lifetime = Number(body['expires_in'] ?? TOKEN_LIFETIME_SECONDS);
    call.tokens.set('accessToken', raw, token, Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : TOKEN_LIFETIME_SECONDS) * 1000);
    return token;
  }

  async function headers(call: AdapterCall): Promise<Record<string, string>> {
    return { 'content-type': 'application/json', ...(call.provider.headers ?? {}), authorization: `Bearer ${await accessToken(call)}` };
  }

  async function post(call: AdapterCall, modelId: string, action: string, body: Json): Promise<WireRequest> {
    // Build the address first, so a missing project is reported before any sign-in is attempted.
    const url = modelUrl(call, modelId, action);
    return { method: 'POST', url, headers: await headers(call), body: JSON.stringify(body) };
  }

  async function listModels(call: AdapterCall): Promise<readonly DiscoveredModel[]> {
    const publisher = call.provider.settings?.['publisher'] ?? 'google';
    const out: DiscoveredModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = `${base(call)}/v1beta1/publishers/${encodeURIComponent(publisher)}/models?pageSize=200${pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await call.transport.send({ method: 'GET', url, headers: await headers(call) });
      const body = parseJsonBody<Json>(label(call), res.text);
      const rows = body['publisherModels'];
      if (!Array.isArray(rows)) throw malformed(label(call), 'the list of models was not in a known shape');
      for (const row of rows as Json[]) {
        const id = typeof row['name'] === 'string' ? (row['name'].split('/').pop() ?? '') : '';
        if (id === '') continue;
        const kind: DiscoveredModel['kind'] = /embed/i.test(id) ? 'embedding' : /gemini|chat|claude|llama|mistral/i.test(id) ? 'chat' : 'unknown';
        out.push({ id, kind });
      }
      pageToken = typeof body['nextPageToken'] === 'string' && body['nextPageToken'] !== '' ? body['nextPageToken'] : undefined;
      if (pageToken === undefined) break;
    }
    return out;
  }

  return {
    kind: 'vertex',
    label: 'Google Vertex AI',
    secretSlots: [{ name: 'serviceAccount', label: 'Service-account file (JSON)', required: true, multiline: true }],
    mapError: googleErrorOverride,

    async generate(call, model, request): Promise<ModelResponse> {
      const res = await call.transport.send(await post(call, model.id, 'generateContent', googleChatBody(request)));
      return readReply(call, model, res.text);
    },

    async *stream(call, model, request): AsyncIterable<StreamChunk> {
      const res = await call.transport.open(await post(call, model.id, 'streamGenerateContent?alt=sse', googleChatBody(request)));
      yield* readStream(call, res.body);
    },

    async embed(call, model, input): Promise<AdapterEmbedOutput> {
      const method = call.provider.settings?.['embeddingMethod'] ?? 'predict';
      if (method === 'embedContent') {
        // This method takes one text at a time.
        const vectors: number[][] = [];
        let totalTokens = 0;
        for (const text of input.texts) {
          const res = await call.transport.send(await post(call, model.id, 'embedContent', embedContentBody(call, text, input)));
          const reply = parseJsonBody<Json>(label(call), res.text);
          vectors.push(vectorOf(call, reply['embedding']));
          totalTokens += Number((reply['usageMetadata'] as Json | undefined)?.['promptTokenCount'] ?? 0);
        }
        return { vectors, totalTokens };
      }
      if (method !== 'predict') throw invalid(call, `${label(call)} names a way of making embeddings this adapter does not know ("${method}").`);
      const task = taskType(input.mode);
      const body: Json = {
        instances: input.texts.map((content) => ({ content, ...(task !== undefined ? { task_type: task } : {}) })),
        ...(input.dimensions !== undefined ? { parameters: { outputDimensionality: input.dimensions } } : {}),
      };
      const res = await call.transport.send(await post(call, model.id, 'predict', body));
      const reply = parseJsonBody<Json>(label(call), res.text);
      const rows = reply['predictions'];
      if (!Array.isArray(rows)) throw malformed(label(call), 'the reply held no vectors');
      let totalTokens = 0;
      const vectors = (rows as Json[]).map((row) => {
        const embeddings = row['embeddings'] as Json | undefined;
        totalTokens += Number((embeddings?.['statistics'] as Json | undefined)?.['token_count'] ?? 0);
        return vectorOf(call, embeddings);
      });
      return { vectors, totalTokens };
    },

    listModels,
  };
}
