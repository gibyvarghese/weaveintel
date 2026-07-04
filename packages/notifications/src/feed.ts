// SPDX-License-Identifier: MIT
/**
 * In-app notification FEED — the durable, per-user inbox (Collaboration Phase 3).
 *
 * Every other channel (webhook / push / email) leaves the platform; the in-app
 * feed is the one that STAYS — it is the durable record a user sees in the bell
 * menu ("3 unread"). It is therefore always-on: a subscription implies an in-app
 * feed row even when no device/webhook is registered.
 *
 * --- For someone new to this ---
 * Think of the little 🔔 with a red badge. Each entry is one notification for one
 * person ("your run finished"). "Fan-out on write" means: when a run finishes we
 * write ONE row per interested user up front, so showing the inbox later is a
 * cheap read and the unread count is a single COUNT. Marking all read is a single
 * UPDATE. Dedupe (by a stable key) stops the same event creating two rows if the
 * delivery pipeline runs twice (it is "at-least-once" by design).
 *
 * Ports & adapters: the {@link NotificationFeedStore} PORT + an in-memory
 * reference adapter live here; a consuming app provides a SQL adapter over
 * `notification_feed`. Both pass {@link notificationFeedStoreContract}.
 * {@link createInAppChannel} is a {@link NotificationChannel} that writes to the
 * store, so the in-app feed plugs into the SAME dispatcher fan-out as the
 * outbound channels (and honours the same suppression policy).
 */
import { newUUIDv7 } from '@weaveintel/core';
import type {
  NotificationChannel,
  NotificationMessage,
  ChannelTarget,
  NotificationDelivery,
  ExecutionContext,
  CapabilityId,
} from '@weaveintel/core';

/** The channel id the in-app feed registers under (and the synthetic target kind). */
export const INAPP_CHANNEL_ID = 'inapp';

export interface FeedNotification {
  id: string;
  tenantId: string;
  /** Recipient (server-derived identity — never client-supplied). */
  principalId: string;
  category: string;
  title: string;
  body?: string;
  /** Opaque deep link (`app://run/<id>`) — never contains tenant/principal ids. */
  deepLink?: string;
  priority: 'low' | 'normal' | 'high';
  createdAt: number;
  /** null = unread. A non-null read timestamp marks it read. */
  readAt: number | null;
  /**
   * Optional stable idempotency key. Two appends with the SAME (principalId,
   * dedupeKey) collapse to one row — the safeguard for at-least-once delivery.
   */
  dedupeKey?: string;
}

export interface FeedListOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export interface NotificationFeedStore {
  /**
   * Append a feed row. Idempotent on (principalId, dedupeKey) when a dedupeKey is
   * present: a second append with the same key returns the existing row instead
   * of inserting a duplicate.
   */
  append(n: FeedNotification): Promise<FeedNotification>;
  /** Most-recent-first list for a user, optionally unread-only / limited. */
  list(tenantId: string, principalId: string, opts?: FeedListOptions): Promise<FeedNotification[]>;
  /** Count of unread rows (the badge number). */
  unreadCount(tenantId: string, principalId: string): Promise<number>;
  /** Mark one row read (no-op if already read / not owned). Returns true if it changed. */
  markRead(tenantId: string, principalId: string, id: string): Promise<boolean>;
  /** Mark every unread row read; returns how many changed. */
  markAllRead(tenantId: string, principalId: string): Promise<number>;
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemoryFeedStoreOptions {
  now?: () => number;
}

export function createInMemoryFeedStore(opts: InMemoryFeedStoreOptions = {}): NotificationFeedStore {
  const now = opts.now ?? (() => Date.now());
  const rows: FeedNotification[] = [];
  const dedupe = new Map<string, FeedNotification>(); // `${principalId}::${dedupeKey}` → row

  function owned(tenantId: string, principalId: string): FeedNotification[] {
    return rows.filter((r) => r.tenantId === tenantId && r.principalId === principalId);
  }

  return {
    async append(n) {
      if (n.dedupeKey) {
        const k = `${n.principalId}::${n.dedupeKey}`;
        const existing = dedupe.get(k);
        if (existing) return existing; // idempotent — at-least-once safeguard
        rows.push(n);
        dedupe.set(k, n);
        return n;
      }
      rows.push(n);
      return n;
    },
    async list(tenantId, principalId, listOpts) {
      let mine = owned(tenantId, principalId).sort((a, b) => b.createdAt - a.createdAt);
      if (listOpts?.unreadOnly) mine = mine.filter((r) => r.readAt === null);
      return typeof listOpts?.limit === 'number' ? mine.slice(0, listOpts.limit) : mine;
    },
    async unreadCount(tenantId, principalId) {
      return owned(tenantId, principalId).filter((r) => r.readAt === null).length;
    },
    async markRead(tenantId, principalId, id) {
      const row = owned(tenantId, principalId).find((r) => r.id === id);
      if (!row || row.readAt !== null) return false;
      row.readAt = now();
      return true;
    },
    async markAllRead(tenantId, principalId) {
      let changed = 0;
      for (const row of owned(tenantId, principalId)) {
        if (row.readAt === null) { row.readAt = now(); changed++; }
      }
      return changed;
    },
  };
}

// ─── In-app channel (writes to the feed via the dispatcher pipeline) ────────────

export interface InAppChannelOptions {
  id?: string;
  now?: () => number;
}

/**
 * A {@link NotificationChannel} that records a notification into the in-app
 * {@link NotificationFeedStore} instead of sending it anywhere external. Register
 * it alongside webhook/push channels so `dispatcher.notify(...)` writes the feed
 * row through the same path (and the same suppression policy) as outbound
 * delivery. The message's `id` doubles as the dedupe key, so a redelivered event
 * never creates a duplicate inbox row.
 */
export function createInAppChannel(store: NotificationFeedStore, opts: InAppChannelOptions = {}): NotificationChannel {
  const id = opts.id ?? INAPP_CHANNEL_ID;
  const now = opts.now ?? (() => Date.now());
  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(_ctx: ExecutionContext, msg: NotificationMessage, _target: ChannelTarget): Promise<NotificationDelivery> {
      try {
        await store.append({
          id: newUUIDv7(),
          tenantId: msg.tenantId,
          principalId: msg.principalId,
          category: msg.category,
          title: msg.title,
          ...(msg.body ? { body: msg.body } : {}),
          ...(msg.deepLink ? { deepLink: msg.deepLink } : {}),
          priority: msg.priority ?? 'normal',
          createdAt: now(),
          readAt: null,
          dedupeKey: msg.id, // the event's id is its idempotency key
        });
        return { channelId: id, messageId: msg.id, status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: msg.id, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
