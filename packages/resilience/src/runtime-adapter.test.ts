import { describe, it, expect, beforeEach } from 'vitest';
import {
  createResilienceSignalBus,
  createRuntimeResilienceAdapter,
  getOrCreateEndpointState,
  _resetEndpointRegistry,
} from './index.js';

describe('createRuntimeResilienceAdapter', () => {
  beforeEach(() => {
    _resetEndpointRegistry();
  });

  it('implements RuntimeResilienceSlot.emit by forwarding to the bus', () => {
    const bus = createResilienceSignalBus();
    const adapter = createRuntimeResilienceAdapter(bus);
    const received: string[] = [];
    bus.on((sig) => received.push(sig.kind));

    adapter.emit({ kind: 'success', endpoint: 'openai:rest', meta: {} });
    expect(received).toContain('success');
  });

  it('getState returns "unknown" for an unregistered endpoint', () => {
    const adapter = createRuntimeResilienceAdapter(createResilienceSignalBus());
    expect(adapter.getState?.('non-existent')).toBe('unknown');
  });

  it('getState returns "closed" for a freshly-registered circuit breaker', () => {
    getOrCreateEndpointState('anthropic:rest', {
      circuit: { failureThreshold: 5, cooldownMs: 10_000 },
    });
    const adapter = createRuntimeResilienceAdapter(createResilienceSignalBus());
    expect(adapter.getState?.('anthropic:rest')).toBe('closed');
  });

  it('getState returns "open" after failureThreshold failures', () => {
    const ep = getOrCreateEndpointState('openai:chat', {
      circuit: { failureThreshold: 3, cooldownMs: 60_000 },
    });
    for (let i = 0; i < 3; i++) ep.circuit!.recordFailure();

    const adapter = createRuntimeResilienceAdapter(createResilienceSignalBus());
    expect(adapter.getState?.('openai:chat')).toBe('open');
  });

  it('getLatencyP50 returns null when no samples recorded', () => {
    const adapter = createRuntimeResilienceAdapter(createResilienceSignalBus());
    expect(adapter.getLatencyP50?.('no-samples')).toBeNull();
  });

  it('exposes on/onKind/clear from the underlying bus', () => {
    const bus = createResilienceSignalBus();
    const adapter = createRuntimeResilienceAdapter(bus);
    expect(typeof adapter.on).toBe('function');
    expect(typeof adapter.onKind).toBe('function');
    expect(typeof adapter.clear).toBe('function');

    const heard: string[] = [];
    adapter.on((sig) => heard.push(sig.kind));
    bus.emit({ kind: 'circuit_closed', endpoint: 'test', at: Date.now() });
    expect(heard).toContain('circuit_closed');
  });

  it('adapter satisfies RuntimeResilienceSlot structural shape', () => {
    const adapter = createRuntimeResilienceAdapter(createResilienceSignalBus());
    // Ensure emit, getState, getLatencyP50, getLatencyP95 all exist
    expect(typeof adapter.emit).toBe('function');
    expect(typeof adapter.getState).toBe('function');
    expect(typeof adapter.getLatencyP50).toBe('function');
    expect(typeof adapter.getLatencyP95).toBe('function');
  });
});
