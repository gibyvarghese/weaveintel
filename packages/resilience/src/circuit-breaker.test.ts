import { describe, it, expect } from 'vitest';
import { createCircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows traffic', () => {
    const c = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    expect(c.state()).toBe('closed');
    expect(c.canPass()).toEqual({ allowed: true });
  });

  it('opens after threshold consecutive failures', () => {
    const c = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    c.recordFailure();
    c.recordFailure();
    expect(c.state()).toBe('closed');
    const r = c.recordFailure();
    expect(r.transitionedToOpen).toBe(true);
    expect(c.state()).toBe('open');
    const decision = c.canPass();
    expect(decision.allowed).toBe(false);
  });

  it('resets failure count on success', () => {
    const c = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    c.recordFailure();
    c.recordFailure();
    c.recordSuccess();
    c.recordFailure();
    c.recordFailure();
    expect(c.state()).toBe('closed');
  });

  it('transitions open → half_open after cooldown, then closed on success', async () => {
    const c = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30 });
    c.recordFailure();
    expect(c.state()).toBe('open');
    await new Promise((r) => setTimeout(r, 50));
    expect(c.state()).toBe('half_open');
    expect(c.canPass()).toEqual({ allowed: true });
    c.recordSuccess();
    expect(c.state()).toBe('closed');
  });

  it('half_open → open again on probe failure', async () => {
    const c = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30 });
    c.recordFailure();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.state()).toBe('half_open');
    const r = c.recordFailure();
    expect(r.transitionedToOpen).toBe(true);
    expect(c.state()).toBe('open');
  });
});
