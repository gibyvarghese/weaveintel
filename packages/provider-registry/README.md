# @weaveintel/provider-registry

**Model providers as data: describe a provider in a plain record, hand over the *name* of its key, and get working chat and embedding models back. No code change to add a provider.**

## Why it exists

Adding a model provider used to mean importing its package, reading its key from an environment variable and restarting. This package turns that into data. A provider is a small record (which wire format it speaks, where it lives, which region) plus references to its keys. The registry builds a `Model` or `EmbeddingModel` from that record on demand, so a host that keeps the records in a database can add, change or switch off a provider while running.

Think of a universal power adapter: the appliance (your code) is the same everywhere; the adapter head (wire format) and the mains voltage (quirks) are picked from a table.

## When to reach for it

When the set of providers is decided by an administrator at run time rather than by a developer at build time. If you always call one provider with one key from the environment, use that provider's package directly.

## How to use it

```ts
import { createProviderRegistry, openAICompatibleAdapter, azureOpenAIAdapter, bedrockAdapter, OPENAI_COMPATIBLE_PRESETS } from '@weaveintel/provider-registry';
import { weaveContext } from '@weaveintel/core';

const registry = createProviderRegistry({
  adapters: [openAICompatibleAdapter(), azureOpenAIAdapter(), bedrockAdapter()],
  secrets: vault,                       // any SecretResolver: resolve(reference) -> value
  privateEndpoints: () => allowEntries, // operator entries, read on every call
});

const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.key === 'groq')!;
const groq = { id: 'groq-1', kind: 'openai-compatible', displayName: preset.label, baseUrl: preset.baseUrl, quirks: preset.quirks, secrets: { apiKey: 'vault:groq-1/apiKey' } };

const chat = registry.chatModel(groq, { id: 'llama-3.3-70b-versatile', kind: 'chat' });
const answer = await chat.generate(weaveContext(), { messages: [{ role: 'user', content: 'hello' }] });

const test = await registry.testConnection(groq);   // never throws: { ok, outcome, message, modelCount, latencyMs }
const found = await registry.listModels(groq);
```

## What it promises

- **Keys are fetched at call time.** An adapter asks for a secret slot during the call; the registry resolves it through your `SecretResolver` each time. The value is never stored on the model object, so a rotated key is used by the very next call.
- **Keys never leave.** Every value resolved during a call (and its URL-encoded and base64 forms, and each line of a multi-line secret such as a service-account file) is removed from error messages, error details and events before they leave the registry. The original error is not kept as `cause`.
- **Private addresses stay closed.** The transport is stricter than the library default: loopback, private-network and metadata addresses are all refused. A provider is let onto one only when an operator entry names that exact host and port (optionally for one provider id); then only that host is admitted and redirects are refused. Plain `http` is only ever possible to the machine itself; a private host elsewhere must use `https`.
- **Embeddings are first-class.** A model's descriptor says its native size, the sizes it can produce and how (a provider parameter, or cut down and re-normalised here), its batch limit, and whether it normalises. The registry batches, sizes, normalises to unit length where the provider does not, refuses a size the model cannot produce, and returns `provenance` (provider, model, dimensions, whether it normalised or reduced) with every response.
- **Failures are plain and typed.** Rejected key, rate limit (with the wait the provider asked for), timeout, malformed reply, blocked address and "being rested" (circuit open) each have their own code and a sentence a person can read. Retries and the circuit breaker come from `@weaveintel/resilience`, keyed per provider.

## What's in the box

- **Registry**: `createProviderRegistry` → `chatModel`, `embeddingModel`, `listModels`, `testConnection`, `kinds`.
- **Adapters**: `openAICompatibleAdapter` (Groq, Together, Fireworks, Mistral, OpenRouter, DeepSeek, vLLM, LM Studio, Ollama's `/v1`, TEI: see `OPENAI_COMPATIBLE_PRESETS`), `databricksAdapter`, `azureOpenAIAdapter`, `azureFoundryAdapter`, `bedrockAdapter` (Converse, ConverseStream, Titan and Cohere embeddings; SigV4 or a Bedrock API key), `wrappedFactoryAdapter` (puts an existing provider package behind the registry with its key fetched per call).
- **Quirks are data**: `WireQuirks` on a provider row (token-limit parameter name, usage in the stream, tool choice, embedding size parameter, auth style, model in path or body, path templates).
- **Writing an adapter**: `ProviderAdapter`, plus `httpFailure`, `parseJsonBody`, `malformed`, `sseData`, `signRequest`, `readEventStream`.
- **Contract tests**: `@weaveintel/provider-registry/contract` exports `providerContractCases`, the cases every adapter must pass against a fake server (answer, tool call, streaming, embeddings, list and test, rate limit with wait, rejected key without the key, timeout, malformed reply, server failure). Fakes live in `@weaveintel/testing`.

The Google adapters (`gemini`, `vertex`) live in `@weaveintel/provider-google`.

## Not verified against the real services

The adapters are written from the public API documents and proved against in-process fake servers written by the same author. No call has been made to Azure, AWS, Databricks or Groq.

## License

MIT.
