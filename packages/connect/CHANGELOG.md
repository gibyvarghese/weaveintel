# @weaveintel/connect

## 0.2.0

### Minor Changes

- 68f4cbf: First release of `@weaveintel/connect`, the connector framework's building blocks with no runtime dependencies:
  credential kinds and the code that puts each on a request (API key, bearer, basic, OAuth client and refresh, HMAC
  signing) with a single-flight token cache; the generic operation runner (request from mapping rows, transforms, paging,
  repeat protection, outcomes in plain words); inbound verifier presets and a replay cache; and a record-and-replay test
  kit that scrubs secrets.
- 46dfaad: New subpath `@weaveintel/connect/sources`: an OData (v4) source on the generic operation runner. `odataOperation(source)`
  turns an entity set, selected fields, typed filters, a limit and a page size into the runner's operation and mapping
  rows (`$select`, `$filter`, `$top`, `Prefer: odata.maxpagesize`, paging by `@odata.nextLink` on the source's own host);
  `odataFilter` writes each filter value as an OData literal of its declared type, so no tool input can add a clause.
  Runner paths may now quote a key that has dots in it: `["@odata.nextLink"]`.
- 381a3c4: `@weaveintel/connect/replay` can now record a sandbox exchange set: `createRecordingSend(live, options)` sits in front
  of a live Send only when `CONNECT_RECORD=1`, keeps an allowlist of headers (authorisation and cookie headers are never
  written), scrubs tokens, emails and account-like numbers, and writes `<pack>/test/<name>.recording.json` marked as a
  scrubbed sandbox recording, refusing to write while anything still looks like a secret. Recording and replay use a
  fixed run reference (`REPLAY_RUN_REF`, `replayIdempotencyKey`) and an injected clock, so they are deterministic. A
  replaying Send now also says which recorded exchanges nothing asked for (`unused()`).
