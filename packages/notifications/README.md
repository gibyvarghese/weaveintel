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

## What's in the box

| Group | Exports |
| --- | --- |
| Channels | `createWebhookChannel`, `createWebPushChannel`, `createApnsChannel`, `createFcmChannel` |
| Registry | `createChannelRegistry` |
| Targets | `createMemoryTargetStore`, `createKvTargetStore` |
| Dispatcher | `createNotificationDispatcher` (with `SuppressionPolicy`, `DispatchResult`, `DispatchOptions`) |
| In-app feed | `createInAppChannel`, `createInMemoryFeedStore`, `INAPP_CHANNEL_ID`, `notificationFeedStoreContract` |
| Bus subscriptions | `bindRunNotifications`, `bindTaskNotifications` |

## License

MIT.
