import { describe, it, expect, vi, beforeEach } from 'vitest';

// DNS and the connection are both controlled here, so every verdict is about the guard and never about
// whether this machine can reach the internet. `table` answers lookups (an Error = the lookup fails; a
// function = a different answer each time, for rebinding); `connects` records what undici was asked to
// connect to, through the lookup hook the guard gave it.
const h = vi.hoisted(() => ({
  table: new Map<string, string[] | Error | (() => string[])>(),
  connects: [] as { host: string; error?: string }[],
  responses: new Map<string, () => Response>(),
  sent: [] as Headers[],
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = (host: string, _opts: unknown, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void): void => {
    const entry = h.table.get(host);
    if (entry === undefined || entry instanceof Error) {
      const e = (entry ?? Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })) as NodeJS.ErrnoException;
      setImmediate(() => cb(e, []));
      return;
    }
    const list = typeof entry === 'function' ? entry() : entry;
    setImmediate(() => cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock('undici', () => {
  class Agent {
    constructor(readonly opts: { connect: { lookup: (h: string, o: unknown, cb: (...a: unknown[]) => void) => void } }) {}
  }
  // A connection: undici resolves the host through the dispatcher's lookup hook, then talks to it.
  const fetch = async (url: string, init: { dispatcher?: Agent; headers?: HeadersInit }): Promise<Response> => {
    h.sent.push(new Headers(init.headers));
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    await new Promise<void>((resolve, reject) => {
      const hook = init.dispatcher?.opts.connect.lookup;
      if (hook === undefined) return resolve();
      hook(host, { all: true }, (e: unknown) => {
        h.connects.push({ host, ...(e ? { error: String((e as Error).message) } : {}) });
        if (e) reject(new TypeError('fetch failed', { cause: e }));
        else resolve();
      });
    });
    const make = h.responses.get(url);
    const res = make ? make() : new Response('ok', { status: 200 });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  return { Agent, fetch };
});

import { assertSafeOutboundUrl, followRedirectsSafely, pinnedLookup, validateResolvedAddress } from './net-guard.js';

beforeEach(() => {
  h.table.clear();
  h.connects.length = 0;
  h.responses.clear();
  h.sent.length = 0;
  h.table.set('api.openai.com', ['104.18.7.192']);
  h.table.set('example.com', ['93.184.216.34']);
});

describe('assertSafeOutboundUrl', () => {
  it('accepts ordinary https hosts', async () => {
    await expect(assertSafeOutboundUrl('https://api.openai.com/v1/chat')).resolves.toBeInstanceOf(URL);
  });

  it('refuses loopback by default (0.2.0), and accepts http loopback only when allowLoopback', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:4321/x')).rejects.toThrow(/non-HTTPS|loopback/);
    await expect(assertSafeOutboundUrl('https://127.0.0.1/x')).rejects.toThrow(/loopback/);
    await expect(assertSafeOutboundUrl('https://[::1]/x')).rejects.toThrow(/loopback/);
    await expect(assertSafeOutboundUrl('http://localhost:4321/x', { allowLoopback: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://127.0.0.1/x', { allowLoopback: true })).resolves.toBeInstanceOf(URL);
  });

  it('rejects non-https non-loopback', async () => {
    await expect(assertSafeOutboundUrl('http://example.com')).rejects.toThrow(/non-HTTPS/);
  });

  it('rejects AWS metadata IP literal', async () => {
    await expect(assertSafeOutboundUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('rejects GCP metadata hostname', async () => {
    await expect(assertSafeOutboundUrl('https://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow();
  });

  it('rejects Azure metadata hostname', async () => {
    await expect(assertSafeOutboundUrl('https://metadata.azure.internal/metadata/instance')).rejects.toThrow();
  });

  it('rejects RFC1918 IPv4 literals', async () => {
    await expect(assertSafeOutboundUrl('https://10.0.0.5/')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('https://192.168.1.1/')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('https://172.16.0.1/')).rejects.toThrow(/private/);
  });

  it('rejects link-local IPv4', async () => {
    await expect(assertSafeOutboundUrl('https://169.254.10.10/')).rejects.toThrow();
  });

  it('rejects ULA / link-local IPv6 literals', async () => {
    await expect(assertSafeOutboundUrl('https://[fd00::1]/')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('https://[fe80::1]/')).rejects.toThrow(/private/);
  });

  it('rejects IPv4-mapped IPv6 to private ranges', async () => {
    await expect(assertSafeOutboundUrl('https://[::ffff:10.0.0.1]/')).rejects.toThrow(/private/);
  });

  // Security test S3-SSRF-1: these were ATTEMPTED (classified public) before 0.2.0.
  it('rejects CGNAT, NAT64, IPv4-compatible and the other special ranges, judged by the address they embed', async () => {
    const refused = [
      'https://100.64.0.1:9931/', 'https://100.127.255.254/', 'https://[64:ff9b::7f00:1]:9931/', 'https://[64:ff9b::a00:1]/',
      'https://[::7f00:1]:9931/', 'https://[::a00:1]/', 'https://[::ffff:7f00:1]/', 'https://0.1.2.3/', 'https://192.0.0.8/',
      'https://198.18.0.1/', 'https://224.0.0.1/', 'https://240.0.0.1/', 'https://[ff02::1]/', 'https://[fc00::1]/',
    ];
    for (const url of refused) await expect(assertSafeOutboundUrl(url), url).rejects.toThrow(/not allowed/);
  });

  it('checks EVERY address a name resolves to, with the same classifier', async () => {
    h.table.set('cgnat.example.com', ['100.64.0.1']);
    h.table.set('mixed.example.com', ['93.184.216.34', '10.0.0.7']);
    h.table.set('nat64.example.com', ['64:ff9b::a9fe:a9fe']);
    await expect(assertSafeOutboundUrl('https://cgnat.example.com/')).rejects.toThrow(/100\.64\.0\.1.*cgnat/);
    await expect(assertSafeOutboundUrl('https://mixed.example.com/')).rejects.toThrow(/10\.0\.0\.7/);
    await expect(assertSafeOutboundUrl('https://nat64.example.com/')).rejects.toThrow(/link_local/);
  });

  // Security test S3-SSRF-2: a name that did not resolve used to be let through.
  it('refuses a name that does not resolve, and one that resolves to nothing', async () => {
    await expect(assertSafeOutboundUrl('https://pentest-w4-nx.invalid/')).rejects.toThrow(/could not be resolved \(ENOTFOUND\)/);
    h.table.set('again.example.com', Object.assign(new Error('getaddrinfo EAI_AGAIN again.example.com'), { code: 'EAI_AGAIN' }));
    await expect(assertSafeOutboundUrl('https://again.example.com/')).rejects.toThrow(/EAI_AGAIN/);
    h.table.set('empty.example.com', []);
    await expect(assertSafeOutboundUrl('https://empty.example.com/')).rejects.toThrow(/no address/);
  });

  it('rejects .local / .internal hostnames', async () => {
    await expect(assertSafeOutboundUrl('https://my-host.local/')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('https://internal-svc.internal/')).rejects.toThrow(/private/);
  });

  it('rejects bad protocols', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/protocol/);
    await expect(assertSafeOutboundUrl('gopher://x/')).rejects.toThrow(/protocol/);
  });

  it('honours allowedHosts allow-list', async () => {
    await expect(
      assertSafeOutboundUrl('https://evil.example.com/', { allowedHosts: ['api.openai.com'] }),
    ).rejects.toThrow(/allow list/);
    await expect(
      assertSafeOutboundUrl('https://api.openai.com/', { allowedHosts: ['api.openai.com'] }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('honours blockedHosts', async () => {
    await expect(
      assertSafeOutboundUrl('https://bad.example.com/', { blockedHosts: ['bad.example.com'] }),
    ).rejects.toThrow(/blocked/);
  });

  it('allowPrivateNetwork lets RFC1918 and CGNAT through (an operator allowance), never metadata', async () => {
    await expect(assertSafeOutboundUrl('https://10.0.0.5/', { allowPrivateNetwork: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('https://100.64.0.1/', { allowPrivateNetwork: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('https://169.254.169.254/', { allowPrivateNetwork: true })).rejects.toThrow(/blocked/);
  });

  it('uses a lookup the caller passes, for the check', async () => {
    const lookup = vi.fn((_h: string, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '100.100.100.100', family: 4 }]));
    await expect(assertSafeOutboundUrl('https://anything.example.com/', { lookup })).rejects.toThrow(/cgnat/);
    expect(lookup).toHaveBeenCalledWith('anything.example.com', expect.any(Function));
  });
});

describe('validateResolvedAddress and the connect-time lookup hook', () => {
  it('refuses a resolved address in any refused range, and passes a public one', () => {
    for (const a of ['100.64.0.1', '64:ff9b::7f00:1', '::7f00:1', '127.0.0.1', '10.1.2.3']) expect(() => validateResolvedAddress(a), a).toThrow(/rebinding/);
    expect(validateResolvedAddress('93.184.216.34')).toBe('93.184.216.34');
    expect(validateResolvedAddress('127.0.0.1', { allowLoopback: true })).toBe('127.0.0.1');
  });

  it('answers both callback shapes, and refuses the connection unless every address passes', async () => {
    h.table.set('ok.example.com', ['93.184.216.34', '2606:4700::1111']);
    h.table.set('bad.example.com', ['93.184.216.34', '100.64.0.9']);
    const hook = pinnedLookup({});
    const ask = (host: string, opts: unknown): Promise<unknown[]> => new Promise((resolve) => hook(host, opts, (...args: unknown[]) => resolve(args)));
    const all = await ask('ok.example.com', { all: true });
    expect(all[0]).toBeNull();
    expect((all[1] as { address: string }[]).map((a) => a.address)).toEqual(['93.184.216.34', '2606:4700::1111']);
    const one = await ask('ok.example.com', {});
    expect(one.slice(0, 3)).toEqual([null, '93.184.216.34', 4]);
    const refused = await ask('bad.example.com', { all: true });
    expect(String((refused[0] as Error).message)).toMatch(/100\.64\.0\.9/);
    const missing = await ask('nowhere.example.com', { all: true });
    expect((missing[0] as NodeJS.ErrnoException).code).toBe('ENOTFOUND');
  });
});

describe('followRedirectsSafely', () => {
  it('re-validates Location headers against SSRF', async () => {
    const initial = new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    });
    await expect(followRedirectsSafely(initial, undefined, undefined)).rejects.toThrow();
  });

  it('rejects redirects to RFC1918 and to CGNAT', async () => {
    await expect(followRedirectsSafely(new Response(null, { status: 301, headers: { location: 'https://10.0.0.5/' } }), undefined, undefined)).rejects.toThrow(/private/);
    await expect(followRedirectsSafely(new Response(null, { status: 302, headers: { location: 'https://100.64.0.1/' } }), undefined, undefined)).rejects.toThrow(/cgnat/);
    expect(h.connects).toEqual([]);
  });

  // Security test S3-SSRF-3: a hop was checked with one DNS answer and connected with another.
  it('connects each hop to the address that was checked: a name rebound between the check and the connection is refused', async () => {
    let asked = 0;
    h.table.set('rebind.example.com', () => (asked++ === 0 ? ['93.184.216.34'] : ['100.64.0.1']));
    const initial = new Response(null, { status: 302, headers: { location: 'https://rebind.example.com/next' } });
    await expect(followRedirectsSafely(initial, undefined, undefined, {}, 'https://api.openai.com/start')).rejects.toThrow(/fetch failed/);
    expect(h.connects).toEqual([{ host: 'rebind.example.com', error: expect.stringMatching(/100\.64\.0\.1.*rebinding/) }]);
  });

  it('follows a public hop, and drops credentials when the hop leaves the origin', async () => {
    h.table.set('cdn.example.com', ['93.184.216.34']);
    h.responses.set('https://cdn.example.com/blob', () => new Response('done', { status: 200 }));
    const init = { headers: { authorization: 'Bearer sk-secret', 'x-api-key': 'k', accept: 'application/json' } };
    const out = await followRedirectsSafely(new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/blob' } }), init, undefined, {}, 'https://api.openai.com/file');
    expect(await out.text()).toBe('done');
    expect(h.connects).toEqual([{ host: 'cdn.example.com' }]);
    expect(h.sent[0]?.get('authorization')).toBeNull();
    expect(h.sent[0]?.get('x-api-key')).toBeNull();
    expect(h.sent[0]?.get('accept')).toBe('application/json');
  });

  it('returns non-3xx responses untouched', async () => {
    const ok = new Response('hello', { status: 200 });
    const result = await followRedirectsSafely(ok, undefined, undefined);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('hello');
  });

  it('returns 3xx without Location untouched', async () => {
    const noLoc = new Response(null, { status: 302 });
    const result = await followRedirectsSafely(noLoc, undefined, undefined);
    expect(result.status).toBe(302);
  });

  it('rejects invalid Location', async () => {
    const initial = new Response(null, { status: 302, headers: { location: 'http://[::not a url' } });
    await expect(followRedirectsSafely(initial, undefined, undefined)).rejects.toThrow();
  });
});
