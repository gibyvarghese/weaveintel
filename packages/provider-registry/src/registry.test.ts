// SPDX-License-Identifier: MIT
/**
 * What the registry promises regardless of provider: keys stay out of sight,
 * private addresses stay closed unless an operator opens one, embeddings are
 * sized and normalised, and failures are retried or reported plainly.
 */
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeaveIntelError, weaveContext, type Model } from '@weaveintel/core';
import { getDefaultSignalBus, _resetEndpointRegistry } from '@weaveintel/resilience';
import { fakeReplyText, fakeVector, startFakeBedrockServer, startFakeOpenAICompatibleServer, type FakeProviderServer } from '@weaveintel/testing';
import { policyFor } from './_fetch.js';
import { createProviderRegistry } from './registry.js';
import { SecretScrubber } from './scrub.js';
import { isUnitLength, normalizeVector, truncateVector } from './vectors.js';
import { openAICompatibleAdapter } from './adapters/openai-compatible.js';
import { bedrockAdapter } from './adapters/bedrock/bedrock.js';
import { wrappedFactoryAdapter } from './adapters/wrapped.js';
import type { ModelDescription, PrivateEndpointAllowance, ProviderDescription, RegistryEvent } from './types.js';

const KEY = 'fk-registry-GOOD-5d8e2b7a41c93f06';
const CHAT: ModelDescription = { id: 'fake-chat', kind: 'chat' };
const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };
const length = (v: readonly number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

let fakes: FakeProviderServer[] = [];
let n = 0;
async function fake(opts: Partial<Parameters<typeof startFakeOpenAICompatibleServer>[0]> = {}): Promise<FakeProviderServer> {
  const f = await startFakeOpenAICompatibleServer({ apiKey: KEY, ...opts });
  fakes.push(f);
  return f;
}
function describeProvider(f: FakeProviderServer, extra: Partial<ProviderDescription> = {}): ProviderDescription {
  n += 1;
  return { id: `p-${n}-${Date.now()}`, kind: 'openai-compatible', displayName: 'Test provider', baseUrl: f.url, secrets: { apiKey: 'vault:key' }, ...extra };
}
function registryFor(f: FakeProviderServer, extra: Partial<Parameters<typeof createProviderRegistry>[0]> = {}) {
  return createProviderRegistry({
    adapters: [openAICompatibleAdapter()],
    secrets: { resolve: async () => KEY },
    privateEndpoints: [{ host: f.host, port: f.port }],
    resilience: false,
    ...extra,
  });
}

beforeEach(() => {
  _resetEndpointRegistry();
});
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

describe('keys', () => {
  it('nothing the registry hands out, logs or reports contains a key', async () => {
    const good = 'fk-leak-GOOD-a1b2c3d4e5f60718293a';
    const rejected = 'fk-leak-REJECTED-9f8e7d6c5b4a39281706';
    const awsId = 'FAKEACCESSKEYID00002';
    const awsSecret = 'fk-leak-aws-secret-Hy6Tg4Rf2Ed0Ws8Qa';
    const awsWrongSecret = 'fk-leak-aws-WRONG-Mn1Bv3Cx5Zl7Kj9Hg';
    const awsSession = 'fk-leak-aws-session-Pl0Ok9Ij8Uh7Yg6Tf5';
    const secrets = [good, rejected, awsSecret, awsWrongSecret, awsSession];

    // Capture every channel a key could escape through.
    const captured: string[] = [];
    const keep = (...args: unknown[]): void => void captured.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 12, showHidden: true }))).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation(keep));
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stdout.write);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stderr.write);
    const offBus = getDefaultSignalBus().on((signal) => keep('signal', signal));
    const events: RegistryEvent[] = [];
    const errors: unknown[] = [];
    const models: unknown[] = [];

    try {
      const openai = await fake({ apiKey: good });
      const bedrock = await startFakeBedrockServer({ accessKeyId: awsId, secretAccessKey: awsSecret, sessionToken: awsSession });
      fakes.push(bedrock);
      let table: Record<string, string> = { 'vault:key': good, 'vault:akid': awsId, 'vault:secret': awsSecret, 'vault:session': awsSession };
      const registry = createProviderRegistry({
        adapters: [openAICompatibleAdapter(), bedrockAdapter()],
        secrets: { resolve: async (ref) => table[ref] },
        privateEndpoints: [{ host: openai.host, port: openai.port }, { host: bedrock.host, port: bedrock.port }],
        onEvent: (e) => events.push(e),
        // The breaker is kept out of the way so every failure below really reaches the server.
        resilience: { retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 }, circuit: { failureThreshold: 1000 } },
      });
      const p1 = describeProvider(openai);
      const p2: ProviderDescription = { id: `leak-bedrock-${Date.now()}`, kind: 'bedrock', region: 'us-east-1', baseUrl: bedrock.url, secrets: { accessKeyId: 'vault:akid', secretAccessKey: 'vault:secret', sessionToken: 'vault:session' } };
      const chat1 = registry.chatModel(p1, CHAT);
      const chat2 = registry.chatModel(p2, { id: 'fake.chat-v1:0', kind: 'chat' });
      models.push(chat1, chat2, registry);

      const attempt = async (job: () => Promise<unknown>): Promise<void> => {
        try {
          await job();
        } catch (err) {
          errors.push(err);
        }
      };
      const drain = async (m: Model): Promise<void> => {
        for await (const c of m.stream!(weaveContext(), ask)) void c;
      };

      // Working calls.
      await attempt(() => chat1.generate(weaveContext(), ask));
      await attempt(() => chat2.generate(weaveContext(), ask));
      await attempt(() => drain(chat1));
      // Every failure mode, on both providers.
      for (const mode of ['rate_limit', 'server_error', 'malformed'] as const) {
        openai.setMode(mode, { retryAfterSeconds: 0 });
        bedrock.setMode(mode, { retryAfterSeconds: 0 });
        await attempt(() => chat1.generate(weaveContext(), ask));
        await attempt(() => chat2.generate(weaveContext(), ask));
        await attempt(() => drain(chat1));
        await attempt(() => drain(chat2));
        openai.setMode('ok');
        bedrock.setMode('ok');
      }
      // A rejected key: the fake quotes it back in its error, as some real servers do.
      table = { ...table, 'vault:key': rejected, 'vault:secret': awsWrongSecret };
      await attempt(() => chat1.generate(weaveContext(), ask));
      await attempt(() => chat2.generate(weaveContext(), ask));
      await attempt(() => drain(chat1));
      await attempt(() => drain(chat2));
      await attempt(() => registry.listModels(p1));
      const tests = [await registry.testConnection(p1), await registry.testConnection(p2)];
      // An address the guard refuses, with the key in play.
      await attempt(() => registry.chatModel({ ...p1, id: 'leak-blocked', baseUrl: 'http://127.0.0.1:9' }, CHAT).generate(weaveContext(), ask));

      expect(errors.length).toBeGreaterThanOrEqual(14);
      expect(errors.every((e) => e instanceof WeaveIntelError)).toBe(true);
      // The fake really did quote the rejected key back, so the scrubber had something to remove.
      expect(errors.some((e) => (e as WeaveIntelError).message.includes('[secret removed]'))).toBe(true);

      const haystack = [
        ...captured,
        JSON.stringify(events),
        JSON.stringify(tests),
        ...errors.map((e) => inspect(e, { depth: 12, showHidden: true })),
        ...errors.map((e) => `${(e as Error).message}\n${(e as Error).stack ?? ''}\n${JSON.stringify((e as WeaveIntelError).details ?? {})}\n${inspect((e as Error).cause, { depth: 12 })}`),
        ...models.map((m) => inspect(m, { depth: 12, showHidden: true })),
        ...models.map((m) => JSON.stringify(m)),
      ].join('\n');
      for (const secret of secrets) {
        expect(haystack.includes(secret), `a key was found in captured output`).toBe(false);
        expect(haystack.includes(encodeURIComponent(secret))).toBe(false);
        expect(haystack.includes(Buffer.from(secret).toString('base64'))).toBe(false);
      }
      // The servers did receive the keys, so the search above is not vacuous.
      expect(openai.requests.some((r) => r.headers['authorization'] === `Bearer ${good}`)).toBe(true);
      expect(openai.requests.some((r) => r.headers['authorization'] === `Bearer ${rejected}`)).toBe(true);
      expect(bedrock.requests.some((r) => r.headers['x-amz-security-token'] === awsSession)).toBe(true);
      expect(events.length).toBeGreaterThan(10);
    } finally {
      offBus();
      for (const s of spies) s.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('a rotated key is used by the very next call on the same model object', async () => {
    const f = await fake();
    let current = KEY;
    const registry = registryFor(f, { secrets: { resolve: async () => current } });
    const model = registry.chatModel(describeProvider(f), CHAT);
    expect((await model.generate(weaveContext(), ask)).content).toBe(fakeReplyText('hi'));

    const rotated = 'fk-registry-ROTATED-0c1d2e3f4a5b6978';
    f.setKey(rotated);
    await expect(model.generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    current = rotated;
    expect((await model.generate(weaveContext(), ask)).content).toBe(fakeReplyText('hi'));
    expect(f.requests.map((r) => r.headers['authorization'])).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${rotated}`]);
  });

  it('a missing key is named by its slot and nothing is sent', async () => {
    const f = await fake();
    const registry = registryFor(f, { secrets: { resolve: async () => undefined } });
    const err = (await registry.chatModel(describeProvider(f), CHAT).generate(weaveContext(), ask).catch((e: unknown) => e)) as WeaveIntelError;
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toBe('No API key has been set for Test provider.');
    expect(err.details).toEqual({ missingSecret: 'apiKey' });
    expect(f.requests).toHaveLength(0);
  });

  it('the scrubber removes a key in the forms it travels in, and the lines of a multi-line secret', () => {
    const s = new SecretScrubber();
    const key = 'abc/def+ghi=jkl mno';
    s.add(key);
    expect(s.text(`x ${key} y ${encodeURIComponent(key)} z ${Buffer.from(key).toString('base64')}`)).toBe('x [secret removed] y [secret removed] z [secret removed]');
    const file = JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIfakefakefakefakefake1\nMIIfakefakefakefakefake2\n-----END PRIVATE KEY-----\n' });
    s.add(file);
    expect(s.text('boom MIIfakefakefakefakefake2 boom')).toBe('boom [secret removed] boom');
    expect(s.deep({ a: [`k=${key}`], [key]: 1 })).toEqual({ a: ['k=[secret removed]'], '[secret removed]': 1 });
    const cleaned = s.error(new WeaveIntelError({ code: 'AUTH_FAILED', message: `bad ${key}`, details: { echoed: key }, cause: new Error(key) }), 'p');
    expect(cleaned.message).toBe('bad [secret removed]');
    expect(cleaned.details).toEqual({ echoed: '[secret removed]' });
    expect(cleaned.cause).toBeUndefined();
  });
});

describe('private and local addresses', () => {
  it('a local address is refused without an operator entry, and nothing is sent', async () => {
    const f = await fake();
    const events: RegistryEvent[] = [];
    const registry = registryFor(f, { privateEndpoints: [], onEvent: (e) => events.push(e) });
    const provider = describeProvider(f);
    const err = (await registry.chatModel(provider, CHAT).generate(weaveContext(), ask).catch((e: unknown) => e)) as WeaveIntelError;
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(`127.0.0.1:${f.port}`);
    expect(err.message).toContain("operator's allow entry");
    expect(f.requests).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(['blocked', 'error']);
    await expect(registry.embeddingModel(provider, { id: 'fake-embed', kind: 'embedding', embedding: { nativeDimensions: 8, dimensions: [], reduce: 'none', normalized: false, modes: [] } }).embed(weaveContext(), { input: ['a'] })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(registry.listModels(provider)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const drain = async (): Promise<void> => {
      for await (const c of registry.chatModel(provider, CHAT).stream!(weaveContext(), ask)) void c;
    };
    await expect(drain()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const test = await registry.testConnection(provider);
    expect(test).toMatchObject({ ok: false, outcome: 'blocked' });
    expect(f.requests).toHaveLength(0);
  });

  it('the same address is reachable once an operator allows that exact host and port', async () => {
    const f = await fake();
    const registry = registryFor(f, { privateEndpoints: [{ host: '127.0.0.1', port: f.port }] });
    expect((await registry.chatModel(describeProvider(f), CHAT).generate(weaveContext(), ask)).content).toBe(fakeReplyText('hi'));
    expect(f.requests).toHaveLength(1);
  });

  it('an entry for another port, another host or another provider does not open it', async () => {
    const f = await fake();
    const provider = describeProvider(f);
    const wrong: PrivateEndpointAllowance[][] = [
      [{ host: '127.0.0.1', port: f.port + 1 }],
      [{ host: 'localhost', port: f.port }],
      [{ host: '127.0.0.2', port: f.port }],
      [{ host: '127.0.0.1', port: f.port, providerId: 'some-other-provider' }],
    ];
    for (const privateEndpoints of wrong) {
      const registry = registryFor(f, { privateEndpoints });
      await expect(registry.chatModel(provider, CHAT).generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(f.requests).toHaveLength(0);
    const scoped = registryFor(f, { privateEndpoints: [{ host: '127.0.0.1', port: f.port, providerId: provider.id }] });
    await scoped.chatModel(provider, CHAT).generate(weaveContext(), ask);
    expect(f.requests).toHaveLength(1);
  });

  it('entries are read on every call, so adding or removing one takes effect at once', async () => {
    const f = await fake();
    let entries: PrivateEndpointAllowance[] = [];
    const registry = registryFor(f, { privateEndpoints: () => entries });
    const model = registry.chatModel(describeProvider(f), CHAT);
    await expect(model.generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    entries = [{ host: f.host, port: f.port }];
    expect((await model.generate(weaveContext(), ask)).content).toBe(fakeReplyText('hi'));
    entries = [];
    await expect(model.generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.requests).toHaveLength(1);
  });

  it('an allowed local server cannot bounce the call to another address', async () => {
    const target = await fake();
    const bouncer = createServer((req, res) => {
      req.resume();
      res.writeHead(307, { location: `${target.url}/chat/completions` });
      res.end();
    });
    await new Promise<void>((resolve) => bouncer.listen(0, '127.0.0.1', resolve));
    const port = (bouncer.address() as { port: number }).port;
    try {
      const registry = createProviderRegistry({
        adapters: [openAICompatibleAdapter()],
        secrets: { resolve: async () => KEY },
        // Both are allowed, so the only thing stopping the bounce is the no-redirect rule.
        privateEndpoints: [{ host: '127.0.0.1', port }, { host: '127.0.0.1', port: target.port }],
        resilience: false,
      });
      const err = (await registry.chatModel({ id: 'bouncer', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}`, secrets: { apiKey: 'k' } }, CHAT).generate(weaveContext(), ask).catch((e: unknown) => e)) as WeaveIntelError;
      expect(err).toBeInstanceOf(WeaveIntelError);
      expect(target.requests).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => bouncer.close(() => resolve()));
    }
  });

  it('private-network and metadata addresses are refused by default; plain http to a private host is refused even with an entry', async () => {
    const registry = createProviderRegistry({
      adapters: [openAICompatibleAdapter()],
      secrets: { resolve: async () => KEY },
      privateEndpoints: [{ host: '10.1.2.3', port: 8080 }],
      resilience: false,
    });
    const at = (baseUrl: string) => registry.chatModel({ id: `net-${baseUrl}`, kind: 'openai-compatible', baseUrl, secrets: { apiKey: 'k' } }, CHAT).generate(weaveContext(), ask);
    for (const url of ['https://10.9.9.9/v1', 'https://192.168.1.10:8443/v1', 'http://169.254.169.254/latest', 'https://[::1]:8443/v1', 'http://localhost:11434/v1', 'ftp://example.com/v1']) {
      await expect(at(url), url).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    // Known limit, by design of the library's guard: http is only ever allowed to the machine itself.
    await expect(at('http://10.1.2.3:8080/v1')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('an entry opens exactly one host and forbids redirects; no entry means the public-only rule', () => {
    const open = policyFor('https://10.1.2.3:8443/v1/chat/completions', [{ host: '10.1.2.3', port: 8443 }]);
    expect(open).toEqual({ policy: { allowLoopback: true, allowPrivateNetwork: true, allowedHosts: ['10.1.2.3'] }, redirect: 'error', allowed: true });
    const shut = { policy: { allowLoopback: false, allowPrivateNetwork: false }, redirect: 'manual', allowed: false };
    expect(policyFor('https://10.1.2.3:8444/v1', [{ host: '10.1.2.3', port: 8443 }])).toEqual(shut);
    expect(policyFor('https://10.1.2.3/v1', [{ host: '10.1.2.3', port: 8443 }])).toEqual(shut);
    expect(policyFor('https://10.1.2.3/v1', [{ host: '10.1.2.3', port: 443 }]).allowed).toBe(true);
    expect(policyFor('http://[::1]:1234/v1', [{ host: '::1', port: 1234 }]).allowed).toBe(true);
    expect(policyFor('not a url', [{ host: '10.1.2.3', port: 8443 }])).toEqual(shut);
  });

  it('a wrapped provider with its own address is checked by the same rule before its library is handed the address', async () => {
    let built = 0;
    const adapter = wrappedFactoryAdapter({
      kind: 'wrapped',
      label: 'Wrapped',
      chat: () => {
        built += 1;
        throw new Error('the factory must not be reached');
      },
    });
    const registry = createProviderRegistry({ adapters: [adapter], secrets: { resolve: async () => KEY }, resilience: false });
    await expect(registry.chatModel({ id: 'w-1', kind: 'wrapped', baseUrl: 'http://127.0.0.1:11434', secrets: { apiKey: 'k' } }, CHAT).generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(built).toBe(0);
  });
});

describe('embeddings', () => {
  const model = (embedding: Partial<NonNullable<ModelDescription['embedding']>> = {}): ModelDescription => ({
    id: 'fake-embed',
    kind: 'embedding',
    embedding: { nativeDimensions: 8, dimensions: [], reduce: 'none', normalized: false, modes: [], ...embedding },
  });

  it('normalises vectors the provider did not, and says so', async () => {
    const f = await fake({ normalize: false });
    const res = await registryFor(f).embeddingModel(describeProvider(f), model()).embed(weaveContext(), { input: ['kauri'] });
    expect(length(fakeVector('kauri', 8, false))).toBeGreaterThan(1.5);
    expect(Math.abs(length(res.embeddings[0]!) - 1)).toBeLessThan(1e-9);
    expect(res.embeddings[0]).toEqual(normalizeVector(fakeVector('kauri', 8, false)));
    expect(res.provenance).toMatchObject({ providerKind: 'openai-compatible', modelId: 'fake-embed', dimensions: 8, normalizedByRegistry: true, reducedByRegistry: false });
  });

  it('leaves vectors alone when the provider already normalised them', async () => {
    const f = await fake({ normalize: true });
    const res = await registryFor(f).embeddingModel(describeProvider(f), model({ normalized: true })).embed(weaveContext(), { input: ['kauri'] });
    expect(res.embeddings[0]).toEqual(fakeVector('kauri', 8, true));
    expect(res.provenance.normalizedByRegistry).toBe(false);
  });

  it('asks the provider for a smaller size when the model can produce it', async () => {
    const f = await fake();
    const m = registryFor(f).embeddingModel(describeProvider(f), model({ nativeDimensions: 3072, dimensions: [256, 512, 1024, 3072], reduce: 'provider' }), { dimensions: 512 });
    expect(m.dimensions).toBe(512);
    const res = await m.embed(weaveContext(), { input: ['kauri'] });
    expect((JSON.parse(f.requests[0]!.body) as Record<string, unknown>)['dimensions']).toBe(512);
    expect(res.embeddings[0]).toHaveLength(512);
    expect(res.provenance.dimensions).toBe(512);
    expect(res.provenance.reducedByRegistry).toBe(false);
  });

  it('cuts a vector down and re-normalises it itself when the model allows that and the provider cannot', async () => {
    const f = await fake();
    const m = registryFor(f).embeddingModel(describeProvider(f), model({ dimensions: [4], reduce: 'truncate' }), { dimensions: 4 });
    const res = await m.embed(weaveContext(), { input: ['kauri'] });
    expect((JSON.parse(f.requests[0]!.body) as Record<string, unknown>)['dimensions']).toBeUndefined();
    expect(res.embeddings[0]).toEqual(normalizeVector(fakeVector('kauri', 8, false).slice(0, 4)));
    expect(res.provenance).toMatchObject({ dimensions: 4, reducedByRegistry: true, normalizedByRegistry: true });
  });

  it('refuses a size the model cannot produce, before anything is sent', async () => {
    const f = await fake();
    const registry = registryFor(f);
    const provider = describeProvider(f);
    expect(() => registry.embeddingModel(provider, model(), { dimensions: 4 })).toThrowError(/cannot produce vectors of size 4/);
    expect(() => registry.embeddingModel(provider, model({ dimensions: [4], reduce: 'provider' }), { dimensions: 5 })).toThrowError(/It can produce: 4, 8/);
    expect(() => registry.embeddingModel(provider, model({ reduce: 'provider' }), { dimensions: 9 })).toThrowError(/cannot produce/);
    expect(() => registry.embeddingModel(provider, model({ reduce: 'provider' }), { dimensions: 2.5 })).toThrowError(/cannot produce/);
    expect(() => registry.embeddingModel(provider, { id: 'fake-chat', kind: 'chat' })).toThrowError(/not described as an embedding model/);
    expect(registry.embeddingModel(provider, model({ reduce: 'provider' }), { dimensions: 3 }).dimensions).toBe(3);
    expect(f.requests).toHaveLength(0);
  });

  it('refuses a request for a different size from the one the model was set up with', async () => {
    const f = await fake();
    const m = registryFor(f).embeddingModel(describeProvider(f), model());
    await expect(m.embed(weaveContext(), { input: ['a'], dimensions: 4 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.requests).toHaveLength(0);
  });

  it('sends texts in batches no bigger than the model takes and keeps them in order', async () => {
    const f = await fake();
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const res = await registryFor(f).embeddingModel(describeProvider(f), model({ batchLimit: 2 })).embed(weaveContext(), { input: texts });
    expect(f.requests.map((r) => (JSON.parse(r.body) as { input: string[] }).input)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(res.embeddings).toEqual(texts.map((t) => normalizeVector(fakeVector(t, 8, false))));
    expect(res.usage.totalTokens).toBe(15);
  });

  it('reports a vector of the wrong size as a protocol error instead of storing it', async () => {
    const f = await fake({ embeddingDimensions: 6 });
    await expect(registryFor(f).embeddingModel(describeProvider(f), model()).embed(weaveContext(), { input: ['a'] })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('vector helpers', () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
    expect(isUnitLength([0.6, 0.8])).toBe(true);
    expect(isUnitLength([3, 4])).toBe(false);
    expect(truncateVector([3, 4, 12], 2)).toEqual([0.6, 0.8]);
  });
});

describe('failures', () => {
  it('waits as long as the provider asked and tries again', async () => {
    const f = await fake();
    f.setMode('rate_limit', { times: 1, retryAfterSeconds: 0, retryAfterMs: 40 });
    const registry = registryFor(f, { resilience: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1000, jitter: false } } });
    const started = Date.now();
    expect((await registry.chatModel(describeProvider(f), CHAT).generate(weaveContext(), ask)).content).toBe(fakeReplyText('hi'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(f.requests).toHaveLength(2);
  });

  it('does not retry a rejected key or a bad request', async () => {
    const f = await fake();
    const registry = registryFor(f, { secrets: { resolve: async () => 'fk-not-the-key-000000' }, resilience: { retry: { maxAttempts: 3, baseDelayMs: 1 } } });
    await expect(registry.chatModel(describeProvider(f), CHAT).generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(f.requests).toHaveLength(1);
  });

  it('rests a provider that keeps failing, says so plainly, and a connection test still really tries it', async () => {
    const f = await fake();
    f.setMode('server_error');
    const registry = registryFor(f, { resilience: { retry: { maxAttempts: 1 }, circuit: { failureThreshold: 2, cooldownMs: 60_000 } } });
    const provider = describeProvider(f);
    const model = registry.chatModel(provider, CHAT);
    await expect(model.generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(model.generate(weaveContext(), ask)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const rested = (await model.generate(weaveContext(), ask).catch((e: unknown) => e)) as WeaveIntelError;
    expect(rested.code).toBe('CIRCUIT_OPEN');
    expect(rested.message).toBe('Test provider has failed several times in a row and is being rested. It will be tried again shortly.');
    expect(f.requests).toHaveLength(2);
    f.setMode('ok');
    const test = await registry.testConnection(provider);
    expect(test).toMatchObject({ ok: true, outcome: 'ok', modelCount: 2, message: 'Connected. 2 models found.' });
    expect(f.requests).toHaveLength(3);
  });

  it('a cancelled request is reported as cancelled', async () => {
    const f = await fake();
    f.setMode('hang');
    const controller = new AbortController();
    const registry = registryFor(f);
    const pending = registry.chatModel(describeProvider(f), CHAT).generate(weaveContext({ signal: controller.signal }), ask);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
  });

  it('a connection test never throws and says what went wrong', async () => {
    const f = await fake();
    const registry = registryFor(f);
    const provider = describeProvider(f);
    f.setMode('rate_limit', { times: 1 });
    expect(await registry.testConnection(provider)).toMatchObject({ ok: false, outcome: 'rate_limited' });
    f.setMode('malformed', { times: 1 });
    expect(await registry.testConnection(provider)).toMatchObject({ ok: false, outcome: 'error' });
    const wrongKey = registryFor(f, { secrets: { resolve: async () => 'fk-not-the-key-000000' } });
    const denied = await wrongKey.testConnection(provider);
    expect(denied).toMatchObject({ ok: false, outcome: 'auth_failed' });
    expect(denied.message).not.toContain('fk-not-the-key-000000');
    const unknownKind = await registry.testConnection({ ...provider, kind: 'no-such-kind' });
    expect(unknownKind).toMatchObject({ ok: false, outcome: 'error' });
    // A port with nothing listening (allowed, so the guard is not what stops it).
    const closed = await fake();
    const closedPort = closed.port;
    await closed.close();
    const gone = createProviderRegistry({ adapters: [openAICompatibleAdapter()], secrets: { resolve: async () => KEY }, privateEndpoints: [{ host: '127.0.0.1', port: closedPort }], resilience: false });
    const unreachable = await gone.testConnection({ id: 'gone', kind: 'openai-compatible', displayName: 'Gone', baseUrl: `http://127.0.0.1:${closedPort}`, secrets: { apiKey: 'k' } });
    expect(unreachable).toMatchObject({ ok: false, outcome: 'unreachable' });
    expect(unreachable.message).toMatch(/^Could not reach Gone/);
  });

  it('an unknown kind of provider is refused with a plain reason', async () => {
    const f = await fake();
    expect(() => registryFor(f).chatModel({ id: 'x', kind: 'mystery', displayName: 'Mystery' }, CHAT)).toThrowError('Mystery is a kind of provider this installation cannot talk to ("mystery").');
  });
});

describe('wrapped provider libraries', () => {
  it('fetches the key for each call, builds the library model for that call only, and lists models through the guarded transport', async () => {
    const f = await fake();
    const seen: Array<{ modelId: string; apiKey: string; baseUrl?: string }> = [];
    const adapter = wrappedFactoryAdapter({
      kind: 'wrapped',
      label: 'Wrapped library',
      chat: (modelId, credentials) => {
        seen.push({ modelId, ...credentials });
        const caps = new Set<never>();
        return {
          info: { provider: 'inner', modelId, capabilities: caps },
          capabilities: caps,
          hasCapability: () => false,
          generate: async () => ({ id: 'r', content: `inner said hi with a ${credentials.apiKey.length}-character key`, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: modelId }),
        } as Model;
      },
      list: { defaultUrl: 'https://api.example.invalid/v1/models', pathFromBase: '/models', auth: 'bearer' },
    });
    let current = KEY;
    const registry = createProviderRegistry({ adapters: [adapter], secrets: { resolve: async () => current }, privateEndpoints: [{ host: f.host, port: f.port }], resilience: false });
    const provider: ProviderDescription = { id: 'w-2', kind: 'wrapped', baseUrl: f.url, secrets: { apiKey: 'vault:key' } };
    const model = registry.chatModel(provider, CHAT);
    expect(inspect(model, { depth: 10, showHidden: true })).not.toContain(KEY);
    await model.generate(weaveContext(), ask);
    current = 'fk-registry-SECOND-11223344556677';
    await model.generate(weaveContext(), ask);
    expect(seen).toEqual([
      { modelId: 'fake-chat', apiKey: KEY, baseUrl: f.url },
      { modelId: 'fake-chat', apiKey: 'fk-registry-SECOND-11223344556677', baseUrl: f.url },
    ]);
    // Streaming falls back to one whole answer when the library model cannot stream.
    const chunks = [];
    for await (const c of model.stream!(weaveContext(), ask)) chunks.push(c.type);
    expect(chunks).toEqual(['text', 'usage', 'done']);
    current = KEY;
    expect((await registry.listModels(provider)).map((m) => m.id)).toEqual(['fake-chat', 'fake-embed']);
    expect(registry.kinds()).toEqual([{ kind: 'wrapped', label: 'Wrapped library', secretSlots: [{ name: 'apiKey', label: 'API key', required: true }], chat: true, streaming: true, embeddings: false, listsModels: true }]);
  });
});

describe('the addresses the wave-4 security test reached (S3-SSRF-1/2), with no operator entry', () => {
  // With no entry, these were ATTEMPTED (the test reported "unreachable"): CGNAT, NAT64 and IPv4-compatible
  // literals were classed as public, and a name that did not resolve was let through. Each is now refused before
  // anything is sent — "blocked", and only an operator's exact host-and-port entry opens one.
  it('refuses CGNAT, NAT64, IPv4-compatible and an unresolvable name as blocked, sending nothing', async () => {
    const f = await fake();
    const events: RegistryEvent[] = [];
    const registry = registryFor(f, { privateEndpoints: [], onEvent: (e) => events.push(e) });
    for (const baseUrl of ['https://100.64.0.1:9931', 'https://[64:ff9b::7f00:1]:9931', 'https://[::7f00:1]:9931', 'https://pentest-w4-nx.invalid']) {
      const test = await registry.testConnection(describeProvider(f, { baseUrl }));
      expect(test, baseUrl).toMatchObject({ ok: false, outcome: 'blocked' });
      await expect(registry.listModels(describeProvider(f, { baseUrl })), baseUrl).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(f.requests).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'blocked').length).toBeGreaterThanOrEqual(4);
  });
});
