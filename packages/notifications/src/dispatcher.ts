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
import { typeKeyOf, type NotificationTypeDefinition, type NotificationTypeRegistry } from './type-registry.js';
import type { DigestSink } from './digest.js';

// ---------------------------------------------------------------------------
// SuppressionPolicy
// ---------------------------------------------------------------------------

export interface SuppressionContext {
  tenantId: string;
  principalId: string;
  channelId: string;
  category: string;
  /** The notification's `data.type_key`, when it has one. */
  typeKey?: string;
  priority?: 'normal' | 'high';
}

/** A richer answer than yes/no: send now, hold for the next digest, or don't send. */
export type SuppressionDecision =
  | { readonly action: 'deliver' }
  | { readonly action: 'digest'; readonly reason?: string }
  | { readonly action: 'suppress'; readonly reason?: string };

/**
 * Consulted before each delivery attempt. Return `true` to suppress.
 * Errors in this hook are treated as `suppress = true` (fail-closed).
 * A policy that also implements `decide` can hold a notification for a digest.
 */
export interface SuppressionPolicy {
  shouldSuppress(ctx: ExecutionContext, suppressionCtx: SuppressionContext): Promise<boolean>;
  decide?(ctx: ExecutionContext, suppressionCtx: SuppressionContext): Promise<SuppressionDecision>;
}

/**
 * Rechecks, at send time, that the recipient may see what a typed notification is about. Return
 * `false` (or throw) to withhold it.
 */
export type NotificationPermissionCheck = (
  ctx: ExecutionContext,
  check: { tenantId: string; principalId: string; permission: string; typeKey: string; msg: NotificationMessage },
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// DispatchResult
// ---------------------------------------------------------------------------

export interface DispatchResult {
  readonly deliveries: readonly NotificationDelivery[];
  readonly suppressed: number;
  readonly failed: number;
  /** Held for the next digest instead of sent. */
  readonly digested?: number;
  /** Why each skipped target was skipped (no PII; channel id and a short reason). */
  readonly skipped?: ReadonlyArray<{ readonly channelId: string; readonly reason: string }>;
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
  /**
   * The notification type registry. When set, a notification whose `data.type_key` is not
   * registered is withheld, and a type's `permission` is rechecked before any send.
   */
  types?: NotificationTypeRegistry;
  /** Required for types that declare a `permission`; without it those are withheld. */
  permissionCheck?: NotificationPermissionCheck;
  /** Where `digest` decisions go. Without it, a digest decision withholds the notification. */
  digest?: DigestSink;
}

export function createNotificationDispatcher(opts: NotificationDispatcherOptions): NotificationDispatcher {
  const { channels, targets, suppression, bus, types, permissionCheck, digest } = opts;

  /** Withhold the whole notification for every target (type unknown or permission not shown). */
  function withholdAll(filtered: readonly TargetRecord[], reason: string): DispatchResult {
    return {
      deliveries: [],
      suppressed: filtered.length,
      failed: 0,
      digested: 0,
      skipped: filtered.map((t) => ({ channelId: t.channelId, reason })),
    };
  }

  return {
    async notify(ctx, principalId, tenantId, msg, dispatchOpts) {
      const allTargets = await targets.listByPrincipal(tenantId, principalId);
      const filtered = dispatchOpts?.channelIds
        ? allTargets.filter(t => dispatchOpts.channelIds!.includes(t.channelId))
        : allTargets;

      // Typed notifications: the type must be known, and its permission rechecked now.
      const typeKey = typeKeyOf(msg);
      let def: NotificationTypeDefinition | undefined;
      if (typeKey && types) {
        def = types.get(typeKey);
        if (!def) return withholdAll(filtered, 'unknown_type');
        if (def.permission) {
          if (!permissionCheck) return withholdAll(filtered, 'permission_unchecked');
          let allowed = false;
          try {
            allowed = await permissionCheck(ctx, { tenantId, principalId, permission: def.permission, typeKey, msg });
          } catch (err) {
            console.warn('[notifications] permission check error — withholding', { typeKey, err });
          }
          if (!allowed) return withholdAll(filtered, 'permission_denied');
        }
      }

      const deliveries: NotificationDelivery[] = [];
      const skipped: Array<{ channelId: string; reason: string }> = [];
      let suppressed = 0;
      let digested = 0;
      let failed = 0;

      for (const rec of filtered) {
        const channel = channels.resolve(rec.channelId);
        if (!channel) continue;

        // Suppression check (fail-closed)
        const suppressCtx: SuppressionContext = {
          tenantId, principalId, channelId: rec.channelId, category: msg.category,
          ...(typeKey ? { typeKey } : {}),
          ...(msg.priority ? { priority: msg.priority } : {}),
        };
        let decision: SuppressionDecision = { action: 'deliver' };
        if (suppression) {
          try {
            decision = suppression.decide
              ? await suppression.decide(ctx, suppressCtx)
              : (await suppression.shouldSuppress(ctx, suppressCtx)) ? { action: 'suppress' } : { action: 'deliver' };
          } catch (err) {
            decision = { action: 'suppress', reason: 'policy_error' };
            console.warn('[notifications] suppression policy error — suppressing delivery', { channelId: rec.channelId, err });
          }
        }
        if (decision.action === 'digest') {
          if (digest) {
            try {
              await digest.add(ctx, { tenantId, principalId, channelId: rec.channelId, ...(typeKey ? { typeKey } : {}), msg, heldAt: new Date().toISOString() });
              digested++;
              skipped.push({ channelId: rec.channelId, reason: decision.reason ?? 'digest' });
              continue;
            } catch (err) {
              console.warn('[notifications] digest sink error — suppressing delivery', { channelId: rec.channelId, err });
            }
          }
          decision = { action: 'suppress', reason: 'digest_unavailable' };
        }
        if (decision.action === 'suppress') {
          suppressed++;
          skipped.push({ channelId: rec.channelId, reason: decision.reason ?? 'suppressed' });
          continue;
        }

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
              ...(typeKey ? { typeKey } : {}),
              ...(delivery.detail ? { detail: delivery.detail } : {}),
            },
          });
        }
      }

      return { deliveries, suppressed, failed, digested, skipped };
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
