import { describe, it, expect } from 'vitest';
import { WeaveIntelError } from './errors.js';
import {
  parseRetryAfterMs,
  httpStatusToErrorCode,
  classifyError,
} from './error-classifier.js';

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('9')).toBe(9000);
  });
  it('clamps to default 30s max', () => {
    expect(parseRetryAfterMs('120')).toBe(30_000);
  });
  it('respects custom maxMs', () => {
    expect(parseRetryAfterMs('120', 60_000, 90_000)).toBe(90_000);
  });
  it('falls back to fallbackMs for invalid header', () => {
    expect(parseRetryAfterMs('not-a-number', 4321)).toBe(4321);
  });
  it('falls back when header missing', () => {
    expect(parseRetryAfterMs(null)).toBe(30_000); // 60_000 fallback clamped to 30_000 max
    expect(parseRetryAfterMs(undefined, 5_000)).toBe(5_000);
  });
  it('parses HTTP-date', () => {
    const inFiveSeconds = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs(inFiveSeconds);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });
});

describe('httpStatusToErrorCode', () => {
  it('maps common statuses', () => {
    expect(httpStatusToErrorCode(429)).toBe('RATE_LIMITED');
    expect(httpStatusToErrorCode(401)).toBe('AUTH_FAILED');
    expect(httpStatusToErrorCode(403)).toBe('PERMISSION_DENIED');
    expect(httpStatusToErrorCode(404)).toBe('NOT_FOUND');
    expect(httpStatusToErrorCode(408)).toBe('TIMEOUT');
    expect(httpStatusToErrorCode(400)).toBe('INVALID_INPUT');
    expect(httpStatusToErrorCode(502)).toBe('PROVIDER_ERROR');
  });
});

describe('classifyError', () => {
  it('classifies RATE_LIMITED with retryAfter and cooldown hint', () => {
    const err = new WeaveIntelError({
      code: 'RATE_LIMITED',
      message: 'too many',
      retryable: true,
      retryAfterMs: 7_000,
    });
    const c = classifyError(err);
    expect(c.class).toBe('rate_limited');
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(7_000);
    expect(c.cooldownHintMs).toBe(7_000);
  });
  it('classifies AUTH_FAILED as non-retryable auth', () => {
    const c = classifyError(new WeaveIntelError({ code: 'AUTH_FAILED', message: 'bad key' }));
    expect(c.class).toBe('auth');
    expect(c.retryable).toBe(false);
  });
  it('classifies INVALID_INPUT as non-retryable', () => {
    const c = classifyError(new WeaveIntelError({ code: 'INVALID_INPUT', message: 'bad' }));
    expect(c.class).toBe('invalid_input');
    expect(c.retryable).toBe(false);
  });
  it('classifies PROVIDER_ERROR as transient and respects retryable flag', () => {
    const c1 = classifyError(new WeaveIntelError({ code: 'PROVIDER_ERROR', message: '500', retryable: true }));
    expect(c1.class).toBe('transient');
    expect(c1.retryable).toBe(true);
    const c2 = classifyError(new WeaveIntelError({ code: 'PROVIDER_ERROR', message: '400', retryable: false }));
    expect(c2.class).toBe('transient');
    expect(c2.retryable).toBe(false);
  });
  it('classifies CANCELLED', () => {
    const c = classifyError(new WeaveIntelError({ code: 'CANCELLED', message: 'aborted' }));
    expect(c.class).toBe('cancelled');
  });
  it('normalises raw Error and unknown values', () => {
    const c1 = classifyError(new Error('boom'));
    expect(c1.cause).toBeInstanceOf(WeaveIntelError);
    expect(c1.class).toBe('transient'); // PROVIDER_ERROR → transient
    const c2 = classifyError('weird');
    expect(c2.cause.code).toBe('INTERNAL_ERROR');
    expect(c2.class).toBe('transient');
  });
  it('treats AbortError as cancelled', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    const c = classifyError(e);
    expect(c.class).toBe('cancelled');
  });
});
