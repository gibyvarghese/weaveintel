# @weaveintel/notifications

**A pluggable notification system — channels (in-app, email/webhook, web-push, APNs, FCM), a dispatcher that fans out to them, and a store of who to reach.**

## Why it exists

"Tell the user their run finished" sounds like one line of code until you ask *how*: an in-app badge, an email, a phone push, a webhook to another system — and only to the devices this user actually still has. It's like a post office: you hand over one message, and the sorting room figures out every address it needs to reach and picks the right carrier for each. This package is that sorting room. You register the channels you support, store each user's targets, and the dispatcher fans a single notification out to all the right places — with suppression rules so you don't spam someone twice.

## When to reach for it

Reach for it when your server needs to deliver notifications across more than one channel and wants a clean seam between "what happened" and "how it's delivered." It's storage-agnostic: an in-memory target store ships for tests, and you provide a `KeyValueStore` or SQL adapter for production. If you only need the *client-side* in-app feed rendering, that lives in your UI; this package owns the server fan-out and the durable feed store behind it.

## How to use it

```ts
import {
  createWebhookChannel, createChannelRegistry,
  createMemoryTargetStore, createNotificationDispatcher,
} from '@weaveintel/notifications';

const channels = createChannelRegistry([createWebhookChannel({ /* ... */ })]);
const targets = createMemoryTargetStore();
await targets.create({ userId: 'u1', channelId: 'webhook', address: 'https://hooks.example.com/x' });

const dispatcher = createNotificationDispatcher({ channels, targets });
await dispatcher.dispatch({ userId: 'u1', title: 'Run finished', body: 'Your summary is ready.' });
```

## Store the inbox in a real database (Postgres)

The in-app feed (the 🔔 with a red badge) is the one notification channel that *stays* — it's the durable record a user sees. `createInMemoryFeedStore` is great for tests; `createPostgresNotificationFeedStore` is the same `NotificationFeedStore` port backed by Postgres, so a restart doesn't lose anyone's inbox. Hand it a `pg.Pool` (share one across your app — e.g. from `weaveSharedPostgres`); it creates its table on first use.

```ts
import pg from 'pg';
import { createPostgresNotificationFeedStore } from '@weaveintel/notifications';

const feed = createPostgresNotificationFeedStore({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });

await feed.append({ id: 'n1', tenantId: 't1', principalId: 'alice', category: 'run', title: 'Run finished', priority: 'normal', createdAt: Date.now(), readAt: null });
await feed.unreadCount('t1', 'alice'); // → 1 (the badge number)
await feed.markAllRead('t1', 'alice');
```

Two things it gets right that matter at scale. **Dedupe:** if your delivery pipeline runs twice (it's at-least-once by design), a stable `dedupeKey` collapses the two into one inbox row — enforced by a partial unique index, so even 50 concurrent redeliveries produce exactly one row. **Isolation:** every read is scoped to `(tenant, principal)`, so one user never sees another's notifications. The same **contract test** the in-memory version passes runs against Postgres, and it's proven on a real fan-out to 5,000 recipients.

## Notification types, preferences and digests

Apps register **types** keyed `<app>.<module>.<event>` with default channels, per-channel templates,
priority, collapse/dedupe, `digestable`, `breakthrough` and the `permission` needed to see the subject.
`buildNotification` fills the template and puts the type in `data.type_key` (the closed `category`
stays as the coarse filter).

`preferenceSuppression({ resolvePrefs, types })` decides per person and channel from preference rows
— `org` → `role` → `user`, with `policy` rows final — and answers deliver, digest (quiet hours or a
digest preference, digestable types only) or suppress. Breakthrough types skip quiet hours. Give the
dispatcher `types`, a `permissionCheck` and a `digest` sink: an unregistered type, a type whose
permission can't be confirmed, or a preference store that errors all withhold the notification.

```ts
const types = createNotificationTypeRegistry([{
  key: 'itsm.change.cab_scheduled', category: 'task', channels: ['email', 'in-app'],
  templates: { default: { title: 'CAB scheduled for {{change}}' } },
  priority: 'normal', digestable: true, breakthrough: false,
}]);
const dispatcher = createNotificationDispatcher({
  channels, targets, types, digest: createInMemoryDigestSink(),
  permissionCheck: async (ctx, c) => canSee(c.principalId, c.permission),
  suppression: preferenceSuppression({ types, resolvePrefs: loadPreferenceRows }),
});
await dispatcher.notify(ctx, userId, tenantId,
  buildNotification(types, 'itsm.change.cab_scheduled', { id, tenantId, principalId: userId, vars: { change: 'CHG0042' } }));
```

## Email, SMS and Teams

`createEmailChannel`, `createSmsChannel` and `createTeamsChannel` adapt transport interfaces you supply
(`EmailTransport`, `SmsTransport`, `TeamsTransport`), so no vendor SDK or credential lives here.
`createTeamsWebhookTransport` posts an Adaptive Card to Teams / Workflows incoming webhooks through the
hardened fetch, only to https Microsoft webhook hosts. `createRecording*Transport` are test doubles.
SMS sends the title and link by default, never the body; no channel sends `data`.

## What's in the box

| Group | Exports |
| --- | --- |
| Channels | `createWebhookChannel`, `createWebPushChannel`, `createApnsChannel`, `createFcmChannel`, `createEmailChannel`, `createSmsChannel`, `createTeamsChannel` (+ `createTeamsWebhookTransport`, `createRecording*Transport`), `createPushChannel` (host `PushTransport`; `render` decides what reaches the lock screen — the HTTP push channels take a `render` too) |
| Types | `createNotificationTypeRegistry`, `buildNotification`, `typeKeyOf`, `TYPE_KEY_FIELD` |
| Preferences | `preferenceSuppression`, `resolveEffectivePreference`, `inQuietHours`, `createInMemoryDigestSink`, `buildDigestNotification` |
| Registry | `createChannelRegistry` |
| Targets | `createMemoryTargetStore`, `createKvTargetStore` |
| Dispatcher | `createNotificationDispatcher` (with `SuppressionPolicy`, `DispatchResult`, `DispatchOptions`) |
| In-app feed | `createInAppChannel`, `createInMemoryFeedStore`, `createPostgresNotificationFeedStore`, `INAPP_CHANNEL_ID`, `notificationFeedStoreContract` |
| Bus subscriptions | `bindRunNotifications`, `bindTaskNotifications` |

## License

MIT.
