import { describe, expect, it, vi, afterEach } from 'vitest';
import { openaiStreamRequest, parseRetryAfterMs } from './shared.js';

describe('openai shared retry-after parsing', () => {
  it('parses delta-seconds retry-after', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
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
});
