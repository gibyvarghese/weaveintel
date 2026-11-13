# @weaveintel/a2a

## 0.2.0

### Added

- **A2A v0.3 fields on a v1.0 card.** `withV03Compat(card)` adds `protocolVersion`, `url`, `preferredTransport`,
  `additionalInterfaces` and `supportsAuthenticatedExtendedCard` from `supportedInterfaces` (JSON-RPC preferred),
  and fills `defaultInputModes`, `defaultOutputModes` and skill `tags`, which v0.3 requires. It refuses a card
  that is already signed. `checkV03Card(card)` lists what a v0.3 reader would miss.
- **Card signatures in the A2A wire form, verified against a JWKS.** `signAgentCardJws` writes
  `{ protected, signature }`: ES256, a detached payload that is the RFC 8785 canonical JSON of the card without
  `signatures`, protected header `{ alg, typ, kid, jku? }`. `verifyAgentCardJws(card, { jwks, allowedJku })`
  refuses an unsigned card, `alg` other than ES256 (`none`, HMAC), unknown `crit`, an untrusted `jku`, an unknown
  key, and any tampered member. It never fetches a `jku`. `exportCardSigningJwk` / `buildCardJwks` publish public
  keys only (a private member is refused).
- **A scoped task store port.** `A2AScopedTaskStore`: every method takes `{ tenantId, principalId?, clientId? }`;
  a task is visible only to the scope that wrote it, and another scope's id is "not found". Bindings:
  `createInMemoryScopedA2ATaskStore` and `createPostgresA2ATaskStore` (driver-free; `a2aTaskPostgresDdl` for the
  table; primary key `(tenant_id, id)`; the scope is in every statement; single-statement updates).
  `bindA2ATaskScope` gives the dispatcher one scope's view. `a2aScopedTaskStoreContract` is the shared battery.
  `newA2ATaskId()` is a random v4 UUID.
- **Push configs through the outbound guard.** `validatePushNotificationConfig(config, { allowedHosts, outbound })`:
  https only, no credentials in the URL, the allow list when given (empty refuses all), and core's guard (every
  resolved address public). The dispatcher checks it before storing a config.

### Changed (breaking)

- **Push delivery refuses loopback by default** and goes through `validatePushNotificationConfig` every time;
  a local test receiver passes `{ policy: { outbound: { allowLoopback: true } } }`. Delivery connects to the
  checked address (core's `pinnedFetch`) and never follows a redirect (a 3xx is a failed delivery, not retried).
- **CreateTaskPushNotificationConfig** refuses a webhook the guard refuses (`INVALID_PARAMS`), and, with a task
  store, a task the store does not hold (`TASK_NOT_FOUND`). Get/List/DeleteTaskPushNotificationConfig answer
  `TASK_NOT_FOUND` for a task the store does not hold, so one tenant cannot read another's webhook tokens.
- `createA2ADispatcher` takes a fifth argument, `{ pushPolicy }`. GetTask and ListTasks fall back to the task
  store when the server implementation has no `getTask` / `listTasks` (as the dispatcher's documentation said).
- Depends on `@weaveintel/core` `^0.2.0`.
