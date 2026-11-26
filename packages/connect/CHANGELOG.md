# @weaveintel/connect

## 0.4.0

### Minor Changes

- ee6ef7e: New subpath `@weaveintel/connect/forms`: ask a person an application's form and submit their answers, the same way for every application. `fromDefinition` turns an application's own form definition (a catalogue item, issue create metadata, list columns) into one `FormSpec` through a declarative mapping a connector pack ships as data. `nextQuestions`/`applicable` follow the form's show, hide and require rules. `toElicitation`/`fromElicitation` ask through MCP elicitation (form mode). `validate`/`normalise` check answers and turn them into what the application accepts (choice values, lookup ids, and date-times converted from the person's time zone into the application's). `summarise` gives the answers in the person's words for the confirmation, and `guidedSubmit` runs the whole loop with asking, lookup and submit supplied by the caller.
- b29c076: The partner vocabulary: connectors described entirely as rows.
  - Runner: body formats `multipart`, `binary`, `text`; answer formats `text` and `file` (file references, never bytes);
    value encodings (`adf_document`, `comma_list`, `json_text`); query clauses for ServiceNow encoded queries, JQL and
    OData filters (field and operator fixed by the row, value escaped; ServiceNow full-text search through its documented
    `123TEXTQUERY321` pseudo-field); allow-listed body merges (`body:x.*`); whole-body
    `body:$`; `maxRequestBytes`; 1-based offset paging (`offsetBase`); rate-limit headers on every result.
  - Credentials: new kinds `jwt_bearer` (RFC 7523, RS256/ES256) and `mtls`; `oauth_refresh` gains `authorize_url`,
    `pkce` and `resource`. Sign-in helpers: `createPkcePair`, `createSignInState`, `buildAuthorizationUrl`,
    `discoverAuthorizationServer` (RFC 9728 + 8414), `registerClient` (RFC 7591).
  - New subpath `@weaveintel/connect/remote`: remote MCP tools and A2A agent skills (0.3 and 1.0) as pinned,
    replayable connector calls over the caller's `send`, with drift detection (`comparePins`).
  - Replay: recordings can carry multipart parts and file answers.

## 0.3.0

### Minor Changes

- c4221cc: One copy of each connector building block.
  - **One OAuth token request**: `requestToken(material, grant, { send, onRotate })` for client credentials, refresh
    token and the authorization-code exchange (with the PKCE verifier). `applyCredential` now uses it, and so does
    `@weaveintel/tools-enterprise`'s `AuthManager`. A rotated refresh token is still handed to `onRotate` before the
    access token is used; refusals carry the sign-in service's status, never its text or a secret.
  - **The shared transform contract (version 1)**: `TRANSFORMS` is the one closed list shared with
    `@schemaweave/inbound`, with the same behaviour, pinned by `transform-vectors.json` (byte-identical in both
    libraries, checked by both test suites). New: `applyMappingTransform`, `isTransform`, `TRANSFORM_CONTRACT_VERSION`,
    and the readers `readDate`, `readNumber`, `readBoolean`.
    **Behaviour changes**: `date` now reads with an agreed order (argument `iso`, `day_first`, `month_first`, or
    `ambiguous` by default) and refuses `03/04/2026` without one; it keeps the zone as written instead of converting to
    UTC (`2026-11-22T10:00:00+13:00` stays as is) and returns `YYYY-MM-DD` for a date without a time. `number` reads
    currency signs, grouping and accounting brackets with an agreed style (argument). `boolean` also reads t/f, y/n,
    checked/unchecked. A `choice_map` miss now passes the trimmed value through (was undefined) so the target field's
    own check refuses it visibly. `epoch_to_datetime` refuses an empty value (was 1970).
  - **Zero copy**: `createRunnerSource(tables, context)` in `@weaveintel/connect/sources` turns connector operations
    into a source with the shape of schemaWeave's `SourceConnectorPort`, so `@schemaweave/virtual` can mount it. Every
    read is one `runOperation` through the host's door; only plain AND-ed literal rules are pushed down; writes refuse.
    `odataSourceTable(source, …)` mounts an OData source the same way.

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
