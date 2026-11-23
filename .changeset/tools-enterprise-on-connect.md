---
"@weaveintel/tools-enterprise": minor
---

`AuthManager` now runs on `@weaveintel/connect`: its headers come from connect's credential appliers and every token
request (client credentials, refresh, code exchange) is connect's `requestToken`. New: `exchangeCode(id, code,
codeVerifier?)` sends a PKCE verifier, and the constructor takes `{ send }` so a host can route sign-in calls through
its own door. Failures say `Token request failed (<status>): <plain sentence>` and no longer include the sign-in
service's response text. A basic or API-key profile with a missing secret now fails closed instead of sending an
empty value. `AuthManager` is deprecated for new code: use `@weaveintel/connect/credentials` directly.
