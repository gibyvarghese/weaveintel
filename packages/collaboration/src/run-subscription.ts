// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Durable run subscriptions (Collaboration Phase 3).
 *
 * A "subscription" is a DURABLE interest in a run's outcome: "tell me when this
 * run finishes, even if I close the tab." It is the opposite of presence (Phase
 * 1), which is ephemeral and only meaningful while you are actively watching.
 *
 * --- For someone new to this ---
 * Presence answers "who is watching RIGHT NOW" — it disappears the moment you
 * leave. A subscription answers "who wants to KNOW when it's done" — it sticks
 * around in the database until you cancel it, so the system can notify you later
 * (in-app, email, push, webhook) when the run completes or fails, long after you
 * walked away. Think of it like clicking "Watch" / "Notify me" on a long build.
 *
 * Ports & adapters (same pattern as Phase 0/1/2): the {@link SubscriptionManager}
 * PORT + an in-memory reference adapter live here; geneWeave provides a SQL
 * adapter over a `run_subscriptions` table so subscriptions survive a process
 * restart (the whole point — a notification you might owe someone must not live
 * only in RAM). Both adapters pass {@link subscriptionManagerContract}.
 *
 * Delivery itself is NOT this port's job. This port only records WHO wants to be
 * told and OVER WHICH CHANNELS. The host (geneWeave) drains a durable outbox on
 * terminal run events and hands each subscriber to `@weaveintel/notifications`.
 * Keeping "who is interested" (here) separate from "how we deliver" (notifications)
 * is what lets either side evolve without touching the other.
 */

/** Delivery channels a subscriber can opt into. `inapp` is always implied. */
export type SubscriptionChannel = 'inapp' | 'email' | 'push' | 'webhook';

export interface RunSubscription {
  /** The run being watched. */
  readonly runId: string;
  /** Tenant scope — every subscription is tenant-isolated by construction. */
  readonly tenantId: string;
  /** The subscriber (server-derived identity — never client-supplied). */
  readonly userId: string;
  /** Channels to deliver over. `inapp` is always included even if omitted. */
  readonly channels: readonly SubscriptionChannel[];
  /** When the subscription was created (ms epoch). */
  readonly createdAt: number;
}

export interface SubscribeInput {
  runId: string;
  tenantId: string;
  userId: string;
  /** Defaults to `['inapp']`. `inapp` is always added if missing. */
  channels?: readonly SubscriptionChannel[];
}

export interface SubscriptionManager {
  /**
   * Record (or update) a durable subscription. Idempotent per (run, user):
   * subscribing again replaces the channel set and returns the row.
   */
  subscribe(input: SubscribeInput): Promise<RunSubscription>;
  /** Remove a subscription. Idempotent — unsubscribing twice is a no-op. */
  unsubscribe(runId: string, userId: string): Promise<void>;
  /** Whether `userId` is subscribed to `runId`. */
  isSubscribed(runId: string, userId: string): Promise<boolean>;
  /** A single subscription, or null. */
  get(runId: string, userId: string): Promise<RunSubscription | null>;
  /** Everyone subscribed to a run — the notification fan-out list. */
  listSubscribers(runId: string): Promise<RunSubscription[]>;
  /** Every run a user is subscribed to (for "my watched runs"). */
  listForUser(userId: string): Promise<RunSubscription[]>;
}

/** Normalize a channel set: always include `inapp`, dedupe, stable order. */
export function normalizeChannels(channels?: readonly SubscriptionChannel[]): SubscriptionChannel[] {
  const order: SubscriptionChannel[] = ['inapp', 'email', 'push', 'webhook'];
  const want = new Set<SubscriptionChannel>(channels ?? []);
  want.add('inapp'); // in-app feed is always on — it is the durable record of the notification
  return order.filter((c) => want.has(c));
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemorySubscriptionManagerOptions {
  now?: () => number;
}

export function createInMemorySubscriptionManager(opts: InMemorySubscriptionManagerOptions = {}): SubscriptionManager {
  const now = opts.now ?? (() => Date.now());
  // key = `${runId}::${userId}` → subscription
  const subs = new Map<string, RunSubscription>();
  const key = (runId: string, userId: string) => `${runId}::${userId}`;

  return {
    async subscribe(input) {
      const sub: RunSubscription = {
        runId: input.runId,
        tenantId: input.tenantId,
        userId: input.userId,
        channels: normalizeChannels(input.channels),
        // Preserve the original createdAt on re-subscribe (idempotent update).
        createdAt: subs.get(key(input.runId, input.userId))?.createdAt ?? now(),
      };
      subs.set(key(input.runId, input.userId), sub);
      return sub;
    },
    async unsubscribe(runId, userId) {
      subs.delete(key(runId, userId));
    },
    async isSubscribed(runId, userId) {
      return subs.has(key(runId, userId));
    },
    async get(runId, userId) {
      return subs.get(key(runId, userId)) ?? null;
    },
    async listSubscribers(runId) {
      return [...subs.values()].filter((s) => s.runId === runId);
    },
    async listForUser(userId) {
      return [...subs.values()].filter((s) => s.userId === userId);
    },
  };
}
