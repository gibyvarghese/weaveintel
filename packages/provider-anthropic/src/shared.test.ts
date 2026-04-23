import { describe, expect, it, vi, afterEach } from 'vitest';
import { anthropicStreamRequest, parseRetryAfterMs } from './shared.js';

describe('anthropic shared retry-after parsing', () => {
  it('parses delta-seconds retry-after', () => {
    expect(parseRetryAfterMs('9')).toBe(9000);
  });

  it('falls back for invalid retry-after', () => {
    expect(parseRetryAfterMs('invalid', 4321)).toBe(4321);
  });
});

describe('anthropic stream error classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns RATE_LIMITED with retry-after metadata for 429 streams', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'too many requests' } }), {
        status: 429,
        headers: { 'retry-after': '3' },
      }),
    );

    const run = async () => {
      for await (const _chunk of anthropicStreamRequest('https://example.com', '/v1/messages', {}, {})) {
        // no-op
      }
    };

    await expect(run()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 3000,
    });
  });
});
