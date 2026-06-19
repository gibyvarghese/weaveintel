/**
 * Unit tests — createRuntimeRoutingAdapter (Phase 2)
 *
 * Verifies that the adapter correctly bridges ModelHealthTracker to the
 * RuntimeRoutingSlot interface so both the chat path and live-agent supervisor
 * can share one health-tracking instance via the runtime DI container.
 */

import { describe, it, expect } from 'vitest';
import { ModelHealthTracker } from './health.js';
import { createRuntimeRoutingAdapter } from './runtime-routing-adapter.js';

describe('createRuntimeRoutingAdapter', () => {
  it('returns an object satisfying RuntimeRoutingSlot shape', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);
    expect(typeof slot.recordOutcome).toBe('function');
    expect(typeof slot.blockProvider).toBe('function');
    expect(typeof slot.listHealth).toBe('function');
    expect(typeof slot.getBlockedProviders).toBe('function');
  });

  it('recordOutcome delegates to tracker.record — outcome appears in listHealth()', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);

    slot.recordOutcome('claude-sonnet-4-6', 'anthropic', 120, true);

    const health = slot.listHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.modelId).toBe('claude-sonnet-4-6');
    expect(health[0]!.providerId).toBe('anthropic');
    expect(health[0]!.avgLatencyMs).toBeGreaterThan(0);
  });

  it('blockProvider delegates to tracker — provider appears in getBlockedProviders()', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);

    expect(slot.getBlockedProviders().size).toBe(0);

    slot.blockProvider('openai', 60_000);

    const blocked = slot.getBlockedProviders();
    expect(blocked.has('openai')).toBe(true);
  });

  it('listHealth returns all tracked models', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);

    slot.recordOutcome('claude-sonnet-4-6', 'anthropic', 100, true);
    slot.recordOutcome('gpt-4o', 'openai', 200, true);
    slot.recordOutcome('claude-haiku-4-5-20251001', 'anthropic', 80, false);

    const health = slot.listHealth();
    expect(health).toHaveLength(3);
    const modelIds = health.map((h) => h.modelId).sort();
    expect(modelIds).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'gpt-4o',
    ].sort());
  });

  it('getBlockedProviders returns empty set when no blocks are active', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);
    expect(slot.getBlockedProviders()).toBeInstanceOf(Set);
    expect(slot.getBlockedProviders().size).toBe(0);
  });

  it('multiple failures do not crash — adapter is always safe to call', () => {
    const tracker = new ModelHealthTracker();
    const slot = createRuntimeRoutingAdapter(tracker);

    for (let i = 0; i < 10; i++) {
      slot.recordOutcome('gpt-4o-mini', 'openai', 50 + i * 10, i % 3 !== 0);
    }

    expect(() => slot.listHealth()).not.toThrow();
    expect(() => slot.getBlockedProviders()).not.toThrow();
  });

  it('two adapters wrapping the same tracker share state', () => {
    const tracker = new ModelHealthTracker();
    const slotA = createRuntimeRoutingAdapter(tracker);
    const slotB = createRuntimeRoutingAdapter(tracker);

    // Chat path records through slotA
    slotA.recordOutcome('claude-sonnet-4-6', 'anthropic', 150, true);

    // Supervisor reads through slotB — same underlying tracker
    const health = slotB.listHealth();
    expect(health).toHaveLength(1);
    expect(health[0]!.modelId).toBe('claude-sonnet-4-6');
  });

  it('blockProvider from slotA is visible in slotB.getBlockedProviders()', () => {
    const tracker = new ModelHealthTracker();
    const slotA = createRuntimeRoutingAdapter(tracker);
    const slotB = createRuntimeRoutingAdapter(tracker);

    slotA.blockProvider('google', 30_000);

    expect(slotB.getBlockedProviders().has('google')).toBe(true);
  });
});
