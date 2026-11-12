# @weaveintel/provider-registry

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
