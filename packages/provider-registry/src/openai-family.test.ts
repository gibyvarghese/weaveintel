// SPDX-License-Identifier: MIT
/**
 * The shared contract, run against the fake OpenAI-compatible server in each
 * of the shapes the family comes in: plain (Groq, Together, vLLM, …), Azure
 * OpenAI, Azure AI Foundry and Databricks model serving.
 */
import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { FAKE_CHAT_USAGE, FAKE_TOOL_ARGUMENTS, fakeReplyText, startFakeOpenAICompatibleServer } from '@weaveintel/testing';
import { providerContractCases, type ProviderContractOptions } from './contract.js';
import { createProviderRegistry } from './registry.js';
import { openAICompatibleAdapter } from './adapters/openai-compatible.js';
import { OPENAI_COMPATIBLE_PRESETS, azureFoundryAdapter, azureOpenAIAdapter, databricksAdapter } from './adapters/presets.js';
import type { ModelDescription } from './types.js';

const GOOD = 'fk-test-GOOD-3f9a1c77d2e04b58';
const BAD = 'fk-test-WRONG-91b2c3d4e5f60718';

const CHAT: ModelDescription = { id: 'fake-chat', kind: 'chat', capabilities: ['tools'] };
const EMBED: ModelDescription = {
  id: 'fake-embed',
  kind: 'embedding',
  embedding: { nativeDimensions: 8, dimensions: [], reduce: 'none', normalized: false, modes: [] },
};
const expected = { replyTo: fakeReplyText, toolArguments: FAKE_TOOL_ARGUMENTS, usage: FAKE_CHAT_USAGE };
const secrets = { goodSecrets: () => ({ 'vault:key': GOOD }), badSecrets: () => ({ 'vault:key': BAD }) };

const shapes: ProviderContractOptions[] = [
  {
    name: 'openai-compatible',
    adapters: [openAICompatibleAdapter()],
    startFake: () => startFakeOpenAICompatibleServer({ apiKey: GOOD }),
    provider: (fake) => ({ id: 'x', kind: 'openai-compatible', displayName: 'Fake Groq', baseUrl: `${fake.url}/openai/v1`, secrets: { apiKey: 'vault:key' } }),
    chatModel: CHAT,
    embeddingModel: EMBED,
    expected,
    ...secrets,
  },
  {
    name: 'azure-openai',
    adapters: [azureOpenAIAdapter()],
    startFake: () => startFakeOpenAICompatibleServer({ apiKey: GOOD, auth: 'api-key' }),
    provider: (fake) => ({ id: 'x', kind: 'azure-openai', displayName: 'Fake Azure OpenAI', baseUrl: fake.url, secrets: { apiKey: 'vault:key' } }),
    chatModel: CHAT,
    embeddingModel: EMBED,
    expected,
    ...secrets,
  },
  {
    name: 'azure-foundry',
    adapters: [azureFoundryAdapter()],
    startFake: () => startFakeOpenAICompatibleServer({ apiKey: GOOD, auth: 'api-key' }),
    provider: (fake) => ({ id: 'x', kind: 'azure-foundry', displayName: 'Fake Foundry', baseUrl: fake.url, secrets: { apiKey: 'vault:key' } }),
    chatModel: CHAT,
    embeddingModel: EMBED,
    expected,
    streamReportsUsage: false,
    ...secrets,
  },
  {
    name: 'databricks',
    adapters: [databricksAdapter()],
    startFake: () => startFakeOpenAICompatibleServer({ apiKey: GOOD }),
    provider: (fake) => ({ id: 'x', kind: 'databricks', displayName: 'Fake Databricks', baseUrl: fake.url, secrets: { apiKey: 'vault:key' } }),
    chatModel: CHAT,
    embeddingModel: EMBED,
    expected,
    streamReportsUsage: false,
    ...secrets,
  },
];

describe('provider contract: the OpenAI-compatible family', () => {
  for (const shape of shapes) for (const c of providerContractCases(shape)) it(c.name, c.run);
});

describe('quirks are data', () => {
  async function capture(
    adapter = openAICompatibleAdapter(),
    provider: Record<string, unknown> = {},
    fakeOpts: { auth?: 'bearer' | 'api-key' | 'none' } = {},
  ) {
    const fake = await startFakeOpenAICompatibleServer({ apiKey: GOOD, ...fakeOpts });
    const registry = createProviderRegistry({
      adapters: [adapter],
      secrets: { resolve: async () => GOOD },
      privateEndpoints: [{ host: fake.host, port: fake.port }],
      resilience: false,
    });
    const description = { id: `quirk-${Math.random()}`, kind: adapter.kind, baseUrl: fake.url, secrets: { apiKey: 'vault:key' }, ...provider };
    return { fake, registry, description };
  }

  it('Azure OpenAI puts the deployment in the path, the version in the query and the key in an api-key header', async () => {
    const { fake, registry, description } = await capture(azureOpenAIAdapter(), {}, { auth: 'api-key' });
    try {
      await registry.chatModel(description, { id: 'my deployment', kind: 'chat' }).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
      const req = fake.requests[0]!;
      expect(req.path).toBe('/openai/deployments/my%20deployment/chat/completions');
      expect(req.query).toBe('api-version=2024-10-21');
      expect(req.headers['api-key']).toBe(GOOD);
      expect(req.headers['authorization']).toBeUndefined();
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body['model']).toBeUndefined();
      expect(body['max_completion_tokens']).toBe(5);
    } finally {
      await fake.close();
    }
  });

  it('Azure with a Microsoft Entra token sends it as a bearer token instead of the key', async () => {
    const fake = await startFakeOpenAICompatibleServer({ apiKey: 'entra-token-AAAA-0123456789', auth: 'bearer' });
    try {
      const registry = createProviderRegistry({
        adapters: [azureOpenAIAdapter()],
        secrets: { resolve: async (ref) => (ref === 'entra:current' ? 'entra-token-AAAA-0123456789' : undefined) },
        privateEndpoints: [{ host: fake.host, port: fake.port }],
        resilience: false,
      });
      const res = await registry
        .chatModel({ id: 'entra-1', kind: 'azure-openai', baseUrl: fake.url, secrets: { bearerToken: 'entra:current' } }, CHAT)
        .generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] });
      expect(res.content).toBe(fakeReplyText('hi'));
      expect(fake.requests[0]!.headers['api-key']).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('Databricks names the serving endpoint in the path and sends no model field', async () => {
    const { fake, registry, description } = await capture(databricksAdapter());
    try {
      await registry.chatModel(description, { id: 'my-endpoint', kind: 'chat' }).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
      const req = fake.requests[0]!;
      expect(req.path).toBe('/serving-endpoints/my-endpoint/invocations');
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body['model']).toBeUndefined();
      expect(body['max_tokens']).toBe(5);
      const models = await registry.listModels(description);
      expect(models.map((m) => `${m.id}:${m.kind}:${String(m.ready)}`)).toEqual(['fake-chat:chat:true', 'fake-embed:embedding:true']);
    } finally {
      await fake.close();
    }
  });

  it('a provider row can rename the token-limit parameter, drop tool choice and change the paths', async () => {
    const { fake, registry, description } = await capture(openAICompatibleAdapter(), {
      baseUrl: undefined,
      quirks: { tokenLimitParam: 'max_tokens', toolChoice: false, chatPath: '/custom/chat/completions', streamUsage: false },
    });
    try {
      const provider = { ...description, baseUrl: `${fake.url}/root` };
      const model = registry.chatModel(provider, CHAT);
      await model.generate(weaveContext(), {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 9,
        tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'required',
      });
      const first = fake.requests[0]!;
      expect(first.path).toBe('/root/custom/chat/completions');
      const body = JSON.parse(first.body) as Record<string, unknown>;
      expect(body['max_tokens']).toBe(9);
      expect(body['max_completion_tokens']).toBeUndefined();
      expect(body['tool_choice']).toBeUndefined();
      for await (const _ of model.stream!(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })) void _;
      expect((JSON.parse(fake.requests[1]!.body) as Record<string, unknown>)['stream_options']).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('a server with no key (a local one) is called without an authorization header', async () => {
    const { fake, registry, description } = await capture(openAICompatibleAdapter(), { secrets: {}, quirks: { auth: 'none' } }, { auth: 'none' });
    try {
      const res = await registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] });
      expect(res.content).toBe(fakeReplyText('hi'));
      expect(fake.requests[0]!.headers['authorization']).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('a server that cannot list models is tested with its probe address', async () => {
    const tei = OPENAI_COMPATIBLE_PRESETS.find((p) => p.key === 'tei')!;
    const { fake, registry, description } = await capture(openAICompatibleAdapter(), { secrets: {}, quirks: tei.quirks }, { auth: 'none' });
    try {
      const test = await registry.testConnection(description);
      expect(test.ok).toBe(true);
      expect(fake.requests[0]!.path).toBe('/info');
      const vectors = await registry.embeddingModel(description, EMBED).embed(weaveContext(), { input: ['a'] });
      expect(fake.requests[1]!.path).toBe('/v1/embeddings');
      expect(vectors.embeddings[0]).toHaveLength(8);
    } finally {
      await fake.close();
    }
  });

  it('every preset is plain data with a name and an address or a local marker', () => {
    expect(OPENAI_COMPATIBLE_PRESETS.map((p) => p.key)).toEqual(['groq', 'together', 'fireworks', 'mistral', 'openrouter', 'deepseek', 'vllm', 'lmstudio', 'ollama', 'tei']);
    for (const p of OPENAI_COMPATIBLE_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.baseUrl !== '' || p.local).toBe(true);
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    }
  });
});
