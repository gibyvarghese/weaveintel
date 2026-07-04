# @weaveintel/provider-ollama

**The adapter that lets weaveIntel talk to local LLMs served by Ollama, through the framework's common provider interface.**

## Why it exists

Cloud AI vendors each speak their own dialect, and so does the model runner on your own machine. The rest of weaveIntel shouldn't have to care which one is answering. Think of this package as a power adapter for travelling abroad — your laptop plugs into the same socket everywhere, and the adapter handles the local wiring. This one plugs into [Ollama](https://ollama.com), so a model running on your own laptop looks exactly like a cloud model to the rest of your code — no API key, no data leaving the building.

## When to reach for it

Reach for this when you want to run open models locally through Ollama — Llama, Mistral, Qwen, Phi, Gemma, DeepSeek and friends — and have them slot into your agents like any other provider. Great for privacy, offline work, or zero per-token cost. If you'd rather run raw GGUF files on a llama.cpp server, use `@weaveintel/provider-llamacpp`. For hosted models, reach for `@weaveintel/provider-anthropic`, `@weaveintel/provider-openai`, or `@weaveintel/provider-google`.

## How to use it

```ts
import { weaveOllama } from '@weaveintel/provider-ollama';

// Talks to your local Ollama server (default http://localhost:11434).
const model = weaveOllama('llama3.1');

const reply = await model.generate({
  messages: [{ role: 'user', content: 'Explain photosynthesis in one sentence.' }],
});

console.log(reply.text);
```

Importing auto-registers the `ollama` provider. The default base URL is `http://localhost:11434`; override it with the `OLLAMA_BASE_URL` environment variable or per instance.

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveOllama` | Quick way to get a ready-to-use local chat model instance. |
| `weaveOllamaEmbedding` | Quick way to get a local embedding model for turning text into vectors. |
| `weaveOllamaModel`, `weaveOllamaEmbeddingModel` | The underlying model classes, for finer control. |
| `weaveOllamaConfig` | Configuration (base URL, etc.) used when constructing a model. |
| `ollamaFetch`, `assertHttpsOrLoopback` | The safety-checked fetch used to talk to Ollama (guards against calling non-local, non-HTTPS hosts). |
| `OllamaProviderOptions`, `OllamaFetchOptions` | TypeScript types for the options above. |

## License

MIT.
