import { describe, expect, it } from 'vitest';

import { readResponseTextLimited, validateOutboundUrl } from './net-guard.js';

describe('net-guard', () => {
  it('rejects metadata hosts', async () => {
    await expect(validateOutboundUrl('http://metadata.google.internal/compute')).rejects.toThrow(/Blocked outbound host/);
  });

  it('allows private host when explicitly enabled', async () => {
    const parsed = await validateOutboundUrl('http://127.0.0.1/health', {
      allowPrivateNetwork: true,
      allowedHosts: ['127.0.0.1'],
    });
    expect(parsed.hostname).toBe('127.0.0.1');
  });

  it('caps body by content-length', async () => {
    const response = new Response('ok', {
      status: 200,
      headers: { 'content-length': '1024' },
    });

    await expect(readResponseTextLimited(response, 10)).rejects.toThrow(/Response exceeds max size/);
  });
});
