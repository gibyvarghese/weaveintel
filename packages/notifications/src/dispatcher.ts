/**
 * NotificationDispatcher — fans out a notification to all registered targets
 * for a principal, consulting a SuppressionPolicy before each delivery.
 *
 * - Fail-closed on suppression policy errors: an erroring hook → suppress + log.
 * - Delivery errors are caught per-channel and aggregated; partial failures do
 *   not block successful deliveries.
 * - Emits bus events: `notification.sent` / `notification.failed` per-target.
 */

import type { ExecutionContext, NotificationMessage, NotificationChannel, NotificationDelivery } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { TargetStore, TargetRecord } from './targets.js';
import type { ChannelRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// SuppressionPolicy
// ---------------------------------------------------------------------------

export interface SuppressionContext {
  tenantId: string;
  principalId: string;
  channelId: string;
  category: string;
}

/**
 * Consulted before each delivery attempt. Return `true` to suppress.
 * Errors in this hook are treated as `suppress = true` (fail-closed).
 */
export interface SuppressionPolicy {
  shouldSuppress(ctx: ExecutionContext, suppressionCtx: SuppressionContext): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// DispatchResult
// ---------------------------------------------------------------------------

export interface DispatchResult {
  readonly deliveries: readonly NotificationDelivery[];
  readonly suppressed: number;
  readonly failed: number;
}

// ---------------------------------------------------------------------------
// NotificationDispatcher
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  /** Limit delivery to these channel ids (all registered channels by default). */
  channelIds?: string[];
}

export interface NotificationDispatcher {
  /**
   * Deliver a notification to all registered targets for the principal
   * identified by `principalId` and `tenantId` (looked up from `ctx`).
   */
  notify(
    ctx: ExecutionContext,
    principalId: string,
    tenantId: string,
    msg: NotificationMessage,
    opts?: DispatchOptions,
  ): Promise<DispatchResult>;
}

// ---------------------------------------------------------------------------
// EventBus adapter (optional)
// ---------------------------------------------------------------------------

interface MinimalBus {
  emit(event: { type: string; timestamp: number; data: Record<string, unknown>; tenantId?: string }): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface NotificationDispatcherOptions {
  channels: ChannelRegistry;
  targets: TargetStore;
  suppression?: SuppressionPolicy;
  bus?: MinimalBus;
}

export function createNotificationDispatcher(opts: NotificationDispatcherOptions): NotificationDispatcher {
  const { channels, targets, suppression, bus } = opts;

  return {
    async notify(ctx, principalId, tenantId, msg, dispatchOpts) {
      const allTargets = await targets.listByPrincipal(tenantId, principalId);
      const filtered = dispatchOpts?.channelIds
        ? allTargets.filter(t => dispatchOpts.channelIds!.includes(t.channelId))
        : allTargets;

      const deliveries: NotificationDelivery[] = [];
      let suppressed = 0;
      let failed = 0;

      for (const rec of filtered) {
        const channel = channels.resolve(rec.channelId);
        if (!channel) continue;

        // Suppression check (fail-closed)
        const suppressCtx: SuppressionContext = { tenantId, principalId, channelId: rec.channelId, category: msg.category };
        let suppress = false;
        if (suppression) {
          try { suppress = await suppression.shouldSuppress(ctx, suppressCtx); }
          catch (err) {
            suppress = true;
            console.warn('[notifications] suppression policy error — suppressing delivery', { channelId: rec.channelId, err });
          }
        }
        if (suppress) { suppressed++; continue; }

        const delivery = await attemptDelivery(ctx, channel, msg, rec);
        deliveries.push(delivery);
        if (delivery.status === 'failed') { failed++; }

        // Emit bus event
        if (bus) {
          bus.emit({
            type: delivery.status === 'sent' ? 'notification.sent' : 'notification.failed',
            timestamp: Date.now(),
            tenantId,
            data: {
              messageId: delivery.messageId,
              channelId: rec.channelId,
              principalId,
              category: msg.category,
              ...(delivery.detail ? { detail: delivery.detail } : {}),
            },
          });
        }
      }

      return { deliveries, suppressed, failed };
    },
  };
}

async function attemptDelivery(
  ctx: ExecutionContext,
  channel: NotificationChannel,
  msg: NotificationMessage,
  rec: TargetRecord,
): Promise<NotificationDelivery> {
  try {
    return await channel.send(ctx, msg, rec.target);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { channelId: rec.channelId, messageId: newUUIDv7(), status: 'failed', detail };
  }
}
