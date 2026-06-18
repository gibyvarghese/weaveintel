// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notifications
 *
 * Notification channels, dispatcher, and target store for the weaveIntel platform.
 *
 * Quick start:
 * ```ts
 * import {
 *   createWebhookChannel, createChannelRegistry,
 *   createMemoryTargetStore, createNotificationDispatcher,
 * } from '@weaveintel/notifications';
 * ```
 */

// Channels
export {
  createWebhookChannel,
  type WebhookChannelOptions,
  createWebPushChannel,
  type WebPushChannelOptions,
  createApnsChannel,
  type ApnsChannelOptions,
  createFcmChannel,
  type FcmChannelOptions,
} from './channels.js';

// Registry
export { createChannelRegistry, type ChannelRegistry } from './registry.js';

// Targets
export {
  createMemoryTargetStore,
  createKvTargetStore,
  type TargetRecord,
  type TargetStore,
  type CreateTargetInput,
} from './targets.js';

// Dispatcher
export {
  createNotificationDispatcher,
  type NotificationDispatcher,
  type NotificationDispatcherOptions,
  type SuppressionPolicy,
  type SuppressionContext,
  type DispatchResult,
  type DispatchOptions,
} from './dispatcher.js';

// Bus subscriptions
export {
  bindRunNotifications,
  bindTaskNotifications,
  type RunEventMapper,
  type TaskEventMapper,
  type RunNotificationMapping,
  type RunNotificationTarget,
  type TaskNotificationMapping,
  type TaskNotificationTarget,
} from './subscriptions.js';
