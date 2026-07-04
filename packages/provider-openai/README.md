# @weaveintel/provider-openai

**The adapter that lets weaveIntel talk to OpenAI's models — chat, embeddings, images, and audio — through the framework's common provider interface.**

## Why it exists

Every AI vendor speaks its own dialect: the request shape, the field names, the way tool calls and images come back are all a little different. Wire your app straight to one vendor and switching later means a rewrite. Think of this package as a power adapter for travelling abroad — your laptop (the rest of weaveIntel) plugs into the same socket everywhere, and the adapter handles the local wiring. This one handles the OpenAI socket, and it covers the widest range of what OpenAI offers.

## When to reach for it

Reach for this when you want your agents and pipelines to run on OpenAI — GPT chat models, embeddings, the agentic Responses API, image generation, text-to-speech and speech-to-text, moderation, managed vector stores, files, or fine-tuning. Prefer Claude instead? Use `@weaveintel/provider-anthropic`. Prefer Gemini? Use `@weaveintel/provider-google`. Want models on your own machine? Use `@weaveintel/provider-ollama` or `@weaveintel/provider-llamacpp`. The consuming code stays the same whichever you pick.

## How to use it

```ts
import { weaveOpenAI } from '@weaveintel/provider-openai';

// One GPT instance, ready behind the framework's common interface.
const model = weaveOpenAI('gpt-4o');

const reply = await model.generate({
  messages: [{ role: 'user', content: 'Explain photosynthesis in one sentence.' }],
});

console.log(reply.text);
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveOpenAI`, `weaveOpenAIModel`, `weaveOpenAIConfig` | Chat models — the quick helper, the class, and its config. |
| `weaveOpenAIEmbedding`, `weaveOpenAIEmbeddingModel` | Turn text into vectors for search and retrieval. |
| `weaveOpenAIResponses`, `weaveOpenAIResponseModel` | The Responses API — an agentic loop with built-in tools. |
| `weaveOpenAIImage`, `weaveOpenAIImageModel`, `buildImageGenerationBody`, `isGptImageModel` | Generate and edit images. |
| `weaveOpenAIAudio`, `weaveOpenAIAudioModel` | Text-to-speech and speech-to-text. |
| `weaveOpenAIVectorStore`, `weaveOpenAIVectorStoreClient` | Create and query OpenAI's managed vector stores. |
| `weaveOpenAIFiles`, `weaveOpenAIFileStorage` | Upload and manage files. |
| `weaveOpenAIModeration`, `weaveOpenAIModerationModel` | Check content against OpenAI's moderation model. |
| `weaveOpenAIFineTuning`, `weaveOpenAIFineTuningProvider` | Run and manage fine-tuning jobs. |

## License

MIT.
