// SPDX-License-Identifier: MIT
/**
 * Puts an existing provider package (Anthropic, OpenAI, ...) behind the
 * registry without changing that package.
 *
 * In plain terms: those packages build a model object from a key. Here the key
 * is fetched at the moment of each call, a model object is built for that one
 * call, used, and dropped. So the key is never kept anywhere, a rotated key is
 * picked up by the very next call, and the existing packages keep working
 * exactly as before for anyone who uses them directly.
 */

import { WeaveIntelError, type EmbeddingModel, type Model, type StreamChunk } from '@weaveintel/core';
import { malformed } from '../wire.js';
import type { AdapterCall, DiscoveredModel, ProviderAdapter, SecretSlot } from '../types.js';

export interface WrappedFactoryCredentials {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface WrappedFactoryAdapterOptions {
  readonly kind: string;
  readonly label: string;
  /** Builds the package's chat model for one call. */
  readonly chat?: (modelId: string, credentials: WrappedFactoryCredentials) => Model;
  /** Builds the package's embedding model for one call. */
  readonly embedding?: (modelId: string, credentials: WrappedFactoryCredentials) => EmbeddingModel;
  /** How to list models (and so test the connection) through the registry's own transport. */
  readonly list?: {
    /** Full address used when the provider has no base URL of its own. */
    readonly defaultUrl: string;
    /** Appended to the provider's own base URL when it has one. */
    readonly pathFromBase: string;
    /** Which header carries the key. */
    readonly auth: 'bearer' | 'x-api-key';
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly secretSlots?: readonly SecretSlot[];
}

const API_KEY: SecretSlot = { name: 'apiKey', label: 'API key', required: true };

export function wrappedFactoryAdapter(options: WrappedFactoryAdapterOptions): ProviderAdapter {
  async function credentials(call: AdapterCall): Promise<WrappedFactoryCredentials> {
    const apiKey = await call.secret('apiKey');
    const baseUrl = call.provider.baseUrl;
    // The wrapped package sends the request itself, so the registry's network
    // rule is applied to the address here, before the package is handed it.
    if (baseUrl !== undefined && baseUrl !== '') await call.checkEndpoint(baseUrl);
    return { apiKey, ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}) };
  }

  const adapter: {
    -readonly [K in keyof ProviderAdapter]: ProviderAdapter[K];
  } = {
    kind: options.kind,
    label: options.label,
    secretSlots: options.secretSlots ?? [API_KEY],
  };

  const chat = options.chat;
  if (chat) {
    adapter.generate = async (call, model, request) => chat(model.id, await credentials(call)).generate(call.ctx, request);
    adapter.stream = async function* (call, model, request): AsyncIterable<StreamChunk> {
      const inner = chat(model.id, await credentials(call));
      if (inner.stream) {
        yield* inner.stream(call.ctx, request);
        return;
      }
      const whole = await inner.generate(call.ctx, request);
      if (whole.content !== '') yield { type: 'text', text: whole.content };
      for (const tc of whole.toolCalls ?? []) yield { type: 'tool_call', toolCall: tc };
      yield { type: 'usage', usage: whole.usage };
      yield { type: 'done' };
    };
  }

  const embedding = options.embedding;
  if (embedding) {
    adapter.embed = async (call, model, input) => {
      const out = await embedding(model.id, await credentials(call)).embed(call.ctx, {
        input: [...input.texts],
        ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
      });
      return { vectors: out.embeddings, totalTokens: out.usage.totalTokens };
    };
  }

  const list = options.list;
  if (list) {
    adapter.listModels = async (call): Promise<readonly DiscoveredModel[]> => {
      const key = await call.secret('apiKey');
      const base = call.provider.baseUrl?.replace(/\/+$/, '');
      const res = await call.transport.send({
        method: 'GET',
        url: base ? `${base}${list.pathFromBase}` : list.defaultUrl,
        headers: { ...(list.headers ?? {}), ...(list.auth === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }) },
      });
      let body: { data?: Array<{ id?: unknown; display_name?: unknown }> };
      try {
        body = JSON.parse(res.text) as typeof body;
      } catch {
        throw malformed(call.provider.displayName ?? call.provider.id, 'the list of models was not JSON');
      }
      if (!Array.isArray(body.data)) throw malformed(call.provider.displayName ?? call.provider.id, 'the list of models was not in a known shape');
      const out: DiscoveredModel[] = [];
      for (const row of body.data) {
        if (typeof row.id !== 'string') continue;
        const kind: DiscoveredModel['kind'] = /embed/i.test(row.id) ? 'embedding' : /whisper|tts|dall-e|image|moderation|audio|realtime|transcribe/i.test(row.id) ? 'unknown' : 'chat';
        out.push({ id: row.id, kind, ...(typeof row.display_name === 'string' ? { displayName: row.display_name } : {}) });
      }
      return out;
    };
  }

  if (!chat && !embedding) {
    throw new WeaveIntelError({ code: 'INVALID_CONFIG', message: `The ${options.label} adapter was given neither a chat nor an embedding factory.`, retryable: false });
  }
  return adapter;
}
