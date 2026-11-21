import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = (_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void): void => {
    setImmediate(() => cb(null, [{ address: '169.254.169.254', family: 4 }]));
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

import { assertSafeOutboundUrl } from './net-guard.js';

describe('outbound DNS validation', () => {
  it('blocks a hostname resolving to metadata even when private networks are enabled', async () => {
    await expect(assertSafeOutboundUrl('https://collector.example/', { allowPrivateNetwork: true }))
      .rejects.toThrow(/blocked outbound address/);
  });
});
