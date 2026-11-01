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

// Email, SMS and Teams channels (G-WI-17): transport interfaces + test doubles
export {
  createEmailChannel,
  createSmsChannel,
  createTeamsChannel,
  createTeamsWebhookTransport,
  createRecordingEmailTransport,
  createRecordingSmsTransport,
  createRecordingTeamsTransport,
  defaultTeamsCard,
  isAllowedWebhookUrl,
  DEFAULT_TEAMS_WEBHOOK_HOSTS,
  type EmailEnvelope,
  type EmailTransport,
  type EmailChannelOptions,
  type SmsEnvelope,
  type SmsTransport,
  type SmsChannelOptions,
  type TeamsCardPayload,
  type TeamsTransport,
  type TeamsChannelOptions,
  type TeamsWebhookTransportOptions,
} from './channels-email-sms-teams.js';

// Registry
export { createChannelRegistry, type ChannelRegistry } from './registry.js';

// Notification types (G-WI-15): `<app>.<module>.<event>` keys, `type_key` in `data`
export {
  createNotificationTypeRegistry,
  buildNotification,
  renderTemplate,
  templateFor,
  typeKeyOf,
  TYPE_KEY_FIELD,
  NotificationTypeError,
  type NotificationTypeRegistry,
  type NotificationTypeDefinition,
  type NotificationTemplate,
  type NotificationDedupe,
  type BuildNotificationInput,
} from './type-registry.js';

// Preference-based suppression (G-WI-16): Org → Role → Mine + Policy, quiet hours, digests
export {
  preferenceSuppression,
  resolveEffectivePreference,
  inQuietHours,
  type NotificationPreference,
  type QuietHours,
  type PreferenceQuery,
  type PreferenceResolver,
  type PreferenceSuppressionOptions,
  type EffectivePreference,
} from './preferences.js';
export {
  createInMemoryDigestSink,
  buildDigestNotification,
  type DigestEntry,
  type DigestSink,
  type InMemoryDigestSink,
} from './digest.js';

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
  type SuppressionDecision,
  type NotificationPermissionCheck,
  type DispatchResult,
  type DispatchOptions,
} from './dispatcher.js';

// In-app feed (Collaboration Phase 3) — the durable per-user inbox + a channel
// that plugs into the dispatcher fan-out. A consuming app provides the SQL adapter.
export {
  INAPP_CHANNEL_ID,
  type FeedNotification,
  type FeedListOptions,
  type NotificationFeedStore,
  type InMemoryFeedStoreOptions,
  type InAppChannelOptions,
  createInMemoryFeedStore,
  createInAppChannel,
} from './feed.js';
export {
  type FeedContractTestApi,
  notificationFeedStoreContract,
} from './feed-contract.js';
export {
  type PostgresFeedStoreOptions,
  createPostgresNotificationFeedStore,
} from './feed-postgres.js';

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
