# @weaveintel/connect

Building blocks for prepackaged connections to outside applications, where a connector is **data** (operations,
mappings, credential kinds) run by a small amount of generic, tested code.

| Subpath | What it gives |
|---|---|
| `@weaveintel/connect` | Shared words: wire request, the `Send` function a host supplies, the closed list of outcomes |
| `@weaveintel/connect/credentials` | Credential kinds and their appliers (attach a key, sign, fetch or refresh a token, JWT bearer, mutual TLS), a single-flight token cache, and sign-in helpers (PKCE, discovery, dynamic client registration) |
| `@weaveintel/connect/runner` | The generic operation runner: builds a request from mapping rows (JSON, form, multipart, binary, text bodies; query clauses; encodings such as ADF; allow-listed merges), follows paging, maps the answer (JSON, text, file references) through declared outputs, normalises errors and reports rate limits |
| `@weaveintel/connect/inbound` | Verifier presets for inbound deliveries (HMAC header, timestamped HMAC, shared basic) and a replay cache |
| `@weaveintel/connect/replay` | Record-and-replay exchanges for tests, with secret and personal-data scrubbing; recording a sandbox (`createRecordingSend`) only with `CONNECT_RECORD=1` |
| `@weaveintel/connect/remote` | Remote MCP tools and A2A agent skills (0.3 and 1.0) as connector calls: pinned by fingerprint, drift refused before sending, same mapping rows and replay kit |
| `@weaveintel/connect/sources` | Source adapters on the runner: OData (`$select`, `$filter` from typed inputs, `$top`, page size, `@odata.nextLink` paging); REST is the runner itself |

**The network is always the caller's.** Nothing here opens a socket or calls `fetch`; a host passes a `Send` that
goes through its own outbound door. **No expressions**: every transform, paging style, verifier and signing profile
is a closed, named list.

## Examples

- [`examples/packages/connect-operations.ts`](../../examples/packages/connect-operations.ts): a connector as rows, run against a recording.
- [`examples/packages/connect-signin.ts`](../../examples/packages/connect-signin.ts): discovery, registration, PKCE, JWT bearer, mutual TLS.
- [`examples/packages/connect-remote.ts`](../../examples/packages/connect-remote.ts): pinned MCP tools and A2A agents.
