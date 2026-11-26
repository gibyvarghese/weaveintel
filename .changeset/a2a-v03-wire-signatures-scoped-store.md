---
'@weaveintel/a2a': minor
---

A2A v0.3 card fields, card signatures in the A2A wire form verified against a JWKS, a tenant-scoped task store with a
Postgres binding, and push webhooks through the outbound guard.

- **v0.3 fields on a v1.0 card.** `withV03Compat(card)` adds `protocolVersion`, `url`, `preferredTransport`,
  `additionalInterfaces` and `supportsAuthenticatedExtendedCard`, and fills `defaultInputModes`, `defaultOutputModes`
  and skill `tags`. `checkV03Card(card)` lists what a v0.3 reader would miss.
- **Wire-form card signatures.** `signAgentCardJws` writes `{ protected, signature }` (ES256, detached RFC 8785
  canonical payload, header `{ alg, typ, kid, jku? }`). `verifyAgentCardJws(card, { jwks, allowedJku })` refuses an
  unsigned card, any `alg` but ES256, unknown `crit`, an untrusted `jku`, an unknown key and any tampered member; it
  never fetches a `jku`. `exportCardSigningJwk` / `buildCardJwks` publish public keys only. The older
  `signAgentCard` / `verifyAgentCard` stay as they were.
- **Scoped task store.** `A2AScopedTaskStore` (every method takes `{ tenantId, principalId?, clientId? }`; another
  scope's id is "not found"), with `createInMemoryScopedA2ATaskStore`, driver-free `createPostgresA2ATaskStore` +
  `a2aTaskPostgresDdl`, `bindA2ATaskScope`, the shared `a2aScopedTaskStoreContract`, and `newA2ATaskId()`.
- **Push configs through the outbound guard.** `validatePushNotificationConfig(config, { allowedHosts, outbound })`:
  https only, no credentials in the URL, the allow list when given, every resolved address public. The dispatcher
  checks it before storing a config.

Breaking (hence minor on 0.x):

- Push delivery refuses loopback by default and re-checks the config on every delivery; a local test receiver passes
  `{ policy: { outbound: { allowLoopback: true } } }`. Delivery is pinned to the checked address and never follows a
  redirect, same-origin included (a 3xx is a failed delivery, not retried); 0.3.0 followed a same-origin redirect
  and retried a refused cross-origin one.
- `CreateTaskPushNotificationConfig` refuses a webhook the guard refuses (`INVALID_PARAMS`) and, with a task store, a
  task the store does not hold (`TASK_NOT_FOUND`); Get/List/Delete answer `TASK_NOT_FOUND` for such a task, so one
  tenant cannot read another's webhook tokens.
- `createA2ADispatcher` takes a fifth argument, `{ pushPolicy }`. GetTask and ListTasks fall back to the task store
  when the server implementation has no `getTask` / `listTasks`.
