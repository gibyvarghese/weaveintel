# @weaveintel/connect

Building blocks for prepackaged connections to outside applications, where a connector is **data** (operations,
mappings, credential kinds) run by a small amount of generic, tested code.

| Subpath | What it gives |
|---|---|
| `@weaveintel/connect` | Shared words: wire request, the `Send` function a host supplies, the closed list of outcomes |
| `@weaveintel/connect/credentials` | Credential kinds and their appliers (attach a key, sign, fetch or refresh a token), a single-flight token cache |
| `@weaveintel/connect/runner` | The generic operation runner: builds a request from mapping rows, follows paging, maps the answer through declared outputs, normalises errors |
| `@weaveintel/connect/inbound` | Verifier presets for inbound deliveries (HMAC header, timestamped HMAC, shared basic) and a replay cache |
| `@weaveintel/connect/replay` | Record-and-replay exchanges for tests, with secret and personal-data scrubbing |

**The network is always the caller's.** Nothing here opens a socket or calls `fetch`; a host passes a `Send` that
goes through its own outbound door. **No expressions**: every transform, paging style, verifier and signing profile
is a closed, named list.
