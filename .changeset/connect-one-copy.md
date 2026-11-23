---
"@weaveintel/connect": minor
---

One copy of each connector building block.

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
