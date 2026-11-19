import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  let server: Server;
  let url: string;
  let requests: string[];
  let respond: (req: IncomingMessage, res: ServerResponse) => void;
  beforeEach(async () => {
    requests = [];
    respond = (_req, res) => { res.end('ok'); };
    server = createServer((req, res) => { requests.push(req.url ?? ''); respond(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('re-validates the redirect target — 302 → metadata is blocked', async () => {
    respond = (_req, res) => { res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' }); res.end(); };
    await expect(
      hardenedFetch(`${url}/start`, {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
    expect(requests).toEqual(['/start']);
  });

  it('re-validates the redirect target — 301 → RFC1918 is blocked', async () => {
    respond = (_req, res) => { res.writeHead(301, { location: 'https://10.0.0.5/admin' }); res.end(); };
    await expect(
      hardenedFetch(`${url}/start`, {}, DEFAULTS),
    ).rejects.toThrow(/test-egress/);
    expect(requests).toEqual(['/start']);
  });

  it('caps redirect hops at 5', async () => {
    respond = (req, res) => {
      const m = /\/h(\d+)$/.exec(req.url ?? '');
      const n = m ? Number.parseInt(m[1] ?? '0', 10) : 0;
      res.writeHead(302, { location: `/h${n + 1}` }); res.end();
    };
    await expect(
      hardenedFetch(`${url}/h0`, {}, DEFAULTS),
    ).rejects.toThrow(/too many redirects/);
    expect(requests).toHaveLength(6);
  });

  it('validates the resolved address again when connecting to a redirect', async () => {
    let redirected = false;
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(function (_hostname, callback) {
      const options: unknown = arguments[1];
      const address = redirected ? '0.0.0.0' : '127.0.0.1';
      if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
        const done: (error: null, addresses: Array<{ address: string; family: number }>) => void = arguments[2];
        done(null, [{ address, family: 4 }]);
      } else {
        const done: typeof callback = arguments[arguments.length - 1];
        done(null, address, 4);
      }
    });
    try {
      respond = (_req, res) => { redirected = true; res.writeHead(302, { location: '/next' }); res.end(); };
      const localUrl = url.replace('127.0.0.1', 'localhost');
      await expect(hardenedFetch(`${localUrl}/start`, {}, DEFAULTS)).rejects.toThrow();
      expect(requests).toEqual(['/start']);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      lookup.mockRestore();
    }
  });

  it('honors manual and error redirect modes without following the location', async () => {
    respond = (_req, res) => { res.writeHead(302, { location: '/next' }); res.end(); };
    const response = await hardenedFetch(`${url}/start`, {}, { ...DEFAULTS, redirect: 'manual' });
    expect(response.status).toBe(302);
    await expect(hardenedFetch(`${url}/start`, {}, { ...DEFAULTS, redirect: 'error' })).rejects.toThrow(/redirect is not allowed/);
    const requestMode = await hardenedFetch(`${url}/start`, { redirect: 'manual' }, DEFAULTS);
    expect(requestMode.status).toBe(302);
    await expect(hardenedFetch(`${url}/start`, { redirect: 'error' }, DEFAULTS)).rejects.toThrow(/redirect is not allowed/);
    expect(requests).toEqual(['/start', '/start', '/start', '/start']);
  });

  it('changes a same-origin 303 to GET without resending the request body', async () => {
    let received: { method?: string; contentType?: string; authorization?: string; body: string } | undefined;
    respond = (req, res) => {
      if (req.url === '/start') { res.writeHead(303, { location: '/next' }); res.end(); return; }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        received = { method: req.method, contentType: req.headers['content-type'], authorization: req.headers.authorization, body };
        res.end('ok');
      });
    };
    const response = await hardenedFetch(`${url}/start`, {
      method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: '{"test":true}',
    }, DEFAULTS);
    expect(await response.text()).toBe('ok');
    expect(received).toEqual({ method: 'GET', contentType: undefined, authorization: 'Bearer test', body: '' });
  });

  it('rejects cross-origin redirects before forwarding credentials or bodies', async () => {
    let received = 0;
    const target = createServer((_req, res) => { received++; res.end('unexpected'); });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      const location = `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`;
      respond = (_req, res) => { res.writeHead(307, { location }); res.end(); };
      await expect(hardenedFetch(`${url}/start`, {
        method: 'POST', headers: { authorization: 'Bearer secret', 'x-api-key': 'secret' }, body: 'private payload',
      }, DEFAULTS)).rejects.toThrow(/cross-origin redirect is not allowed/);
      await expect(hardenedFetch(`${url}/start`, {
        method: 'POST', body: 'private payload',
      }, { ...DEFAULTS, policy: { allowCrossOriginRedirects: true } })).rejects.toThrow(/bodyless GET or HEAD/);
      expect(received).toBe(0);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('strips caller headers on explicitly allowed cross-origin GETs, including later hops', async () => {
    const seen: Array<{ authorization?: string; apiKey?: string }> = [];
    const target = createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
      res.writeHead(302, { location: `${url}/back` }); res.end();
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      const location = `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`;
      respond = (req, res) => {
        if (req.url === '/start') { res.writeHead(302, { location }); res.end(); return; }
        seen.push({ authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
        res.end('ok');
      };
      const response = await hardenedFetch(`${url}/start`, {
        headers: { authorization: 'Bearer secret', 'x-api-key': 'secret' },
      }, { ...DEFAULTS, policy: { allowCrossOriginRedirects: true } });
      expect(await response.text()).toBe('ok');
      expect(seen).toEqual([
        { authorization: undefined, apiKey: undefined },
        { authorization: undefined, apiKey: undefined },
      ]);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects when Content-Length exceeds maxBytes', async () => {
    respond = (_req, res) => { res.writeHead(200, { 'content-length': '500' }); res.end('x'.repeat(500)); };
    await expect(
      hardenedFetch(url, {}, { ...DEFAULTS, maxBytes: 100 }),
    ).rejects.toThrow(/exceeds limit 100/);
  });

  it('streams body and errors past maxBytes when Content-Length is absent', async () => {
    respond = (_req, res) => { res.write('x'.repeat(250)); res.end('x'.repeat(250)); };
    const resp = await hardenedFetch(url, {}, {
      ...DEFAULTS,
      maxBytes: 100,
    });
    await expect(resp.text()).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('maxBytes:0 disables the cap entirely', async () => {
    respond = (_req, res) => { res.end('x'.repeat(500)); };
    const resp = await hardenedFetch(url, {}, {
      ...DEFAULTS,
      maxBytes: 0,
    });
    await expect(resp.text()).resolves.toBe('x'.repeat(500));
  });

  it('aborts a hung request via the outer timeout', async () => {
    respond = () => {};
    await expect(
      hardenedFetch(url, {}, { ...DEFAULTS, timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('timeoutMs:0 disables the timeout (streaming mode)', async () => {
    const resp = await hardenedFetch(url, {}, {
      ...DEFAULTS,
      timeoutMs: 0,
    });
    expect(resp.status).toBe(200);
    expect(requests).toHaveLength(1);
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
