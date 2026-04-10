# @weaveintel/testing

Deterministic fakes and test harnesses for WeaveIntel — no API keys needed.

## Exports

| Export | Description |
|---|---|
| `createFakeModel(opts)` | Model with deterministic responses (cycled or dynamic), optional latency and tool calls |
| `createFakeEmbeddingModel(opts)` | Embedding model using content-hash vectors |
| `createFakeVectorStore(opts)` | In-memory vector store with cosine similarity search |
| `createFakeTransportPair()` | Linked in-memory MCP transport pair for client/server testing |

## Usage

```typescript
import {
  createFakeModel,
  createFakeEmbeddingModel,
  createFakeVectorStore,
  createFakeTransportPair,
} from '@weaveintel/testing';

// Fake model — cycles through responses
const model = createFakeModel({
  responses: [
    { content: 'Hello!' },
    { content: '', toolCalls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] },
    { content: 'Final answer based on search results.' },
  ],
});

// Fake embedding — deterministic vectors from content hash
const embedding = createFakeEmbeddingModel({ dimensions: 256 });

// Fake vector store — in-memory with cosine similarity
const store = createFakeVectorStore({ dimensions: 256 });
await store.upsert([{ id: '1', vector: [...], metadata: {} }]);
const results = await store.search({ vector: [...], topK: 5 });

// Fake MCP transport — test client + server in-process
const [clientTransport, serverTransport] = createFakeTransportPair();
```
