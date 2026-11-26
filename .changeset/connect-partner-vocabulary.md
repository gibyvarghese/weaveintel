---
"@weaveintel/connect": minor
---

The partner vocabulary: connectors described entirely as rows.

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
