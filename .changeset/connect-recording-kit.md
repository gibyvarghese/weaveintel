---
'@weaveintel/connect': minor
---

`@weaveintel/connect/replay` can now record a sandbox exchange set: `createRecordingSend(live, options)` sits in front
of a live Send only when `CONNECT_RECORD=1`, keeps an allowlist of headers (authorisation and cookie headers are never
written), scrubs tokens, emails and account-like numbers, and writes `<pack>/test/<name>.recording.json` marked as a
scrubbed sandbox recording, refusing to write while anything still looks like a secret. Recording and replay use a
fixed run reference (`REPLAY_RUN_REF`, `replayIdempotencyKey`) and an injected clock, so they are deterministic. A
replaying Send now also says which recorded exchanges nothing asked for (`unused()`).
