---
'@weaveintel/connect': minor
---

First release of `@weaveintel/connect`, the connector framework's building blocks with no runtime dependencies:
credential kinds and the code that puts each on a request (API key, bearer, basic, OAuth client and refresh, HMAC
signing) with a single-flight token cache; the generic operation runner (request from mapping rows, transforms, paging,
repeat protection, outcomes in plain words); inbound verifier presets and a replay cache; and a record-and-replay test
kit that scrubs secrets.
