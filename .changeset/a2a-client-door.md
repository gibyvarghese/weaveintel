---
"@weaveintel/a2a": minor
---

`weaveA2AClient(options)` takes `fetch` and `getHeaders`, so discovery, messages and streams go through the caller's
own network door with a fresh credential on every call. With no options it behaves as before.
