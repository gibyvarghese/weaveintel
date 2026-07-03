// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link NotificationFeedStore} adapter (Phase 3).
 * The in-memory reference adapter and a consuming app's SQL adapter must both pass it.
 */
import type { NotificationFeedStore, FeedNotification } from './feed.js';

export interface FeedContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    [k: string]: unknown;
  };
}

let counter = 0;
function row(over: Partial<FeedNotification> = {}): FeedNotification {
  counter++;
  return {
    id: `n-${counter}`,
    tenantId: 'tA',
    principalId: 'alice',
    category: 'run',
    title: `Run finished ${counter}`,
    priority: 'normal',
    createdAt: counter, // monotonic so ordering is deterministic
    readAt: null,
    ...over,
  };
}

export function notificationFeedStoreContract(make: () => Promise<NotificationFeedStore> | NotificationFeedStore, t: FeedContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('NotificationFeedStore contract', () => {
    let store: NotificationFeedStore;
    beforeEach(async () => { store = await make(); });

    it('append then list returns the row, most-recent-first', async () => {
      await store.append(row({ id: 'a', createdAt: 1 }));
      await store.append(row({ id: 'b', createdAt: 2 }));
      const list = await store.list('tA', 'alice');
      expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('unread count and mark-read transitions', async () => {
      await store.append(row({ id: 'a' }));
      await store.append(row({ id: 'b' }));
      expect(await store.unreadCount('tA', 'alice')).toBe(2);
      expect(await store.markRead('tA', 'alice', 'a')).toBe(true);
      expect(await store.unreadCount('tA', 'alice')).toBe(1);
      expect(await store.markRead('tA', 'alice', 'a')).toBe(false); // already read
    });

    it('mark-all-read clears every unread row', async () => {
      await store.append(row({ id: 'a' }));
      await store.append(row({ id: 'b' }));
      expect(await store.markAllRead('tA', 'alice')).toBe(2);
      expect(await store.unreadCount('tA', 'alice')).toBe(0);
      expect(await store.markAllRead('tA', 'alice')).toBe(0); // idempotent
    });

    it('unreadOnly + limit filter the list', async () => {
      await store.append(row({ id: 'a', createdAt: 1 }));
      await store.append(row({ id: 'b', createdAt: 2 }));
      await store.markRead('tA', 'alice', 'a');
      expect((await store.list('tA', 'alice', { unreadOnly: true })).map((r) => r.id)).toEqual(['b']);
      expect((await store.list('tA', 'alice', { limit: 1 })).map((r) => r.id)).toEqual(['b']);
    });

    it('dedupeKey makes append idempotent per principal (at-least-once safeguard)', async () => {
      const first = await store.append(row({ id: 'a', dedupeKey: 'run-1:terminal' }));
      const second = await store.append(row({ id: 'b', dedupeKey: 'run-1:terminal' }));
      expect(second.id).toBe(first.id);             // same row returned
      expect((await store.list('tA', 'alice')).length).toBe(1); // not duplicated
    });

    it('is tenant- and principal-isolated', async () => {
      await store.append(row({ id: 'a', principalId: 'alice', tenantId: 'tA' }));
      await store.append(row({ id: 'b', principalId: 'bob', tenantId: 'tA' }));
      await store.append(row({ id: 'c', principalId: 'alice', tenantId: 'tB' }));
      expect((await store.list('tA', 'alice')).map((r) => r.id)).toEqual(['a']);
      expect(await store.unreadCount('tA', 'bob')).toBe(1);
      // Cross-principal mark-read does nothing.
      expect(await store.markRead('tA', 'bob', 'a')).toBe(false);
    });
  });
}
