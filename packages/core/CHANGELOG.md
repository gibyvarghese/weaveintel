# @weaveintel/core

## 0.2.0

### Changed (breaking)

- **`allowLoopback` defaults to `false`.** The outbound guard used to let `http://localhost` / `127.0.0.1` / `::1`
  through unless a caller said otherwise; a caller that must reach this machine (a local model server, a local
  agent) now says `policy: { allowLoopback: true }`. `provider-ollama`, `provider-llamacpp` and `a2a` do.
- **A hostname that does not resolve is refused** (`ENOTFOUND`, `EAI_AGAIN`, `EAI_FAIL`, `ENODATA`, or no address at
  all). It used to be let through "to fail naturally", which made the guard fail open (security test S3-SSRF-2).

### Fixed (security test wave 4)

- **One classifier for every address the guard judges** (`classifyAddress`): literals, every address a name
  resolves to, and the connect-time pin. CGNAT 100.64/10, NAT64 64:ff9b::/96, IPv4-compatible ::a.b.c.d, 0/8,
  192.0.0.0/24, 198.18/15, multicast and reserved space were classed as public and connected to (S3-SSRF-1).
- **Every redirect hop is pinned** (S3-SSRF-3): `followRedirectsSafely` connects each hop through the new
  `pinnedFetch` (undici's own fetch with a connect-time lookup hook, `pinnedLookup`) instead of the global fetch,
  so the address connected to is the address checked. Credentials (`authorization`, `cookie`, `x-api-key`,
  `api-key`, …) are dropped when a hop leaves the origin.

### Added

- `pinnedFetch`, `pinnedLookup`, `OutboundLookup`, and `OutboundUrlPolicy.lookup` (the resolver the pre-check and
  the pin share — for tests and hosts with their own resolver).

## 0.1.3

### Added

- **Capability profiles** (`ModelCapabilityProfile`): what a model or connection can read and do, as data —
  vision, PDF, audio input, other document types by MIME type, structured output, tool use, context size,
  embedding size and inputs. Profiles fail closed: anything not stated is not supported.
- **What a request needs** (`requiredFeatures`, `missingFeatures`, `profileSupports`, `assertProfileSupports`),
  in the short vocabulary routers already use: `vision`, `pdf`, `audio_in`, `structured_output`, `tools`,
  `document:<mime>`.
- **`UnsupportedContentError`** (code `UNSUPPORTED_CONTENT`, never retryable): the typed refusal adapters
  throw instead of replacing a file with placeholder text. It names the missing capability.
- **Capability ids** `Capabilities.PdfInput`, `AudioInput`, `DocumentInput`, `ImageEmbedding`.
- **Conformance probe** (`probeModelProfile`): a one-word chat, a 32×32 red square, a one-line PDF, a JSON-schema
  question, one tool offer and one embedding, returning the MEASURED profile with evidence per check.
- **Optional multimodal embedding shape** (`MultimodalEmbeddingRequest`, `MultimodalEmbeddingModel`): text or
  image inputs; every vector carries its model and size. `asMultimodalEmbeddingModel` puts a text model behind
  it and refuses images. `EmbeddingResponse` gains an optional `dimensions`.
- **Strict address classification** (`classifyAddress`, `isPublicAddress`) for fetching URLs a person supplied:
  only public unicast passes (blocks loopback, RFC 1918, link-local and metadata, CGNAT, 0/8, benchmarking,
  documentation, multicast, reserved, ULA, IPv4-mapped / IPv4-compatible / NAT64 forms, 6to4 and Teredo).
