// SPDX-License-Identifier: MIT
/**
 * The contract every provider adapter must pass.
 *
 * In plain terms: this is one list of checks ("answers a question", "streams",
 * "calls a tool", "says slow down properly", "rejects a wrong key", "gives up
 * when nothing answers", "copes with garbage") that is run, unchanged, against
 * each adapter talking to a fake server in that provider's wire format. An
 * adapter that passes behaves like every other adapter from the caller's side.
 *
 * It returns plain named checks and uses `node:assert`, so any test runner can
 * run it: `for (const c of providerContractCases(opts)) it(c.name, c.run)`.
 */

import assert from 'node:assert/strict';
import { WeaveIntelError, weaveContext, type SecretResolver, type StreamChunk, type ToolCall, type ToolDefinition } from '@weaveintel/core';
import { createProviderRegistry, type ProviderRegistry } from './registry.js';
import type { ModelDescription, ProviderAdapter, ProviderDescription, RegistryEvent } from './types.js';

/** What the contract needs from a fake server. The fakes in `@weaveintel/testing` fit. */
export interface ContractFakeServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly requests: ReadonlyArray<{ readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }>;
  setMode(mode: 'ok' | 'rate_limit' | 'server_error' | 'hang' | 'malformed', opts?: { times?: number; retryAfterSeconds?: number }): void;
  close(): Promise<void>;
}

export interface ProviderContractOptions {
  /** Shown in test names. */
  readonly name: string;
  /** The adapter(s) under test; the first is the one the provider description names. */
  readonly adapters: readonly ProviderAdapter[];
  /** Start a fresh fake server for one check. */
  readonly startFake: () => Promise<ContractFakeServer>;
  /** The provider description pointing at that server. `id` is overwritten per check. */
  readonly provider: (fake: ContractFakeServer) => ProviderDescription;
  /** Secret reference → value, for a key the fake accepts. */
  readonly goodSecrets: (fake: ContractFakeServer) => Readonly<Record<string, string>>;
  /** Secret reference → value, for a key the fake rejects. */
  readonly badSecrets: (fake: ContractFakeServer) => Readonly<Record<string, string>>;
  readonly chatModel?: ModelDescription;
  readonly embeddingModel?: ModelDescription;
  /** What the fake's canned replies are, so the checks can compare. */
  readonly expected: {
    readonly replyTo: (userText: string) => string;
    readonly toolArguments: string;
    readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  };
  /** Set false when the provider's stream carries no token counts. Default true. */
  readonly streamReportsUsage?: boolean;
  /** Set false for adapters that cannot stream or list. Default true. */
  readonly streams?: boolean;
  readonly lists?: boolean;
}

export interface ContractCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

const WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Look up the weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

/** Put streamed tool-call fragments back together the way a caller would. */
export function collectStream(chunks: readonly StreamChunk[]): { text: string; toolCalls: ToolCall[]; done: boolean; usage?: StreamChunk['usage'] } {
  let text = '';
  let done = false;
  let usage: StreamChunk['usage'];
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const chunk of chunks) {
    if (chunk.type === 'text') text += chunk.text ?? '';
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'done') done = true;
    else if (chunk.type === 'tool_call' && chunk.toolCall) {
      const part = chunk.toolCall;
      if (part.id !== undefined || toolCalls.length === 0) toolCalls.push({ id: part.id ?? '', name: part.name ?? '', arguments: part.arguments ?? '' });
      else {
        const last = toolCalls[toolCalls.length - 1]!;
        if (part.name) last.name = part.name;
        last.arguments += part.arguments ?? '';
      }
    }
  }
  return { text, toolCalls, done, ...(usage !== undefined ? { usage } : {}) };
}

let counter = 0;

async function rejected(promise: Promise<unknown>): Promise<WeaveIntelError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WeaveIntelError, `expected a WeaveIntelError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to fail, but it succeeded');
}

export function providerContractCases(options: ProviderContractOptions): ContractCase[] {
  const cases: ContractCase[] = [];
  const add = (name: string, body: (h: Harness) => Promise<void>, secrets: 'good' | 'bad' = 'good', timeoutMs?: number): void => {
    cases.push({
      name: `${options.name}: ${name}`,
      run: async () => {
        const fake = await options.startFake();
        try {
          const table = secrets === 'good' ? options.goodSecrets(fake) : options.badSecrets(fake);
          const resolver: SecretResolver = { resolve: async (key) => table[key] };
          const events: RegistryEvent[] = [];
          const registry = createProviderRegistry({
            adapters: options.adapters,
            secrets: resolver,
            privateEndpoints: [{ host: fake.host, port: fake.port }],
            onEvent: (e) => events.push(e),
            // One attempt, so a failure reaches the caller exactly as the provider sent it.
            resilience: { retry: { maxAttempts: 1 } },
          });
          counter += 1;
          const provider: ProviderDescription = { ...options.provider(fake), id: `contract-${counter}-${Date.now()}`, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
          await body({ fake, registry, provider, events, secretValues: Object.values(table) });
        } finally {
          await fake.close();
        }
      },
    });
  };

  const chat = options.chatModel;
  const embedding = options.embeddingModel;
  const ask = (text: string) => ({ messages: [{ role: 'user' as const, content: text }], maxTokens: 64 });

  /** One call of whatever kind this adapter offers, for the failure checks. */
  const anyCall = (h: Harness): Promise<unknown> => {
    const ctx = weaveContext();
    if (chat) return h.registry.chatModel(h.provider, chat).generate(ctx, ask('Hello'));
    if (embedding) return h.registry.embeddingModel(h.provider, embedding).embed(ctx, { input: ['Hello'] });
    return h.registry.listModels(h.provider, ctx);
  };

  if (chat) {
    add('answers a question', async (h) => {
      const res = await h.registry.chatModel(h.provider, chat).generate(weaveContext(), ask('What is a kauri?'));
      assert.equal(res.content, options.expected.replyTo('What is a kauri?'));
      assert.equal(res.finishReason, 'stop');
      assert.equal(res.usage.promptTokens, options.expected.usage.promptTokens);
      assert.equal(res.usage.completionTokens, options.expected.usage.completionTokens);
      assert.deepEqual(h.events.map((e) => `${e.kind}:${e.operation}`), ['call:generate']);
    });

    add('asks for a tool call', async (h) => {
      const res = await h.registry.chatModel(h.provider, chat).generate(weaveContext(), { ...ask('Weather in Wellington?'), tools: [WEATHER_TOOL] });
      assert.equal(res.finishReason, 'tool_calls');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.name, 'get_weather');
      assert.deepEqual(JSON.parse(res.toolCalls?.[0]?.arguments ?? 'null'), JSON.parse(options.expected.toolArguments));
      assert.ok((res.toolCalls?.[0]?.id ?? '') !== '');
    });

    add('accepts a tool result and answers', async (h) => {
      const res = await h.registry.chatModel(h.provider, chat).generate(weaveContext(), {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Weather in Wellington?' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Wellington"}' }] },
          { role: 'tool', toolCallId: 'call_1', name: 'get_weather', content: '{"degrees":14}' },
        ],
        tools: [WEATHER_TOOL],
        maxTokens: 64,
      });
      assert.equal(res.finishReason, 'stop');
      assert.equal(res.content, options.expected.replyTo('Weather in Wellington?'));
    });

    if (options.streams !== false) {
      add('streams an answer', async (h) => {
        const model = h.registry.chatModel(h.provider, chat);
        assert.ok(model.stream, 'the model offers streaming');
        const chunks: StreamChunk[] = [];
        for await (const c of model.stream(weaveContext(), ask('Tell me about rimu.'))) chunks.push(c);
        const got = collectStream(chunks);
        assert.equal(got.text, options.expected.replyTo('Tell me about rimu.'));
        assert.ok(chunks.filter((c) => c.type === 'text').length >= 2, 'the text arrived in more than one piece');
        assert.equal(got.done, true);
        assert.equal(chunks[chunks.length - 1]?.type, 'done');
        if (options.streamReportsUsage !== false) assert.equal(got.usage?.promptTokens, options.expected.usage.promptTokens);
        assert.deepEqual(h.events.map((e) => `${e.kind}:${e.operation}`), ['call:stream']);
      });

      add('streams a tool call', async (h) => {
        const model = h.registry.chatModel(h.provider, chat);
        const chunks: StreamChunk[] = [];
        for await (const c of model.stream!(weaveContext(), { ...ask('Weather in Wellington?'), tools: [WEATHER_TOOL] })) chunks.push(c);
        const got = collectStream(chunks);
        assert.equal(got.toolCalls.length, 1);
        assert.equal(got.toolCalls[0]?.name, 'get_weather');
        assert.deepEqual(JSON.parse(got.toolCalls[0]?.arguments || '{}'), JSON.parse(options.expected.toolArguments));
        assert.equal(got.done, true);
      });
    }
  }

  if (embedding) {
    add('returns unit-length vectors and says which model made them', async (h) => {
      const model = h.registry.embeddingModel(h.provider, embedding);
      const res = await model.embed(weaveContext(), { input: ['kauri', 'rimu', 'totara'] });
      assert.equal(res.embeddings.length, 3);
      for (const v of res.embeddings) {
        assert.equal(v.length, model.dimensions);
        assert.ok(Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) < 1e-6, 'unit length');
      }
      assert.notDeepEqual(res.embeddings[0], res.embeddings[1]);
      assert.equal(res.provenance.providerId, h.provider.id);
      assert.equal(res.provenance.modelId, embedding.id);
      assert.equal(res.provenance.dimensions, model.dimensions);
      assert.ok(res.usage.totalTokens >= 0);
    });
  }

  if (options.lists !== false) {
    add('lists its models and passes a connection test', async (h) => {
      const models = await h.registry.listModels(h.provider);
      assert.ok(models.length >= 1);
      for (const m of models) assert.ok(m.id !== '');
      const test = await h.registry.testConnection(h.provider);
      assert.equal(test.ok, true, test.message);
      assert.equal(test.outcome, 'ok');
    });
  }

  add('reports "slow down" with the wait the provider asked for', async (h) => {
    h.fake.setMode('rate_limit', { retryAfterSeconds: 7 });
    const err = await rejected(anyCall(h));
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 7000);
    assert.equal(h.events[h.events.length - 1]?.errorCode, 'RATE_LIMITED');
  });

  add(
    'reports a rejected key as an authentication failure, without the key',
    async (h) => {
      const err = await rejected(anyCall(h));
      assert.equal(err.code, 'AUTH_FAILED', err.message);
      assert.equal(err.retryable, false);
      const haystack = JSON.stringify({ message: err.message, details: err.details, stack: err.stack, events: h.events });
      for (const secret of h.secretValues) assert.ok(!haystack.includes(secret), 'the rejected key does not appear in the error or the events');
      const test = await h.registry.testConnection(h.provider);
      assert.equal(test.ok, false);
      if (options.lists !== false) assert.equal(test.outcome, 'auth_failed', test.message);
      for (const secret of h.secretValues) assert.ok(!test.message.includes(secret));
    },
    'bad',
  );

  add(
    'gives up with a timeout when nothing answers',
    async (h) => {
      h.fake.setMode('hang');
      const started = Date.now();
      const err = await rejected(anyCall(h));
      assert.equal(err.code, 'TIMEOUT', err.message);
      assert.equal(err.retryable, true);
      assert.ok(Date.now() - started < 5000, 'gave up promptly');
    },
    'good',
    300,
  );

  add('reports a reply that is not the promised format', async (h) => {
    h.fake.setMode('malformed');
    const err = await rejected(anyCall(h));
    assert.equal(err.code, 'PROTOCOL_ERROR', err.message);
    assert.equal(err.retryable, false);
  });

  add('reports a server failure as retryable', async (h) => {
    h.fake.setMode('server_error');
    const err = await rejected(anyCall(h));
    assert.equal(err.code, 'PROVIDER_ERROR', err.message);
    assert.equal(err.retryable, true);
  });

  return cases;
}

interface Harness {
  readonly fake: ContractFakeServer;
  readonly registry: ProviderRegistry;
  readonly provider: ProviderDescription;
  readonly events: RegistryEvent[];
  readonly secretValues: readonly string[];
}
