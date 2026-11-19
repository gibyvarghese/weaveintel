import { describe, expect, it, vi } from 'vitest';
import { assertSafeOutboundUrl } from './net-guard.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '169.254.169.254', family: 4 }]),
}));

describe('outbound DNS validation', () => {
  it('blocks a hostname resolving to metadata even when private networks are enabled', async () => {
    await expect(assertSafeOutboundUrl('https://collector.example/', { allowPrivateNetwork: true }))
      .rejects.toThrow(/blocked outbound address/);
  });
});
