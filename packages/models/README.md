# @weaveintel/models

Unified model router with fallback chains, streaming, middleware composition, and capability-based selection.

## Features

- **Provider registry** — Register any model provider by name, create models via `createModel()`
- **Fallback chains** — Automatic failover across models for both `generate()` and `stream()` calls
- **Middleware** — Wrap `generate()` and `stream()` with typed middleware (observability, retries, caching)
- **Embedding router** — Parallel registry for embedding models with fallback support
- **Capability selection** — Find the right model for the job with `selectModelByCapability()`

## Usage

```typescript
import { createModel, modelObservabilityMiddleware } from '@weaveintel/models';
import '@weaveintel/provider-openai'; // auto-registers 'openai'

const model = createModel({
  provider: 'openai',
  model: 'gpt-4o',
  fallback: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  middleware: [modelObservabilityMiddleware(eventBus)],
});

const response = await model.generate(ctx, { messages: [...] });
```

## API

| Export | Description |
|---|---|
| `registerModelProvider(name, factory)` | Register a chat model provider |
| `createModel(opts)` | Create a model with fallback + middleware |
| `registerEmbeddingProvider(name, factory)` | Register an embedding provider |
| `createEmbeddingModel(opts)` | Create an embedding model with fallback |
| `modelObservabilityMiddleware(bus)` | Middleware that emits model events |
| `streamObservabilityMiddleware(bus)` | Middleware for stream lifecycle events |
| `selectModelByCapability(models, ...caps)` | Find model matching capabilities |
| `selectEmbeddingByCapability(models, ...caps)` | Find embedding model matching capabilities |
