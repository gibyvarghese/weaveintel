# @weaveintel/provider-registry

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
  - @weaveintel/resilience@0.1.3

## 0.1.2

### Fixed (security test wave 4)

- Depends on `@weaveintel/core` ^0.2.0: with no operator entry, a provider address in CGNAT 100.64/10, NAT64
  64:ff9b::/96 or IPv4-compatible form, or a name that does not resolve, is now refused as `blocked`
  (`POLICY_DENIED`) before anything is sent — it was attempted. Redirect hops of a public call are pinned.
  A test pins all four with `testConnection` and `listModels`.

## 0.1.1

### Changed

- **OpenAI-compatible endpoints** (Azure OpenAI, Foundry, Databricks, vLLM, ...): PDF (`file` part, neutral
  name) and audio (`input_audio`) are sent when the model row declares `pdf` / `audio_in`; every other non-text,
  non-image part is refused with `UnsupportedContentError` naming the capability (it used to throw a plain
  `INVALID_INPUT`).
- **Bedrock Converse**: `document` blocks for pdf, csv, doc, docx, xls, xlsx, html, txt and md when the row
  declares `pdf` or `document:<mime>`, with neutral names (`document 1`, ...) because Bedrock warns the name is
  open to prompt injection; `audio` blocks when the row declares `audio_in`. A file in a system prompt or a tool
  result is refused instead of dropped. `toConverseMessages` takes the model row.
- Model rows accept `pdf`, `audio_in` and `document:<mime>` in `capabilities`.

### Added

- `profileOfModel(row)`: the row's capability profile. `BEDROCK_DOCUMENT_FORMATS`, `BEDROCK_AUDIO_FORMATS`.

## 0.1.0

### Added

- **The registry** (`createProviderRegistry`): builds chat and embedding models from a plain
  `ProviderDescription` and `ModelDescription`. Keys are named by reference and fetched through a
  `SecretResolver` during each call; they are never held on the model object, and every value used in a
  call is removed from errors and events before they leave.
- **Guarded transport**: one fetch seam, stricter than the library default (no loopback, no private
  network). An operator entry for an exact host and port, optionally for one provider, opens that host
  only and forbids redirects. Entries can be a function, read on every call.
- **Adapters**: OpenAI-compatible (quirks as data, with presets for Groq, Together, Fireworks, Mistral,
  OpenRouter, DeepSeek, vLLM, LM Studio, Ollama and TEI), Databricks serving endpoints, Azure OpenAI
  deployments, Azure AI Foundry inference, AWS Bedrock (Converse, ConverseStream, Titan and Cohere
  embeddings, SigV4 with `node:crypto` or a Bedrock API key), and a wrapper for existing provider
  factories.
- **Embeddings as first-class models**: descriptor (native size, sizes, reduce method, batch limit,
  normalised, modes), batching, unit-length normalisation, size refusal, provenance on every response.
- **Test connection and list models** for every adapter; `testConnection` never throws.
- **Contract cases** at `@weaveintel/provider-registry/contract`.
