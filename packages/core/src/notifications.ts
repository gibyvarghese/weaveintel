/**
 * @weaveintel/core — Notification channel contracts
 *
 * Transport-agnostic notification primitives.  The framework defines the shape;
 * channel adapters (webhook, web-push, APNs, FCM) live in
 * `@weaveintel/notifications`.
 *
 * Vocabulary rule: "notification" is platform-level; words like "push", "alert",
 * and "delivery" are fine.  "chat" / "message" / "conversation" must not appear.
 */

import type { ExecutionContext } from './context.js';
import type { CapabilityId } from './capabilities.js';

// ─── Category ────────────────────────────────────────────────────────────────

/**
 * Broad grouping that receivers use for preference filtering and quiet-hours
 * suppression.
 * - `task`     — approval, action-item, or other human-task event.
 * - `run`      — a run the principal cares about completed, failed, etc.
 * - `reminder` — a reminder trigger fired.
 * - `system`   — platform-level (quota, security, outage).
 * - `custom`   — application-defined; consumers may add sub-categories via `data`.
 */
export type NotificationCategory = 'task' | 'run' | 'reminder' | 'system' | 'custom';

// ─── Notification message ─────────────────────────────────────────────────────

/**
 * A single notification to be delivered to a principal via one or more channels.
 *
 * Producers fill this in; the `NotificationDispatcher` fans it out.
 */
export interface NotificationMessage {
  /** Unique identifier for idempotency. UUID v7 recommended. */
  readonly id: string;
  /** Tenant context — used for routing, suppression, and logging. */
  readonly tenantId: string;
  /** Intended recipient principal. */
  readonly principalId: string;
  /** Category for preference-based filtering. */
  readonly category: NotificationCategory;
  /** Short display title (max ~100 chars recommended). */
  readonly title: string;
  /** Optional body text rendered below the title. */
  readonly body?: string;
  /**
   * App-defined URI clients use to navigate to the relevant screen.
   * Framework treats this as opaque (e.g. `geneweave://run/<id>`).
   */
  readonly deepLink?: string;
  /**
   * Quick-action buttons the user can tap in the notification shade.
   * Tapping posts the action's `id` back to the server.
   */
  readonly actions?: ReadonlyArray<{ id: string; label: string }>;
  /** Arbitrary payload passed through to clients — keep small. */
  readonly data?: Record<string, unknown>;
  /**
   * Collapse/dedup key — a new notification with the same key replaces an
   * existing unread one on the device (APNs `apns-collapse-id`, FCM
   * `collapse_key`, etc.).
   */
  readonly collapseKey?: string;
  /**
   * Delivery urgency hint.
   * - `high`   — wake the device (approval requests, run failures).
   * - `normal` — next natural sync window (reminders, progress updates).
   */
  readonly priority?: 'normal' | 'high';
}

// ─── Delivery record ─────────────────────────────────────────────────────────

/**
 * Result of delivering a `NotificationMessage` to a single channel target.
 */
export interface NotificationDelivery {
  /** Channel that attempted delivery. */
  readonly channelId: string;
  /** Opaque message identifier returned by the channel (FCM token, APNs UUID…). */
  readonly messageId: string;
  /** Outcome. `suppressed` means the suppression policy vetoed the send. */
  readonly status: 'sent' | 'failed' | 'suppressed';
  /** Human-readable detail on failure or suppression (non-sensitive). */
  readonly detail?: string;
}

// ─── Channel target ───────────────────────────────────────────────────────────

/**
 * Identifies a specific delivery endpoint for a principal.
 *
 * The framework intentionally keeps this opaque so new channel types can be
 * introduced without changing the core contract.
 * - `kind`:    channel-type discriminant (`'webhook'`, `'web-push'`, `'apns'`, `'fcm'`).
 * - `address`: channel-specific endpoint (VAPID endpoint, APNs token, etc.).
 *
 * SECURITY: `tenantId` and `principalId` must NEVER appear in `address`; they
 * come from the `NotificationMessage` and are never placed in URLs or query
 * strings.
 */
export interface ChannelTarget {
  readonly kind: string;
  readonly address: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── Channel ─────────────────────────────────────────────────────────────────

/**
 * Implemented by every notification channel adapter.
 * Registered in a `ChannelRegistry` and resolved by the dispatcher.
 */
export interface NotificationChannel {
  /** Stable identifier used by the dispatcher to look up this channel. */
  readonly id: string;
  /**
   * Runtime capabilities the channel requires.
   * Checked at registration time so misconfiguration surfaces at boot.
   */
  readonly capabilities: ReadonlySet<CapabilityId>;
  /**
   * Deliver `msg` to `target`.
   *
   * Implementations must:
   * - Route all HTTP through the hardened egress client (SSRF rules apply).
   * - Never read credentials from `process.env` — accept them at construction.
   * - Return a `NotificationDelivery` rather than throwing on delivery error.
   */
  send(
    ctx: ExecutionContext,
    msg: NotificationMessage,
    target: ChannelTarget,
  ): Promise<NotificationDelivery>;
}
