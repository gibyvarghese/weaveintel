# @weaveintel/retrieval

Document ingestion, chunking, embedding, and retrieval pipeline.

## Features

- **6 chunking strategies** — fixed-size, heading-aware, code-aware, semantic-boundary, table-aware, adaptive
- **Embedding pipeline** — Chunk → embed → store in a single `ingestDocument()` call
- **Vector retriever** — Query → embed → search → optional rerank
- **Reranking** — Pluggable reranker support for result refinement

## Usage

```typescript
import { createChunker, createEmbeddingPipeline, createVectorRetriever } from '@weaveintel/retrieval';

const chunker = createChunker({ strategy: 'fixed-size', chunkSize: 512, overlap: 50 });

const pipeline = createEmbeddingPipeline({ embeddingModel, vectorStore, chunker });
await pipeline.ingestDocument(document, ctx);

const retriever = createVectorRetriever({ embeddingModel, vectorStore, topK: 5 });
const results = await retriever.retrieve({ query: 'How does X work?' }, ctx);
```
