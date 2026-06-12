/**
 * Bus subscriptions that bridge weaveIntel events to notifications.
 *
 * `bindRunNotifications(bus, dispatcher, mapper)` — subscribes to run lifecycle
 *   events and dispatches a notification for each one.
 * `bindTaskNotifications(bus, dispatcher, mapper)` — subscribes to task lifecycle
 *   events and dispatches a notification for each one.
 *
 * Both accept an injectable `mapper` so the app layer controls which events
 * produce notifications, what the content is, and who receives them.
 * Returning `null` from a mapper skips dispatch silently.
 */

import type { NotificationMessage } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import type { NotificationDispatcher } from './dispatcher.js';

// ---------------------------------------------------------------------------
// Minimal bus subscription contract (structural)
// ---------------------------------------------------------------------------

interface WeaveEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  tenantId?: string;
}

interface MinimalBus {
  onAll(handler: (event: WeaveEvent) => void): void;
}

// ---------------------------------------------------------------------------
// Mapper types
// ---------------------------------------------------------------------------

export interface RunNotificationTarget {
  principalId: string;
  tenantId: string;
}

export interface RunNotificationMapping {
  target: RunNotificationTarget;
  msg: NotificationMessage;
}

export type RunEventMapper = (event: WeaveEvent) => RunNotificationMapping | null;

export interface TaskNotificationTarget {
  principalId: string;
  tenantId: string;
}

export interface TaskNotificationMapping {
  target: TaskNotificationTarget;
  msg: NotificationMessage;
}

export type TaskEventMapper = (event: WeaveEvent) => TaskNotificationMapping | null;

// ---------------------------------------------------------------------------
// bindRunNotifications
// ---------------------------------------------------------------------------

const RUN_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.progress']);

/**
 * Listens for run lifecycle events on the bus and dispatches notifications.
 * The `mapper` controls which events trigger delivery and to whom.
 */
export function bindRunNotifications(
  bus: MinimalBus,
  dispatcher: NotificationDispatcher,
  mapper: RunEventMapper,
): void {
  bus.onAll((event) => {
    if (!RUN_EVENT_TYPES.has(event.type)) return;
    const mapping = mapper(event);
    if (!mapping) return;
    const ctx = weaveContext({ ...(event.tenantId ? { tenantId: event.tenantId } : {}) });
    void dispatcher.notify(ctx, mapping.target.principalId, mapping.target.tenantId, mapping.msg).catch((err) => {
      console.warn('[notifications] run notification dispatch failed', { eventType: event.type, err });
    });
  });
}

// ---------------------------------------------------------------------------
// bindTaskNotifications
// ---------------------------------------------------------------------------

const TASK_EVENT_TYPES = new Set(['task.created', 'task.assigned', 'task.completed', 'task.cancelled', 'task.due']);

/**
 * Listens for task lifecycle events on the bus and dispatches notifications.
 * The `mapper` controls which events trigger delivery and to whom.
 */
export function bindTaskNotifications(
  bus: MinimalBus,
  dispatcher: NotificationDispatcher,
  mapper: TaskEventMapper,
): void {
  bus.onAll((event) => {
    if (!TASK_EVENT_TYPES.has(event.type)) return;
    const mapping = mapper(event);
    if (!mapping) return;
    const ctx = weaveContext({ ...(event.tenantId ? { tenantId: event.tenantId } : {}) });
    void dispatcher.notify(ctx, mapping.target.principalId, mapping.target.tenantId, mapping.msg).catch((err) => {
      console.warn('[notifications] task notification dispatch failed', { eventType: event.type, err });
    });
  });
}
