# @weaveintel/provider-google

## 0.1.4

### Patch Changes

- Bring `feat/file-understanding` to `main`, so its packages can be published from here.

  These versions were only ever served from a private registry. npm had `core`, `guardrails`, `routing` and
  `provider-google` under the same or lower numbers but different code, and had no `provider-registry` at all.
  - **core (breaking, hence minor on 0.x).** The strict outbound guard is merged with `main`'s hardened egress.
    - `allowLoopback` now defaults to `false`. Callers that reach this machine opt in; `provider-ollama`,
      `provider-llamacpp` and `a2a` already do.
    - A hostname that does not resolve is refused.
    - One address classifier (`classifyAddress`) is used for literals, resolved addresses and the connect-time pin.
      It also covers CGNAT, NAT64 and the other special ranges.
    - Every request and every redirect hop is pinned with `pinnedFetch` / `pinnedLookup`, and the resolver can be
      supplied with `OutboundUrlPolicy.lookup`.
    - Kept from `main`:
      - A redirect to another origin is refused unless `allowCrossOriginRedirects` is set. It must then be a bodyless
        GET or HEAD, and it carries no caller header at all.
      - Known metadata addresses are refused even when private networks are allowed.
      - `allowInsecureHttp` is available for trusted hosts.
      - `hardenedFetch` keeps the `follow`, `manual` and `error` redirect modes.
    - Also added: capability profiles, a conformance probe and a typed refusal for unreadable content.
  - **extraction:** a file-understanding service with in-house readers, schema-forced extraction and validation, and
    guarded file sources.
  - **routing:** a rule router over plain rows, and filtering on the input capabilities a request needs.
  - **provider-google:** Gemini and Vertex AI as registry adapters.
  - **provider-registry:** new on npm. Model providers as data, with keys fetched per call and a guarded transport.
  - **observability:** the OTLP sink still reaches a collector on this machine (`http://localhost:4318`) by default, now
    that core no longer allows loopback unless asked. Private networks and non-loopback HTTP still need `egressPolicy`.
  - **guardrails, testing and providers:** the file-content fence, the fake provider servers, and file, PDF and audio
    parts that are sent properly or refused by name.

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/provider-registry@0.1.3
  - @weaveintel/resilience@0.1.3
  - @weaveintel/tools@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/resilience@0.1.2
  - @weaveintel/tools@0.2.1

## 0.1.3

### Changed

- Gemini parts are sent properly or refused with `UnsupportedContentError`: a part with no content is no
  longer sent as an empty inline blob, file types Gemini does not read (Word, Excel, zip) are refused, and a
  file in a system instruction is refused rather than dropped.
- Vision models declare `PdfInput`, `AudioInput` and `DocumentInput`.

## 0.1.2

### Added

- **`geminiAdapter()`** (kind `gemini`) for `@weaveintel/provider-registry`: chat, streaming, tool use,
  embeddings through `batchEmbedContents` (size and document/query mode), list models and test
  connection. The API key travels in the `x-goog-api-key` header and is fetched per call.
- **`vertexAdapter()`** (kind `vertex`): the same for Vertex AI. Project and location are data; the key
  is a service-account file, from which the adapter signs an RS256 statement with `node:crypto`,
  exchanges it for an access token and keeps the token for its lifetime, keyed by a hash of the file.
  Embeddings go through `:predict`, or `:embedContent` when the provider row says so.
- `googleErrorOverride`: a wrong Gemini key (which Google answers with 400) and a refused
  service-account file are reported as authentication failures.

### Changed

- New dependency on `@weaveintel/provider-registry`. `weaveGoogle`, `weaveGoogleModel` and
  `weaveGoogleConfig` are unchanged.

### Notes

- Built from Google's public API documents and proved against an in-process fake server. Not verified
  against Google: see the README section "Not verified against Google".
- The version is 0.1.2, not 0.2.0, so packages that ask for `^0.1.1` keep resolving it.
