# @weaveintel/provider-openai

OpenAI provider adapter for WeaveIntel — chat completions, embeddings, and streaming.

## Features

- **Auto-capability detection** — Detects chat, reasoning, vision, tool calling, streaming, and structured output capabilities based on model ID
- **Streaming** — Native SSE streaming with proper chunk parsing
- **Embeddings** — Full embedding model support via `createOpenAIEmbedding()`
- **Auto-registration** — Importing this package registers `'openai'` as a provider in the model router

## Usage

```typescript
// Option 1: Direct creation
import { createOpenAIModel, createOpenAIEmbedding } from '@weaveintel/provider-openai';

const model = createOpenAIModel({ apiKey: '...', model: 'gpt-4o' });
const embedding = createOpenAIEmbedding({ apiKey: '...' });

// Option 2: Via router (import triggers auto-registration)
import '@weaveintel/provider-openai';
import { createModel, createEmbeddingModel } from '@weaveintel/models';

const model = createModel({ provider: 'openai', model: 'gpt-4o' });
const embedding = createEmbeddingModel({ provider: 'openai', model: 'text-embedding-3-small' });

// Option 3: Global config
import { configureOpenAI, openai, openaiEmbedding } from '@weaveintel/provider-openai';

configureOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = openai('gpt-4o');
const embedding = openaiEmbedding('text-embedding-3-small');
```

## API

| Export | Description |
|---|---|
| `createOpenAIModel(opts)` | Create an OpenAI chat model |
| `createOpenAIEmbedding(modelId?, opts?)` | Create an OpenAI embedding model |
| `configureOpenAI(opts)` | Set global API key and options |
| `openai(modelId, opts?)` | Convenience — create model with global config |
| `openaiEmbedding(modelId?, opts?)` | Convenience — create embedding with global config |
| `OpenAIProviderOptions` | Configuration type (apiKey, baseUrl, organization, etc.) |
