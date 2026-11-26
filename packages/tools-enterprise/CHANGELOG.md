# @weaveintel/tools-enterprise

## 0.2.0

### Minor Changes

- c4221cc: `AuthManager` now runs on `@weaveintel/connect`: its headers come from connect's credential appliers and every token
  request (client credentials, refresh, code exchange) is connect's `requestToken`. New: `exchangeCode(id, code,
codeVerifier?)` sends a PKCE verifier, and the constructor takes `{ send }` so a host can route sign-in calls through
  its own door. Failures say `Token request failed (<status>): <plain sentence>` and no longer include the sign-in
  service's response text. A basic or API-key profile with a missing secret now fails closed instead of sending an
  empty value. `AuthManager` is deprecated for new code: use `@weaveintel/connect/credentials` directly.
- The package is frozen (security fixes only): its connectors are moving to connector packs on `@weaveintel/connect`,
  and each provider is deprecated as its pack does everything the provider does (owner ruling, 2026-11-24).

### Patch Changes

- Updated dependencies [c4221cc]
  - @weaveintel/connect@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/tools@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/tools@0.2.1
