# @weaveintel/a2a

## 0.4.0

### Minor Changes

- 7ea3691: A2A v0.3 card fields, card signatures in the A2A wire form verified against a JWKS, a tenant-scoped task store with a
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

## 0.3.0

### Minor Changes

- b29c076: `weaveA2AClient(options)` takes `fetch` and `getHeaders`, so discovery, messages and streams go through the caller's
  own network door with a fresh credential on every call. With no options it behaves as before.

### Patch Changes

- Updated dependencies [b57835c]
  - @weaveintel/core@0.3.1

## 0.2.1

### Patch Changes

- Bring `feat/file-understanding` to `main`, so its packages can be published from here.

  These versions were only ever served from a private registry. npm had `core`, `guardrails`, `routing` and
  `provider-google` under the same or lower numbers but different code, and had no `provider-registry` at all.
  - **core (breaking, hence minor on 0.x).** The strict outbound guard is merged with `main`'s hardened egress.
    - `allowLoopback` now defaults to `false`. Callers that reach this machine opt in; `provider-ollama`,
      `provider-llamacpp` and `a2a` already do.
    - A hostname that does not resolve is refused.
    - One address classifier (`classifyAddress`) is used for literals, resolved addresses and the connect-time pin.
      It also covers CGNAT, NAT64 and the other special ranges.
    - Every request and every redirect hop is pinned with `pinnedFetch` / `pinnedLookup`, and the resolver can be
      supplied with `OutboundUrlPolicy.lookup`.
    - Kept from `main`:
      - A redirect to another origin is refused unless `allowCrossOriginRedirects` is set. It must then be a bodyless
        GET or HEAD, and it carries no caller header at all.
      - Known metadata addresses are refused even when private networks are allowed.
      - `allowInsecureHttp` is available for trusted hosts.
      - `hardenedFetch` keeps the `follow`, `manual` and `error` redirect modes.
    - Also added: capability profiles, a conformance probe and a typed refusal for unreadable content.
  - **extraction:** a file-understanding service with in-house readers, schema-forced extraction and validation, and
    guarded file sources.
  - **routing:** a rule router over plain rows, and filtering on the input capabilities a request needs.
  - **provider-google:** Gemini and Vertex AI as registry adapters.
  - **provider-registry:** new on npm. Model providers as data, with keys fetched per call and a guarded transport.
  - **observability:** the OTLP sink still reaches a collector on this machine (`http://localhost:4318`) by default, now
    that core no longer allows loopback unless asked. Private networks and non-loopback HTTP still need `egressPolicy`.
  - **guardrails, testing and providers:** the file-content fence, the fake provider servers, and file, PDF and audio
    parts that are sent properly or refused by name.

- Updated dependencies
  - @weaveintel/core@0.3.0

## 0.2.0

### Minor Changes

- 766246e: Add an opt-in authenticated dispatcher for independent A2A 1.0 JSON-RPC
  messages, requiring host authentication and authorization and returning
  sanitized errors for callback failures.
- 766246e: Validate every redirect with hardened egress and reject cross-origin redirects by
  default. The explicit cross-origin opt-in only permits bodyless GET/HEAD requests
  and strips caller headers. Metadata addresses remain blocked when private
  network access is enabled. Trusted hosts can explicitly permit non-loopback HTTP.

  A2A webhooks and OTLP exports now use hardened egress. Private collectors require
  an explicit host policy, and failed OTLP batches are reported instead of being
  silently discarded. Existing cross-origin redirects and private endpoints may
  require configuration changes.

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
