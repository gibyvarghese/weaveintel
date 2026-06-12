/**
 * @weaveintel/triggers — reminders.ts
 *
 * Reminder-specific ergonomics on top of the trigger platform.
 *
 * `createReminderTrigger({ ownerPrincipalId, fireAt | rrule, label, provenance, payload })`
 *   - Creates a cron-backed trigger that fires once at `fireAt` (or on the
 *     given `rrule` schedule) and dispatches a `reminder.due` event on the bus.
 *   - One-shot triggers auto-disable after firing (set `metadata.oneShot = true`).
 *
 * `rescheduleReminder(triggerId, fireAt, store)`
 *   - Updates an existing reminder trigger's fire time.
 *
 * `ReminderBusTargetAdapter`
 *   - `TargetAdapter` that emits `reminder.due` events on the provided bus.
 *   - Register with your dispatcher for `target.kind === 'reminder_bus'`.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerProvenance,
  TriggerStore,
  TargetAdapter,
  TargetDispatchResult,
  TargetDispatchMeta,
  TriggerTargetRef,
} from './dispatcher.js';

// ---------------------------------------------------------------------------
// createReminderTrigger
// ---------------------------------------------------------------------------

export interface CreateReminderTriggerInput {
  ownerPrincipalId: string;
  tenantId?: string;
  /** Human-readable label for this reminder (stored as `key` + `metadata.label`). */
  label: string;
  /**
   * ISO 8601 datetime for a one-shot fire.
   * Mutually exclusive with `rrule`.
   */
  fireAt?: string;
  /**
   * iCal RRULE string for recurring reminders (e.g. `FREQ=DAILY;BYHOUR=9`).
   * Mutually exclusive with `fireAt`.
   */
  rrule?: string;
  provenance?: TriggerProvenance;
  /** Additional payload forwarded with the `reminder.due` event. */
  payload?: Record<string, unknown>;
}

/**
 * Creates a `Trigger` record for a reminder. Does NOT persist — the caller
 * must call `store.save(trigger)` and then `dispatcher.reload()`.
 *
 * One-shot triggers (fireAt) have `metadata.oneShot = true`. The
 * `ReminderBusTargetAdapter` auto-disables them after the first dispatch.
 */
export function createReminderTrigger(input: CreateReminderTriggerInput): Trigger {
  if (!input.fireAt && !input.rrule) {
    throw new Error('createReminderTrigger: one of fireAt or rrule is required');
  }

  const id = newUUIDv7();
  const slugLabel = input.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const key = `reminder:${input.ownerPrincipalId.slice(0, 12)}:${slugLabel}:${id.slice(-8)}`;

  const sourceConfig: Record<string, unknown> = {};
  if (input.fireAt) {
    sourceConfig['fireAt'] = input.fireAt;
  } else if (input.rrule) {
    sourceConfig['rrule'] = input.rrule;
  }

  return {
    id,
    key,
    enabled: true,
    source: { kind: 'cron', config: sourceConfig },
    target: {
      kind: 'reminder_bus',
      config: {
        label: input.label,
        ...(input.payload ?? {}),
      },
    },
    ownerPrincipalId: input.ownerPrincipalId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
    metadata: {
      label: input.label,
      oneShot: !!input.fireAt,
      ...(input.payload ? { payload: input.payload } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// rescheduleReminder
// ---------------------------------------------------------------------------

/**
 * Updates an existing reminder trigger's one-shot `fireAt` time.
 * Re-enables the trigger if it was auto-disabled after firing.
 * Throws if the trigger is not found or is not a `reminder_bus` target.
 */
export async function rescheduleReminder(
  triggerId: string,
  fireAt: string,
  store: TriggerStore,
): Promise<Trigger> {
  const trigger = await store.get(triggerId);
  if (!trigger) throw new Error(`rescheduleReminder: trigger not found: ${triggerId}`);
  if (trigger.target.kind !== 'reminder_bus') {
    throw new Error(`rescheduleReminder: trigger ${triggerId} is not a reminder_bus target`);
  }

  const updated: Trigger = {
    ...trigger,
    enabled: true,
    source: { ...trigger.source, config: { ...trigger.source.config, fireAt } },
    metadata: { ...(trigger.metadata ?? {}), oneShot: true },
  };
  await store.save(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// ReminderBusTargetAdapter
// ---------------------------------------------------------------------------

interface MinimalBus {
  emit(event: { type: string; timestamp: number; data: Record<string, unknown>; tenantId?: string }): void;
}

/**
 * TargetAdapter for `reminder_bus` targets. Emits `reminder.due` on the bus
 * and auto-disables one-shot triggers.
 */
export class ReminderBusTargetAdapter implements TargetAdapter {
  readonly kind = 'reminder_bus' as const;

  constructor(
    private readonly bus: MinimalBus,
    private readonly store?: TriggerStore,
  ) {}

  async dispatch(
    target: TriggerTargetRef,
    _input: unknown,
    meta: TargetDispatchMeta,
  ): Promise<TargetDispatchResult> {
    this.bus.emit({
      type: 'reminder.due',
      timestamp: meta.firedAt,
      data: {
        triggerId: meta.triggerId,
        triggerKey: meta.triggerKey,
        label: target.config['label'] ?? '',
        payload: target.config,
        firedAt: meta.firedAt,
      },
    });

    // Auto-disable one-shot triggers
    if (this.store) {
      const trigger = await this.store.get(meta.triggerId).catch(() => null);
      if (trigger?.metadata?.['oneShot'] === true) {
        await this.store.save({ ...trigger, enabled: false }).catch(() => undefined);
      }
    }

    return { ref: meta.triggerId };
  }
}
