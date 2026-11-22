# @weaveintel/testing

## 0.1.3

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
  - @weaveintel/sandbox@0.1.5

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
- Updated dependencies [049a0d2]
  - @weaveintel/core@0.2.0
  - @weaveintel/sandbox@0.1.4

### Added

- **Fake provider servers** (`provider-fakes.ts`): `startFakeOpenAICompatibleServer` (also Azure and
  Databricks path shapes), `startFakeBedrockServer` (Converse, ConverseStream in the binary event-stream
  framing, Titan and Cohere embeddings, model list; checks a bearer key or recomputes the SigV4 signature
  itself) and `startFakeGoogleServer` (Gemini API and Vertex AI, with a token endpoint that verifies the
  signed JWT). Each records its requests and has failure modes: rate limit with a wait, server failure,
  malformed reply, no answer. Helpers `fakeReplyText`, `fakeVector`, `fakeEventStreamMessage`.
