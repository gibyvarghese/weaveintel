// SPDX-License-Identifier: MIT
/**
 * AWS Bedrock: the shared contract against the fake Bedrock server (once with
 * a Bedrock API key, once with a signed request), plus the two pieces written
 * by hand here instead of taken from an SDK: the request signature and the
 * binary event stream.
 */
import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { FAKE_CHAT_USAGE, FAKE_TOOL_ARGUMENTS, fakeEventStreamMessage, fakeReplyText, startFakeBedrockServer } from '@weaveintel/testing';
import { providerContractCases, type ProviderContractOptions } from './contract.js';
import { createProviderRegistry } from './registry.js';
import { bedrockAdapter } from './adapters/bedrock/bedrock.js';
import { signRequest } from './adapters/bedrock/sigv4.js';
import { EventStreamFormatError, crc32, encodeEventStreamMessage, readEventStream } from './adapters/bedrock/event-stream.js';
import type { ModelDescription } from './types.js';

const API_KEY = 'fk-bedrock-GOOD-7c1e5a90b3d24f68';
const WRONG_API_KEY = 'fk-bedrock-WRONG-0a9b8c7d6e5f4321';
const ACCESS_KEY_ID = 'FAKEACCESSKEYID00001';
const SECRET_KEY = 'fk-aws-secret-GOOD-Zq3Lm8Xw1Rt6Yp0Kd4Nh';
const WRONG_SECRET_KEY = 'fk-aws-secret-WRONG-Ab5Cd7Ef9Gh1Ij3Kl5Mn';
const SESSION = 'fk-aws-session-TOKEN-Pq2Rs4Tu6Vw8Xy0Za1Bc3De5';

// A model id with ":" in it, as real Bedrock ids have; it must be encoded in the path and signed.
const CHAT: ModelDescription = { id: 'fake.chat-v1:0', kind: 'chat', capabilities: ['tools'] };
const TITAN: ModelDescription = {
  id: 'amazon.titan-embed-text-v2:0',
  kind: 'embedding',
  embedding: { nativeDimensions: 1024, dimensions: [256, 512, 1024], reduce: 'provider', normalized: true, batchLimit: 1, modes: [] },
};
const COHERE: ModelDescription = {
  id: 'cohere.embed-english-v3',
  kind: 'embedding',
  embedding: { nativeDimensions: 1024, dimensions: [], reduce: 'none', normalized: false, batchLimit: 96, modes: ['document', 'query'] },
};
const expected = { replyTo: fakeReplyText, toolArguments: FAKE_TOOL_ARGUMENTS, usage: FAKE_CHAT_USAGE };

const shapes: ProviderContractOptions[] = [
  {
    name: 'bedrock (API key)',
    adapters: [bedrockAdapter()],
    startFake: () => startFakeBedrockServer({ apiKey: API_KEY }),
    provider: (fake) => ({ id: 'x', kind: 'bedrock', displayName: 'Fake Bedrock', region: 'us-east-1', baseUrl: fake.url, secrets: { apiKey: 'vault:bedrock-key' } }),
    goodSecrets: () => ({ 'vault:bedrock-key': API_KEY }),
    badSecrets: () => ({ 'vault:bedrock-key': WRONG_API_KEY }),
    chatModel: CHAT,
    embeddingModel: TITAN,
    expected,
  },
  {
    name: 'bedrock (signed with access key, secret and session token)',
    adapters: [bedrockAdapter()],
    startFake: () => startFakeBedrockServer({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY, sessionToken: SESSION }),
    provider: (fake) => ({
      id: 'x',
      kind: 'bedrock',
      displayName: 'Fake Bedrock',
      region: 'us-east-1',
      baseUrl: fake.url,
      secrets: { accessKeyId: 'vault:akid', secretAccessKey: 'vault:secret', sessionToken: 'vault:session' },
    }),
    goodSecrets: () => ({ 'vault:akid': ACCESS_KEY_ID, 'vault:secret': SECRET_KEY, 'vault:session': SESSION }),
    badSecrets: () => ({ 'vault:akid': ACCESS_KEY_ID, 'vault:secret': WRONG_SECRET_KEY, 'vault:session': SESSION }),
    chatModel: CHAT,
    embeddingModel: COHERE,
    expected,
  },
];

describe('provider contract: AWS Bedrock', () => {
  for (const shape of shapes) for (const c of providerContractCases(shape)) it(c.name, c.run);
});

describe('Bedrock specifics', () => {
  async function setup(fakeOpts: Parameters<typeof startFakeBedrockServer>[0], secretTable: Record<string, string>, provider: Record<string, unknown> = {}) {
    const fake = await startFakeBedrockServer(fakeOpts);
    const registry = createProviderRegistry({
      adapters: [bedrockAdapter()],
      secrets: { resolve: async (ref) => secretTable[ref] },
      privateEndpoints: [{ host: fake.host, port: fake.port }],
      resilience: false,
    });
    const description = { id: `bedrock-${Math.random()}`, kind: 'bedrock', region: 'us-east-1', baseUrl: fake.url, secrets: { apiKey: 'k' }, ...provider };
    return { fake, registry, description };
  }

  it('sends the model id percent-encoded in the path and never in the body', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, { k: API_KEY });
    try {
      await registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], maxTokens: 20, temperature: 0.2 });
      const req = fake.requests[0]!;
      expect(req.path).toBe('/model/fake.chat-v1%3A0/converse');
      const body = JSON.parse(req.body) as Record<string, unknown>;
      expect(body['modelId']).toBeUndefined();
      expect(body['system']).toEqual([{ text: 'Be brief.' }]);
      expect(body['inferenceConfig']).toEqual({ maxTokens: 20, temperature: 0.2 });
      expect(body['messages']).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    } finally {
      await fake.close();
    }
  });

  it('a signed request without the session token the account needs is refused as an authentication failure', async () => {
    const { fake, registry, description } = await setup(
      { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY, sessionToken: SESSION },
      { a: ACCESS_KEY_ID, s: SECRET_KEY },
      { secrets: { accessKeyId: 'a', secretAccessKey: 's' } },
    );
    try {
      await expect(registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    } finally {
      await fake.close();
    }
  });

  it('a signature scoped to the wrong region is refused', async () => {
    const { fake, registry, description } = await setup({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY }, { a: ACCESS_KEY_ID, s: SECRET_KEY }, { region: 'eu-west-1', secrets: { accessKeyId: 'a', secretAccessKey: 's' } });
    try {
      await expect(registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    } finally {
      await fake.close();
    }
  });

  it('with no key of either kind it says which is missing and sends nothing', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, {}, { secrets: {} });
    try {
      const err = await registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'AUTH_FAILED' });
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('needs a region, and refuses one that is not a region name', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, { k: API_KEY }, { baseUrl: undefined, region: 'us-east-1.evil.example/' });
    try {
      await expect(registry.chatModel(description, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(registry.chatModel({ ...description, region: undefined }, CHAT).generate(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('Titan embeddings: one text per request, the size asked of the provider', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, { k: API_KEY });
    try {
      const model = registry.embeddingModel(description, TITAN, { dimensions: 512 });
      const res = await model.embed(weaveContext(), { input: ['kauri', 'rimu'] });
      expect(res.embeddings.map((v) => v.length)).toEqual([512, 512]);
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0]!.path).toBe('/model/amazon.titan-embed-text-v2%3A0/invoke');
      expect(JSON.parse(fake.requests[0]!.body)).toEqual({ inputText: 'kauri', normalize: true, dimensions: 512 });
      expect(res.usage.totalTokens).toBe(6);
      expect(res.provenance).toMatchObject({ modelId: TITAN.id, dimensions: 512 });
    } finally {
      await fake.close();
    }
  });

  it('Cohere embeddings: a batch per request, with the document or query mode', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, { k: API_KEY });
    try {
      const model = registry.embeddingModel(description, COHERE);
      await model.embed(weaveContext(), { input: ['kauri', 'rimu'], mode: 'query' });
      const body = JSON.parse(fake.requests[0]!.body) as Record<string, unknown>;
      expect(body['texts']).toEqual(['kauri', 'rimu']);
      expect(body['input_type']).toBe('search_query');
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it('lists foundation models with what each is for', async () => {
    const { fake, registry, description } = await setup({ apiKey: API_KEY }, { k: API_KEY });
    try {
      const models = await registry.listModels(description);
      expect(models.map((m) => `${m.id}=${m.kind}`)).toEqual(['fake.chat-v1:0=chat', 'amazon.titan-embed-text-v2:0=embedding', 'cohere.embed-english-v3=embedding']);
    } finally {
      await fake.close();
    }
  });
});

describe('AWS request signature (SigV4)', () => {
  // AWS publishes worked examples so that implementations can be checked
  // without an account. This is the "get-vanilla" example from the AWS
  // Signature Version 4 test suite. The access key id and secret below are
  // AWS's own PUBLISHED PLACEHOLDERS from that documentation; they open nothing.
  const AWS_DOCUMENTED_EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

  it("matches AWS's published worked example", () => {
    const headers = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: AWS_DOCUMENTED_EXAMPLE,
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it("matches AWS's published example with query parameters in the wrong order", () => {
    // "get-vanilla-query-order-key-case" from the same suite.
    const headers = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: AWS_DOCUMENTED_EXAMPLE,
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers['authorization']).toContain('Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });

  it('signs the session token header when one is used and never returns a host header', () => {
    const headers = signRequest({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/a%3Ab/converse',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      region: 'us-east-1',
      service: 'bedrock',
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY, sessionToken: SESSION },
      now: new Date('2026-01-02T03:04:05Z'),
    });
    expect(headers['host']).toBeUndefined();
    expect(headers['x-amz-security-token']).toBe(SESSION);
    expect(headers['authorization']).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token');
    expect(headers['authorization']).toContain(`Credential=${ACCESS_KEY_ID}/20260102/us-east-1/bedrock/aws4_request`);
    expect(headers['authorization']).not.toContain(SECRET_KEY);
  });
});

describe('AWS binary event stream', () => {
  function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
  }
  async function collect(body: ReadableStream<Uint8Array>) {
    const out = [];
    for await (const m of readEventStream(body)) out.push({ headers: m.headers, payload: new TextDecoder().decode(m.payload) });
    return out;
  }

  it('reads messages written by an independent encoder, however the bytes are cut up', async () => {
    const a = fakeEventStreamMessage({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{"delta":{"text":"kia ora"}}');
    const b = fakeEventStreamMessage({ ':event-type': 'messageStop', ':message-type': 'event' }, '{"stopReason":"end_turn"}');
    const joined = new Uint8Array([...a, ...b]);
    const single = await collect(streamOf(joined));
    expect(single).toEqual([
      { headers: { ':event-type': 'contentBlockDelta', ':message-type': 'event' }, payload: '{"delta":{"text":"kia ora"}}' },
      { headers: { ':event-type': 'messageStop', ':message-type': 'event' }, payload: '{"stopReason":"end_turn"}' },
    ]);
    const byteByByte = await collect(streamOf(...[...joined].map((x) => new Uint8Array([x]))));
    expect(byteByByte).toEqual(single);
  });

  it('round-trips through its own encoder and agrees with the independent one byte for byte', async () => {
    const mine = encodeEventStreamMessage({ ':event-type': 'metadata', ':message-type': 'event' }, new TextEncoder().encode('{"usage":{}}'));
    const theirs = fakeEventStreamMessage({ ':event-type': 'metadata', ':message-type': 'event' }, '{"usage":{}}');
    expect([...mine]).toEqual([...theirs]);
    expect(await collect(streamOf(mine))).toEqual([{ headers: { ':event-type': 'metadata', ':message-type': 'event' }, payload: '{"usage":{}}' }]);
  });

  it('knows the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('refuses a message whose bytes were damaged', async () => {
    const good = fakeEventStreamMessage({ ':event-type': 'x' }, '{"a":1}');
    const damaged = new Uint8Array(good);
    damaged[damaged.length - 6] = (damaged[damaged.length - 6] ?? 0) ^ 0xff;
    await expect(collect(streamOf(damaged))).rejects.toBeInstanceOf(EventStreamFormatError);
  });

  it('refuses a stream that stops in the middle of a message', async () => {
    const good = fakeEventStreamMessage({ ':event-type': 'x' }, '{"a":1}');
    await expect(collect(streamOf(good.subarray(0, good.length - 3)))).rejects.toBeInstanceOf(EventStreamFormatError);
  });

  it('refuses a message that claims an absurd length', async () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 0x7fffffff);
    await expect(collect(streamOf(bytes))).rejects.toBeInstanceOf(EventStreamFormatError);
  });

  it('a damaged stream from the provider surfaces as a protocol error, and a mid-stream exception as a provider error', async () => {
    const { createServer } = await import('node:http');
    let mode: 'damaged' | 'exception' = 'damaged';
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        if (mode === 'damaged') {
          const good = fakeEventStreamMessage({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{"delta":{"text":"x"}}');
          const bad = new Uint8Array(good);
          bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
          res.end(Buffer.from(bad));
        } else {
          res.write(Buffer.from(fakeEventStreamMessage({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{"delta":{"text":"partial"}}')));
          res.end(Buffer.from(fakeEventStreamMessage({ ':exception-type': 'throttlingException', ':message-type': 'exception' }, '{"message":"Too many requests"}')));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const registry = createProviderRegistry({
        adapters: [bedrockAdapter()],
        secrets: { resolve: async () => API_KEY },
        privateEndpoints: [{ host: '127.0.0.1', port }],
        resilience: false,
      });
      const provider = { id: 'bedrock-stream-faults', kind: 'bedrock', region: 'us-east-1', baseUrl: `http://127.0.0.1:${port}`, secrets: { apiKey: 'k' } };
      const drain = async () => {
        const seen: string[] = [];
        for await (const c of registry.chatModel(provider, CHAT).stream!(weaveContext(), { messages: [{ role: 'user', content: 'hi' }] })) seen.push(c.type);
        return seen;
      };
      await expect(drain()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      mode = 'exception';
      await expect(drain()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
