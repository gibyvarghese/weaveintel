# @weaveintel/notifications

## 0.2.0

### Added

- `NotificationTypeRegistry` (GAPS G-WI-15): `<app>.<module>.<event>` types with default channels,
  per-channel templates, priority, collapse/dedupe, `digestable`, `breakthrough` and `permission`;
  `buildNotification` sets `data.type_key`.
- `preferenceSuppression` (G-WI-16): org → role → user preference rows with final policy rows, quiet
  hours in the row's time zone, digests for digestable types, breakthrough types skip quiet hours;
  `createInMemoryDigestSink`, `buildDigestNotification`.
- Dispatcher options `types`, `permissionCheck`, `digest`: an unregistered type, an unconfirmed
  permission or a preference error withholds the notification (fail closed). `DispatchResult` gains
  `digested` and `skipped`; a `SuppressionPolicy` may implement `decide()`.
- Email, SMS and Microsoft Teams channels over host-supplied transports (G-WI-17):
  `createEmailChannel`, `createSmsChannel`, `createTeamsChannel`, `createTeamsWebhookTransport` (https
  Microsoft webhook hosts only, hardened fetch), and recording test doubles. No credentials in the
  library.
