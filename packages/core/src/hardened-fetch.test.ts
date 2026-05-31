import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createHardenedFetch,
  hardenedFetch,
  assertSafeForEgress,
} from './hardened-fetch.js';

// Use a single per-package errorTag for these tests so we can pattern-match
// thrown messages against the same package boundary every adopter would see.
const DEFAULTS = { errorTag: 'test-egress' } as const;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetchStub(
  handler: (url: string, init: RequestInit | undefined, calls: FetchCall[]) => Response | Promise<Response>,
): { restore: () => void; calls: FetchCall[] } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: u, init });
    return handler(u, init, calls);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('hardenedFetch — SSRF gate', () => {
  let stub: { restore: () => void; calls: FetchCall[] };
  beforeEach(() => {
    stub = installFetchStub(() => new Response('ok', { status: 200 }));
  });
  afterEach(() => stub.restore());

  it('rejects AWS metadata before any fetch', async () => {
    await expect(
      hardenedFetch('https://169.254.169.254/latest/meta-data/', {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects GCP metadata hostname before any fetch', async () => {
    await expect(
      hardenedFetch('https://metadata.google.internal/computeMetadata/v1/', {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects RFC1918 IPv4 literals before any fetch', async () => {
    await expect(hardenedFetch('https://10.0.0.5/', {}, DEFAULTS)).rejects.toThrow(/test-egress/);
    await expect(hardenedFetch('https://192.168.1.1/', {}, DEFAULTS)).rejects.toThrow(/test-egress/);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects non-loopback http://', async () => {
    await expect(hardenedFetch('http://example.com/', {}, DEFAULTS)).rejects.toThrow(/non-HTTPS/);
    expect(stub.calls).toHaveLength(0);
  });

  it('SSRF guard is skippable with enforceHttps:false (for tests / opt-out)', async () => {
    await expect(
      hardenedFetch('http://example.com/', {}, { ...DEFAULTS, enforceHttps: false }),
    ).resolves.toBeInstanceOf(Response);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('hardenedFetch — redirect re-validation', () => {
  let stub: { restore: () => void; calls: FetchCall[] };
  afterEach(() => stub?.restore());

  it('re-validates the redirect target — 302 → metadata is blocked', async () => {
    stub = installFetchStub((url) => {
      if (url === 'https://api.example.com/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        });
      }
      return new Response('leaked', { status: 200 });
    });
    await expect(
      hardenedFetch('https://api.example.com/start', {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
    // The initial request fires; the follow-up to metadata MUST NOT.
    expect(stub.calls.map((c) => c.url)).toEqual(['https://api.example.com/start']);
  });

  it('re-validates the redirect target — 301 → RFC1918 is blocked', async () => {
    stub = installFetchStub((url) => {
      if (url === 'https://api.example.com/start') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://10.0.0.5/admin' },
        });
      }
      return new Response('leaked', { status: 200 });
    });
    await expect(
      hardenedFetch('https://api.example.com/start', {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
  });

  it('caps redirect hops at 5', async () => {
    stub = installFetchStub((url) => {
      const m = /\/h(\d+)$/.exec(url);
      const n = m ? Number.parseInt(m[1] ?? '0', 10) : 0;
      return new Response(null, {
        status: 302,
        headers: { location: `https://api.example.com/h${n + 1}` },
      });
    });
    await expect(
      hardenedFetch('https://api.example.com/h0', {}, DEFAULTS),
    ).rejects.toThrow(/too many redirects/);
  });
});

describe('hardenedFetch — size cap', () => {
  let stub: { restore: () => void; calls: FetchCall[] };
  afterEach(() => stub?.restore());

  it('rejects when Content-Length exceeds maxBytes', async () => {
    stub = installFetchStub(
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': '99999' },
        }),
    );
    await expect(
      hardenedFetch('https://api.example.com/', {}, { ...DEFAULTS, maxBytes: 100 }),
    ).rejects.toThrow(/exceeds limit 100/);
  });

  it('streams body and errors past maxBytes when Content-Length is absent', async () => {
    const big = 'x'.repeat(500);
    stub = installFetchStub(() => new Response(big, { status: 200 }));
    const resp = await hardenedFetch('https://api.example.com/', {}, {
      ...DEFAULTS,
      maxBytes: 100,
    });
    await expect(resp.text()).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('maxBytes:0 disables the cap entirely', async () => {
    const big = 'x'.repeat(500);
    stub = installFetchStub(() => new Response(big, { status: 200 }));
    const resp = await hardenedFetch('https://api.example.com/', {}, {
      ...DEFAULTS,
      maxBytes: 0,
    });
    await expect(resp.text()).resolves.toBe(big);
  });
});

describe('hardenedFetch — timeout', () => {
  let stub: { restore: () => void; calls: FetchCall[] };
  afterEach(() => stub?.restore());

  it('aborts a hung request via the outer timeout', async () => {
    stub = installFetchStub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          sig?.addEventListener('abort', () => {
            const reason = (sig.reason ?? new Error('aborted')) as Error;
            reject(reason);
          });
        }),
    );
    await expect(
      hardenedFetch('https://api.example.com/', {}, { ...DEFAULTS, timeoutMs: 20 }),
    ).rejects.toThrow();
  });

  it('timeoutMs:0 disables the timeout (streaming mode)', async () => {
    stub = installFetchStub(() => new Response('ok'));
    const resp = await hardenedFetch('https://api.example.com/', {}, {
      ...DEFAULTS,
      timeoutMs: 0,
    });
    expect(resp.status).toBe(200);
    // No signal was synthesized when there was no caller signal AND no timeout.
    expect(stub.calls[0]?.init?.signal).toBeUndefined();
  });
});

describe('createHardenedFetch factory', () => {
  let stub: { restore: () => void; calls: FetchCall[] };
  beforeEach(() => {
    stub = installFetchStub(() => new Response('ok'));
  });
  afterEach(() => stub.restore());

  it('per-package errorTag appears in thrown messages', async () => {
    const client = createHardenedFetch({ errorTag: 'tools-foo' });
    await expect(client.fetch('https://169.254.169.254/')).rejects.toThrow(/tools-foo/);
  });

  it('fetchStream disables timeout + size cap but keeps SSRF guard', async () => {
    const client = createHardenedFetch({ errorTag: 'tools-stream' });
    await expect(client.fetchStream('http://example.com/')).rejects.toThrow(/non-HTTPS/);
    expect(stub.calls).toHaveLength(0);
  });

  it('assertSafe rejects metadata without ever calling fetch', async () => {
    const client = createHardenedFetch({ errorTag: 'tools-asserter' });
    await expect(client.assertSafe('https://metadata.google.internal/')).rejects.toThrow(
      /tools-asserter/,
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe('assertSafeForEgress — standalone', () => {
  it('rejects metadata before any fetch', async () => {
    await expect(
      assertSafeForEgress('https://169.254.169.254/', { errorTag: 'standalone' }),
    ).rejects.toThrow(/standalone/);
  });
});
