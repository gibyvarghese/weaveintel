import { describe, it, expect } from 'vitest';
import { assertSafeOutboundUrl, followRedirectsSafely } from './net-guard.js';

describe('assertSafeOutboundUrl', () => {
  it('accepts ordinary https hosts', async () => {
    await expect(assertSafeOutboundUrl('https://api.openai.com/v1/chat')).resolves.toBeInstanceOf(URL);
  });

  it('accepts http loopback when allowLoopback (default)', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:4321/x')).resolves.toBeInstanceOf(URL);
    await expect(assertSafeOutboundUrl('http://127.0.0.1/x')).resolves.toBeInstanceOf(URL);
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

  it('allowPrivateNetwork lets RFC1918 through', async () => {
    await expect(
      assertSafeOutboundUrl('https://10.0.0.5/', { allowPrivateNetwork: true }),
    ).resolves.toBeInstanceOf(URL);
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

  it('rejects redirects to RFC1918', async () => {
    const initial = new Response(null, { status: 301, headers: { location: 'https://10.0.0.5/' } });
    await expect(followRedirectsSafely(initial, undefined, undefined)).rejects.toThrow(/private/);
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
