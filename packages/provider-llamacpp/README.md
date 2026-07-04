# @weaveintel/provider-llamacpp

**The adapter that lets weaveIntel talk to local GGUF models running on a llama.cpp HTTP server, through the framework's common provider interface.**

## Why it exists

Cloud AI vendors each speak their own dialect, and so does the little server you run on your own machine. The rest of weaveIntel shouldn't have to care which one is answering. Think of this package as a power adapter for travelling abroad — your laptop plugs into the same socket everywhere, and the adapter handles the local wiring. This one plugs into a llama.cpp server, so a model running quietly on your own laptop looks exactly like a cloud model to the rest of your code — no API key, no data leaving the building.

## When to reach for it

Reach for this when you're running GGUF models locally via the [llama.cpp](https://github.com/ggml-org/llama.cpp) HTTP server and want them to slot into your agents like any other provider — great for privacy, offline work, or zero per-token cost. If you'd rather manage local models through the friendlier Ollama runner, use `@weaveintel/provider-ollama`. For hosted models, reach for `@weaveintel/provider-anthropic`, `@weaveintel/provider-openai`, or `@weaveintel/provider-google` instead.

## How to use it

```ts
import { weaveLlamaCpp } from '@weaveintel/provider-llamacpp';

// Talks to a llama.cpp server (default http://localhost:8080).
const model = weaveLlamaCpp('local-model');

const reply = await model.generate({
  messages: [{ role: 'user', content: 'Explain photosynthesis in one sentence.' }],
});

console.log(reply.text);
```

Importing auto-registers the `llamacpp` provider. The default base URL is `http://localhost:8080`; override it with the `LLAMACPP_BASE_URL` environment variable or per instance.

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveLlamaCpp` | Quick way to get a ready-to-use local chat model instance. |
| `weaveLlamaCppEmbedding` | Quick way to get a local embedding model for turning text into vectors. |
| `weaveLlamaCppModel`, `weaveLlamaCppEmbeddingModel` | The underlying model classes, for finer control. |
| `weaveLlamaCppConfig` | Configuration (base URL, etc.) used when constructing a model. |
| `LlamaCppProviderOptions` | The TypeScript type describing those options. |

## License

MIT.
