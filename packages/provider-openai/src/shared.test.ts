import { describe, expect, it, vi, afterEach } from 'vitest';
import { openaiRequest, openaiStreamRequest, parseRetryAfterMs } from './shared.js';

// The hardened transport in `@weaveintel/core` connects through undici's own
// `fetch` (DNS-pinned dispatcher), so a `globalThis.fetch` spy never sees the
// request. These are unit tests of `shared.ts` (error classification + signal
// composition), so route the package's transport seam through the global fetch
// that each test stubs. The hardened path itself is covered in `@weaveintel/core`.
vi.mock('./_fetch.js', () => ({
  openaiFetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init),
  openaiFetchStream: (input: string, init?: RequestInit) => globalThis.fetch(input, init),
  assertHttpsOrLoopback: async () => undefined,
}));

describe('openai shared retry-after parsing', () => {
  it('parses delta-seconds retry-after', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
  });

  it('clamps retry-after to 30 seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(30_000);
  });

  it('falls back for invalid retry-after', () => {
    expect(parseRetryAfterMs('invalid', 1234)).toBe(1234);
  });
});

describe('openai stream error classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns RATE_LIMITED with retry-after metadata for 429 streams', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'too many requests' } }), {
        status: 429,
        headers: { 'retry-after': '2' },
      }),
    );

    const run = async () => {
      for await (const _chunk of openaiStreamRequest('https://example.com', '/chat/completions', {}, {})) {
        // no-op
      }
    };

    await expect(run()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('cancels and releases stream reader when consumer stops', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: [DONE]\n\n') })
      .mockResolvedValueOnce({ done: true, value: undefined });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({ read, cancel, releaseLock }),
      },
    } as unknown as Response);

    for await (const _chunk of openaiStreamRequest('https://example.com', '/chat/completions', {}, {})) {
      // stream ends with [DONE]
    }

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('openai request timeout composition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always attaches a timeout-capable signal when caller provides none', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await openaiRequest('https://example.com', '/v1/test', { ping: 'pong' }, {});
    expect(capturedSignal).toBeDefined();
  });

  it('preserves caller cancellation when composing timeout signal', async () => {
    const controller = new AbortController();
    controller.abort('caller-abort');

    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await openaiRequest('https://example.com', '/v1/test', { ping: 'pong' }, {}, controller.signal);
    expect(capturedSignal?.aborted).toBe(true);
  });
});
