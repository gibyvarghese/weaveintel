// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemorySubscriptionManager,
  normalizeChannels,
  type SubscriptionManager,
} from './run-subscription.js';
import { subscriptionManagerContract } from './run-subscription-contract.js';

// The in-memory reference adapter must pass the shared contract.
subscriptionManagerContract(() => createInMemorySubscriptionManager(), { describe, it, beforeEach, expect } as never);

describe('normalizeChannels', () => {
  it('always includes inapp, dedupes, and uses a stable order', () => {
    expect(normalizeChannels()).toEqual(['inapp']);
    expect(normalizeChannels(['webhook', 'inapp', 'webhook'])).toEqual(['inapp', 'webhook']);
    expect(normalizeChannels(['push', 'email'])).toEqual(['inapp', 'email', 'push']);
  });
});

describe('SubscriptionManager — security & stress (in-memory)', () => {
  let mgr: SubscriptionManager;
  beforeEach(() => { mgr = createInMemorySubscriptionManager(); });

  it('keeps subscriptions tenant- and user-isolated', async () => {
    await mgr.subscribe({ runId: 'r1', tenantId: 'tA', userId: 'alice' });
    await mgr.subscribe({ runId: 'r1', tenantId: 'tB', userId: 'bob' });
    // listSubscribers is per-run; both appear, but each row keeps its own tenant.
    const subs = await mgr.listSubscribers('r1');
    expect(subs.find((s) => s.userId === 'alice')?.tenantId).toBe('tA');
    expect(subs.find((s) => s.userId === 'bob')?.tenantId).toBe('tB');
  });

  it('re-subscribe preserves createdAt (stable identity, no churn)', async () => {
    let t = 1000;
    const m = createInMemorySubscriptionManager({ now: () => t });
    const first = await m.subscribe({ runId: 'r1', tenantId: 'tA', userId: 'alice' });
    t = 5000;
    const second = await m.subscribe({ runId: 'r1', tenantId: 'tA', userId: 'alice', channels: ['email'] });
    expect(second.createdAt).toBe(first.createdAt); // unchanged
  });

  it('handles a large fan-out list', async () => {
    for (let i = 0; i < 500; i++) await mgr.subscribe({ runId: 'big', tenantId: 'tA', userId: `u${i}` });
    expect((await mgr.listSubscribers('big')).length).toBe(500);
    await mgr.unsubscribe('big', 'u250');
    expect((await mgr.listSubscribers('big')).length).toBe(499);
    expect(await mgr.isSubscribed('big', 'u250')).toBe(false);
  });
});
