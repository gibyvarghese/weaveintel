# @weaveintel/core

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
