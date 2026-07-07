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

## What's in the box

| Group | Exports |
| --- | --- |
| Channels | `createWebhookChannel`, `createWebPushChannel`, `createApnsChannel`, `createFcmChannel` |
| Registry | `createChannelRegistry` |
| Targets | `createMemoryTargetStore`, `createKvTargetStore` |
| Dispatcher | `createNotificationDispatcher` (with `SuppressionPolicy`, `DispatchResult`, `DispatchOptions`) |
| In-app feed | `createInAppChannel`, `createInMemoryFeedStore`, `createPostgresNotificationFeedStore`, `INAPP_CHANNEL_ID`, `notificationFeedStoreContract` |
| Bus subscriptions | `bindRunNotifications`, `bindTaskNotifications` |

## License

MIT.
