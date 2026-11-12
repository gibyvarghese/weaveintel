// SPDX-License-Identifier: MIT
/**
 * The Gemini and Vertex AI adapters, proved against the in-process fake Google
 * server: the shared provider contract first, then what is particular to each.
 *
 * Nothing here reaches Google. The Vertex service account is a key pair made
 * when the test starts and thrown away when it ends.
 */
import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { createProviderRegistry, type ModelDescription, type ProviderDescription, type RegistryEvent } from '@weaveintel/provider-registry';
import { providerContractCases, type ProviderContractOptions } from '@weaveintel/provider-registry/contract';
import { FAKE_CHAT_USAGE, FAKE_TOOL_ARGUMENTS, fakeReplyText, startFakeGoogleServer } from '@weaveintel/testing';
import { geminiAdapter, googleChatBody, vertexAdapter } from './registry-adapters.js';

const GOOD_KEY = 'fk-test-GOOGLE-GOOD-7c1e9a20b4d853f6';
const BAD_KEY = 'fk-test-GOOGLE-WRONG-0a9b8c7d6e5f4a3b';

const CHAT: ModelDescription = { id: 'fake-chat', kind: 'chat', capabilities: ['tools'] };
const GEMINI_EMBED: ModelDescription = {
  id: 'gemini-embedding-001',
  kind: 'embedding',
  embedding: { nativeDimensions: 3072, dimensions: [768, 1536, 3072], reduce: 'provider', normalized: false, batchLimit: 100, modes: ['document', 'query'] },
};
const VERTEX_EMBED: ModelDescription = {
  id: 'text-embedding-005',
  kind: 'embedding',
  embedding: { nativeDimensions: 768, dimensions: [256, 768], reduce: 'provider', normalized: false, batchLimit: 250, modes: ['document', 'query'] },
};
const expected = { replyTo: fakeReplyText, toolArguments: FAKE_TOOL_ARGUMENTS, usage: FAKE_CHAT_USAGE };

// A throwaway service account. Two key pairs: the one the fake trusts and one it does not.
const CLIENT_EMAIL = 'robot@fake-project.iam.gserviceaccount.com';
const trusted = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const untrusted = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

function serviceAccountFile(fakeUrl: string, privateKeyPem: string): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'fake-project',
    private_key_id: 'fake-key-id-1',
    private_key: privateKeyPem,
    client_email: CLIENT_EMAIL,
    token_uri: `${fakeUrl}/token`,
  });
}

const vertexProvider = (fake: { url: string }, extra: Partial<ProviderDescription> = {}): ProviderDescription => ({
  id: 'x',
  kind: 'vertex',
  displayName: 'Fake Vertex',
  baseUrl: fake.url,
  region: 'us-central1',
  settings: { project: 'fake-project' },
  secrets: { serviceAccount: 'vault:sa' },
  ...extra,
});

const shapes: ProviderContractOptions[] = [
  {
    name: 'gemini',
    adapters: [geminiAdapter()],
    startFake: () => startFakeGoogleServer({ apiKey: GOOD_KEY }),
    provider: (fake) => ({ id: 'x', kind: 'gemini', displayName: 'Fake Gemini', baseUrl: `${fake.url}/v1beta`, secrets: { apiKey: 'vault:key' } }),
    goodSecrets: () => ({ 'vault:key': GOOD_KEY }),
    badSecrets: () => ({ 'vault:key': BAD_KEY }),
    chatModel: CHAT,
    embeddingModel: GEMINI_EMBED,
    expected,
  },
  {
    name: 'vertex',
    adapters: [vertexAdapter()],
    startFake: () => startFakeGoogleServer({ serviceAccount: { clientEmail: CLIENT_EMAIL, publicKeyPem: trusted.publicKey } }),
    provider: (fake) => vertexProvider(fake),
    goodSecrets: (fake) => ({ 'vault:sa': serviceAccountFile(fake.url, trusted.privateKey) }),
    badSecrets: (fake) => ({ 'vault:sa': serviceAccountFile(fake.url, untrusted.privateKey) }),
    chatModel: CHAT,
    embeddingModel: VERTEX_EMBED,
    expected,
  },
  {
    // Embeddings alone, so the failure checks run through the embedding path too.
    name: 'vertex embeddings',
    adapters: [vertexAdapter()],
    startFake: () => startFakeGoogleServer({ serviceAccount: { clientEmail: CLIENT_EMAIL, publicKeyPem: trusted.publicKey } }),
    provider: (fake) => vertexProvider(fake),
    goodSecrets: (fake) => ({ 'vault:sa': serviceAccountFile(fake.url, trusted.privateKey) }),
    badSecrets: (fake) => ({ 'vault:sa': serviceAccountFile(fake.url, untrusted.privateKey) }),
    embeddingModel: VERTEX_EMBED,
    expected,
    lists: false,
  },
];

describe('provider contract: Google', () => {
  for (const shape of shapes) for (const c of providerContractCases(shape)) it(c.name, c.run);
});

describe('Gemini specifics', () => {
  async function setup(provider: Partial<ProviderDescription> = {}) {
    const fake = await startFakeGoogleServer({ apiKey: GOOD_KEY });
    const registry = createProviderRegistry({
      adapters: [geminiAdapter()],
      secrets: { resolve: async (ref) => (ref === 'k' ? GOOD_KEY : undefined) },
      privateEndpoints: [{ host: fake.host, port: fake.port }],
      resilience: false,
    });
    const description: ProviderDescription = { id: `gemini-${Math.random()}`, kind: 'gemini', baseUrl: `${fake.url}/v1beta`, secrets: { apiKey: 'k' }, ...provider };
    return { fake, registry, description };
  }

  it('sends the key in a header and never in the address', async () => {
    const { fake, registry, description } = await setup();
    try {
      await registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] });
      const req = fake.requests[0]!;
      expect(req.headers['x-goog-api-key']).toBe(GOOD_KEY);
      expect(req.path).toBe('/v1beta/models/fake-chat:generateContent');
      expect(req.query).toBe('');
    } finally {
      await fake.close();
    }
  });

  it('asks for the size and says whether a text is stored or searched for', async () => {
    const { fake, registry, description } = await setup();
    try {
      const model = registry.embeddingModel(description, GEMINI_EMBED, { dimensions: 768 });
      const stored = await model.embed(weaveContext(), { input: ['kauri', 'rimu'], mode: 'document' });
      expect(stored.embeddings.map((v) => v.length)).toEqual([768, 768]);
      expect(stored.provenance).toMatchObject({ modelId: 'gemini-embedding-001', dimensions: 768, normalizedByRegistry: true });
      expect(stored.usage.totalTokens).toBe(6);
      await model.embed(weaveContext(), { input: ['which tree is tallest?'], mode: 'query' });

      expect(fake.requests.map((r) => r.path)).toEqual(['/v1beta/models/gemini-embedding-001:batchEmbedContents', '/v1beta/models/gemini-embedding-001:batchEmbedContents']);
      const first = JSON.parse(fake.requests[0]!.body) as { requests: Array<Record<string, unknown>> };
      expect(first.requests).toHaveLength(2);
      expect(first.requests[0]).toEqual({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: 'kauri' }] },
        embedContentConfig: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
      });
      const second = JSON.parse(fake.requests[1]!.body) as { requests: Array<Record<string, unknown>> };
      expect(second.requests[0]?.['embedContentConfig']).toEqual({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 });
    } finally {
      await fake.close();
    }
  });

  it('can send the older top-level size field when the provider row says so', async () => {
    const { fake, registry, description } = await setup({ settings: { embeddingConfigStyle: 'top-level' } });
    try {
      const res = await registry.embeddingModel(description, GEMINI_EMBED, { dimensions: 1536 }).embed(weaveContext(), { input: ['kauri'] });
      expect(res.embeddings[0]).toHaveLength(1536);
      const body = JSON.parse(fake.requests[0]!.body) as { requests: Array<Record<string, unknown>> };
      expect(body.requests[0]?.['outputDimensionality']).toBe(1536);
      expect(body.requests[0]?.['embedContentConfig']).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('refuses a vector size the model cannot make before anything is sent', async () => {
    const { fake, registry, description } = await setup();
    try {
      expect(() => registry.embeddingModel(description, GEMINI_EMBED, { dimensions: 512 })).toThrow(/cannot produce vectors of size 512/);
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('says what each listed model is for', async () => {
    const { fake, registry, description } = await setup();
    try {
      const models = await registry.listModels(description);
      expect(models).toEqual([
        { id: 'fake-chat', kind: 'chat', displayName: 'Fake Chat', maxContextTokens: 1000000 },
        { id: 'gemini-embedding-001', kind: 'embedding', displayName: 'Gemini Embedding 001', maxContextTokens: 2048 },
      ]);
    } finally {
      await fake.close();
    }
  });

  it('a wrong key is an authentication failure even though Google answers 400', async () => {
    const fake = await startFakeGoogleServer({ apiKey: GOOD_KEY });
    try {
      const registry = createProviderRegistry({ adapters: [geminiAdapter()], secrets: { resolve: async () => BAD_KEY }, privateEndpoints: [{ host: fake.host, port: fake.port }], resilience: false });
      const description: ProviderDescription = { id: 'gemini-wrong', kind: 'gemini', displayName: 'Fake Gemini', baseUrl: `${fake.url}/v1beta`, secrets: { apiKey: 'k' } };
      const err = (await registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e)) as { code: string; message: string };
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.message).toContain('the API key was not accepted');
      expect(err.message).not.toContain(BAD_KEY);
      const test = await registry.testConnection(description);
      expect(test).toMatchObject({ ok: false, outcome: 'auth_failed' });
    } finally {
      await fake.close();
    }
  });
});

describe('the chat body both Google services share', () => {
  it('sends tool results back as one user turn, system text apart, limits under generationConfig', () => {
    const body = googleChatBody({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather in Wellington and Napier?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_0_get_weather', name: 'get_weather', arguments: '{"city":"Wellington"}' },
            { id: 'call_1_get_weather', name: 'get_weather', arguments: '{"city":"Napier"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call_0_get_weather', name: 'get_weather', content: '{"degrees":14}' },
        { role: 'tool', toolCallId: 'call_1_get_weather', name: 'get_weather', content: '{"degrees":19}' },
      ],
      maxTokens: 50,
      temperature: 0.1,
      stop: ['END'],
    }) as { contents: Array<{ role: string; parts: unknown[] }>; systemInstruction: unknown; generationConfig: unknown; tools?: unknown };
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[2]?.parts).toEqual([
      { functionResponse: { name: 'get_weather', response: { degrees: 14 } } },
      { functionResponse: { name: 'get_weather', response: { degrees: 19 } } },
    ]);
    expect(body.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'Be brief.' }] });
    expect(body.generationConfig).toEqual({ temperature: 0.1, maxOutputTokens: 50, stopSequences: ['END'] });
    expect(body.tools).toBeUndefined();
  });
});

describe('Vertex AI specifics', () => {
  async function setup(provider: Partial<ProviderDescription> = {}, table?: Record<string, string>) {
    const fake = await startFakeGoogleServer({ serviceAccount: { clientEmail: CLIENT_EMAIL, publicKeyPem: trusted.publicKey } });
    const secrets: Record<string, string> = table ?? { 'vault:sa': serviceAccountFile(fake.url, trusted.privateKey) };
    const events: RegistryEvent[] = [];
    const registry = createProviderRegistry({
      adapters: [vertexAdapter()],
      secrets: { resolve: async (ref) => secrets[ref] },
      privateEndpoints: [{ host: fake.host, port: fake.port }],
      onEvent: (e) => events.push(e),
      resilience: false,
    });
    const description = vertexProvider(fake, { id: `vertex-${Math.random()}`, ...provider });
    return { fake, registry, description, secrets, events };
  }
  const hello = { messages: [{ role: 'user' as const, content: 'hi' }] };

  it('signs in once, reuses the access token, and puts project and location in the address', async () => {
    const { fake, registry, description } = await setup();
    try {
      const model = registry.chatModel(description, CHAT);
      await model.generate(weaveContext(), hello);
      await model.generate(weaveContext(), hello);
      expect(fake.requests.map((r) => r.path)).toEqual([
        '/token',
        '/v1/projects/fake-project/locations/us-central1/publishers/google/models/fake-chat:generateContent',
        '/v1/projects/fake-project/locations/us-central1/publishers/google/models/fake-chat:generateContent',
      ]);
      expect(fake.issuedTokens).toHaveLength(1);
      expect(fake.requests[1]!.headers['authorization']).toBe(`Bearer ${fake.issuedTokens[0]}`);
      expect(fake.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    } finally {
      await fake.close();
    }
  });

  it('a replaced service-account file signs in again instead of reusing the old token', async () => {
    const { fake, registry, description, secrets } = await setup();
    try {
      const model = registry.chatModel(description, CHAT);
      await model.generate(weaveContext(), hello);
      // The operator pastes a new file (same account, a new key id): the next call must not use the old token.
      secrets['vault:sa'] = JSON.stringify({ ...(JSON.parse(secrets['vault:sa']!) as object), private_key_id: 'fake-key-id-2' });
      await model.generate(weaveContext(), hello);
      expect(fake.issuedTokens).toHaveLength(2);
      expect(fake.requests[3]!.headers['authorization']).toBe(`Bearer ${fake.issuedTokens[1]}`);
    } finally {
      await fake.close();
    }
  });

  it('embeds through predict by default, with the size and the kind of text', async () => {
    const { fake, registry, description } = await setup();
    try {
      const res = await registry.embeddingModel(description, VERTEX_EMBED, { dimensions: 256 }).embed(weaveContext(), { input: ['kauri', 'rimu'], mode: 'query' });
      expect(res.embeddings.map((v) => v.length)).toEqual([256, 256]);
      expect(res.usage.totalTokens).toBe(6);
      const req = fake.requests[1]!;
      expect(req.path).toBe('/v1/projects/fake-project/locations/us-central1/publishers/google/models/text-embedding-005:predict');
      expect(JSON.parse(req.body)).toEqual({
        instances: [
          { content: 'kauri', task_type: 'RETRIEVAL_QUERY' },
          { content: 'rimu', task_type: 'RETRIEVAL_QUERY' },
        ],
        parameters: { outputDimensionality: 256 },
      });
    } finally {
      await fake.close();
    }
  });

  it('embeds one text per request when the provider row names the embedContent method', async () => {
    const { fake, registry, description } = await setup({ settings: { project: 'fake-project', embeddingMethod: 'embedContent' } });
    try {
      const model: ModelDescription = { id: 'gemini-embedding-2', kind: 'embedding', embedding: { nativeDimensions: 3072, dimensions: [768, 3072], reduce: 'provider', normalized: false, modes: [] } };
      const res = await registry.embeddingModel(description, model, { dimensions: 768 }).embed(weaveContext(), { input: ['kauri', 'rimu'] });
      expect(res.embeddings.map((v) => v.length)).toEqual([768, 768]);
      expect(res.usage.totalTokens).toBe(6);
      expect(fake.requests.map((r) => r.path.split(':').pop())).toEqual(['/token', 'embedContent', 'embedContent']);
      expect(JSON.parse(fake.requests[1]!.body)).toEqual({ content: { parts: [{ text: 'kauri' }] }, embedContentConfig: { outputDimensionality: 768 } });
    } finally {
      await fake.close();
    }
  });

  it('with no project or no location it says so and sends nothing, not even a sign-in', async () => {
    const { fake, registry, description } = await setup({ settings: {} });
    try {
      await expect(registry.chatModel(description, CHAT).generate(weaveContext(), hello)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('no Google Cloud project') as unknown });
      const { region: _region, baseUrl: _baseUrl, ...noPlace } = description;
      await expect(registry.chatModel({ ...noPlace, settings: { project: 'fake-project' } }, CHAT).generate(weaveContext(), hello)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('no location') as unknown });
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('a pasted file that is not a service-account file is refused without repeating it', async () => {
    const garbage = 'not-json-fk-test-PASTED-BY-MISTAKE-55aa66bb77cc';
    const noKey = JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL });
    const brokenKey = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\nfk-test-NOT-A-REAL-KEY-0123456789abcdef\n-----END PRIVATE KEY-----\n', token_uri: 'http://127.0.0.1:1/token' });
    for (const [file, words] of [[garbage, 'could not be read'], [noKey, 'missing its account address or its private key'], [brokenKey, 'could not be used to sign']] as const) {
      const { fake, registry, description, events } = await setup({}, { 'vault:sa': file });
      try {
        const err = (await registry.chatModel(description, CHAT).generate(weaveContext(), hello).catch((e: unknown) => e)) as { code: string; message: string };
        expect(err.code).toBe('INVALID_CONFIG');
        expect(err.message).toContain(words);
        const seen = `${inspect(err, { depth: 6, showHidden: true })}\n${JSON.stringify(events)}`;
        expect(seen).not.toContain('PASTED-BY-MISTAKE');
        expect(seen).not.toContain('NOT-A-REAL-KEY');
        expect(fake.requests).toHaveLength(0);
      } finally {
        await fake.close();
      }
    }
  });

  it('keeps the private key, the signed statement and the access token out of errors and events', async () => {
    const { fake, registry, description, secrets, events } = await setup();
    try {
      const model = registry.chatModel(description, CHAT);
      await model.generate(weaveContext(), hello);
      const failures: unknown[] = [];
      for (const mode of ['server_error', 'rate_limit', 'malformed'] as const) {
        fake.setMode(mode, { times: 1 });
        failures.push(await model.generate(weaveContext(), hello).catch((e: unknown) => e));
      }
      // And a failed sign-in: a file whose key the fake does not trust.
      secrets['vault:sa'] = serviceAccountFile(fake.url, untrusted.privateKey);
      failures.push(await model.generate(weaveContext(), hello).catch((e: unknown) => e));
      expect(failures.map((f) => (f as { code: string }).code)).toEqual(['PROVIDER_ERROR', 'RATE_LIMITED', 'PROTOCOL_ERROR', 'AUTH_FAILED']);

      const seen = `${failures.map((f) => inspect(f, { depth: 8, showHidden: true })).join('\n')}\n${JSON.stringify(events)}\n${inspect(model, { depth: 8, showHidden: true })}`;
      const assertions = fake.requests.filter((r) => r.path === '/token').map((r) => new URLSearchParams(r.body).get('assertion') ?? '');
      expect(assertions).toHaveLength(2);
      const keyLines = [...trusted.privateKey.split('\n'), ...untrusted.privateKey.split('\n')].filter((l) => l.length > 20 && !l.startsWith('-----'));
      expect(keyLines.length).toBeGreaterThan(10);
      for (const secret of [...keyLines, ...assertions, ...fake.issuedTokens, CLIENT_EMAIL]) {
        expect(seen.includes(secret), `a secret value appeared: ${secret.slice(0, 12)}…`).toBe(false);
      }
    } finally {
      await fake.close();
    }
  });

  it('lists the publisher models and passes a connection test', async () => {
    const { fake, registry, description } = await setup();
    try {
      expect(await registry.listModels(description)).toEqual([
        { id: 'fake-chat', kind: 'chat' },
        { id: 'text-embedding-005', kind: 'embedding' },
      ]);
      const test = await registry.testConnection(description);
      expect(test).toMatchObject({ ok: true, outcome: 'ok', modelCount: 2 });
      expect(fake.requests.filter((r) => r.path === '/token')).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it('is refused on a private address the operator has not allowed, before any sign-in', async () => {
    const fake = await startFakeGoogleServer({ serviceAccount: { clientEmail: CLIENT_EMAIL, publicKeyPem: trusted.publicKey } });
    try {
      const registry = createProviderRegistry({ adapters: [vertexAdapter()], secrets: { resolve: async () => serviceAccountFile(fake.url, trusted.privateKey) }, privateEndpoints: [], resilience: false });
      const err = (await registry.chatModel(vertexProvider(fake, { id: 'vertex-private' }), CHAT).generate(weaveContext(), hello).catch((e: unknown) => e)) as { code: string };
      expect(err.code).toBe('POLICY_DENIED');
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});
