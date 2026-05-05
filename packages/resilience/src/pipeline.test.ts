import { describe, it, expect, beforeEach } from 'vitest';
import { WeaveIntelError } from '@weaveintel/core';
import {
  createResilientCallable,
  createResilienceSignalBus,
  _resetEndpointRegistry,
  type ResilienceSignal,
} from './index.js';

describe('createResilientCallable', () => {
  beforeEach(() => {
    _resetEndpointRegistry();
  });

  it('calls fn and emits success', async () => {
    const bus = createResilienceSignalBus();
    const signals: ResilienceSignal[] = [];
    bus.on((s) => signals.push(s));
    const callable = createResilientCallable(async (x: number) => x * 2, {
      endpoint: 'test:double',
      signalBus: bus,
    });
    await expect(callable(21)).resolves.toBe(42);
    expect(signals.find((s) => s.kind === 'success')).toBeDefined();
  });

  it('retries on retryable error and emits retrying signal', async () => {
    const bus = createResilienceSignalBus();
    const signals: ResilienceSignal[] = [];
    bus.on((s) => signals.push(s));

    let attempts = 0;
    const callable = createResilientCallable(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new WeaveIntelError({
            code: 'PROVIDER_ERROR',
            message: '503',
            retryable: true,
          });
        }
        return 'ok';
      },
      {
        endpoint: 'test:retry',
        signalBus: bus,
        retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
      },
    );

    await expect(callable()).resolves.toBe('ok');
    expect(attempts).toBe(3);
    const retries = signals.filter((s) => s.kind === 'retrying');
    expect(retries.length).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    const callable = createResilientCallable(
      async () => {
        throw new WeaveIntelError({ code: 'AUTH_FAILED', message: 'bad key' });
      },
      {
        endpoint: 'test:auth',
        retry: { maxAttempts: 5, baseDelayMs: 1, jitter: false },
      },
    );
    await expect(callable()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('honours retryAfterMs and pauses bucket on RATE_LIMITED', async () => {
    const bus = createResilienceSignalBus();
    const signals: ResilienceSignal[] = [];
    bus.on((s) => signals.push(s));

    let attempts = 0;
    const callable = createResilientCallable(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new WeaveIntelError({
            code: 'RATE_LIMITED',
            message: '429',
            retryable: true,
            retryAfterMs: 30,
          });
        }
        return 'ok';
      },
      {
        endpoint: 'test:rate',
        signalBus: bus,
        rateLimit: { capacity: 5, refillPerSec: 100 },
        retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      },
    );

    const start = Date.now();
    await expect(callable()).resolves.toBe('ok');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(signals.find((s) => s.kind === 'rate_limited')).toBeDefined();
  });

  it('opens circuit after threshold failures and sheds further calls', async () => {
    const bus = createResilienceSignalBus();
    const signals: ResilienceSignal[] = [];
    bus.on((s) => signals.push(s));

    const callable = createResilientCallable(
      async () => {
        throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: '500', retryable: false });
      },
      {
        endpoint: 'test:circuit',
        signalBus: bus,
        circuit: { failureThreshold: 2, cooldownMs: 1000 },
        retry: { maxAttempts: 1 },
      },
    );

    await expect(callable()).rejects.toBeDefined();
    await expect(callable()).rejects.toBeDefined();
    // circuit should now be open
    await expect(callable()).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(signals.find((s) => s.kind === 'circuit_opened')).toBeDefined();
    expect(signals.find((s) => s.kind === 'shed' && s.reason === 'circuit_open')).toBeDefined();
  });

  it('fail-fast override throws RATE_LIMITED instead of waiting', async () => {
    const callable = createResilientCallable(async () => 'ok', {
      endpoint: 'test:failfast',
      rateLimit: { capacity: 1, refillPerSec: 1 },
      retry: { maxAttempts: 1 },
    });
    await callable(); // exhaust the single token
    const failFast = callable.withOverrides({ rateLimitMode: 'fail-fast' });
    await expect(failFast()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('shares state across callables for the same endpoint', async () => {
    const bus = createResilienceSignalBus();
    const signals: ResilienceSignal[] = [];
    bus.on((s) => signals.push(s));

    const a = createResilientCallable(async () => 'a', {
      endpoint: 'test:shared',
      signalBus: bus,
      circuit: { failureThreshold: 1, cooldownMs: 1000 },
      rateLimit: { capacity: 5, refillPerSec: 100 },
      retry: { maxAttempts: 1 },
    });
    const b = createResilientCallable(
      async () => {
        throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: '500', retryable: false });
      },
      {
        endpoint: 'test:shared',
        signalBus: bus,
        // these opts are IGNORED — first writer wins
        circuit: { failureThreshold: 99, cooldownMs: 1 },
        retry: { maxAttempts: 1 },
      },
    );

    await expect(b()).rejects.toBeDefined();
    // shared circuit is now open — a (the success path) is also shed
    await expect(a()).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });

  it('emits failed signal with classified cause', async () => {
    const bus = createResilienceSignalBus();
    const failed: ResilienceSignal[] = [];
    bus.onKind('failed', (s) => failed.push(s));

    const callable = createResilientCallable(
      async () => {
        throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'bad' });
      },
      { endpoint: 'test:invalid', signalBus: bus, retry: { maxAttempts: 1 } },
    );
    await expect(callable()).rejects.toBeDefined();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'failed', endpoint: 'test:invalid' });
  });

  it('respects timeoutMs', async () => {
    const callable = createResilientCallable(
      async () => new Promise((r) => setTimeout(() => r('late'), 200)),
      {
        endpoint: 'test:timeout',
        timeoutMs: 30,
        retry: { maxAttempts: 1 },
      },
    );
    await expect(callable()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
