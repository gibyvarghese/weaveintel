# @weaveintel/provider-registry

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
