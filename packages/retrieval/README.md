# @weaveintel/retrieval

**The RAG pipeline: turn documents into searchable chunks, embed them, and fetch the passages that answer a question — with verified quote citations.**

## Why it exists

An LLM can't read your 400-page handbook on every question — the whole book won't fit in the prompt, and stuffing it in would be slow and expensive. So you do what a good librarian does: break the book into index cards, file them by meaning, and when someone asks a question, pull only the few cards that matter and hand those over. That "pull the few relevant cards" step is retrieval, and this package is the whole conveyor belt — chunk, embed, retrieve — plus the tools to make the answer cite exactly which card each claim came from.

## When to reach for it

Reach for it to ground an answer in a body of documents at query time: knowledge bases, docs, transcripts, any "answer from these sources" feature. It handles chunking strategies, embedding, plain and hybrid (keyword + vector) retrieval, query rewriting/expansion, and citation verification. If instead you want the agent to remember facts across a conversation, that's `@weaveintel/memory`; if you just want to avoid recomputing an identical LLM call, that's `@weaveintel/cache`.

## How to use it

```ts
import { weaveChunker } from '@weaveintel/retrieval';

const chunker = weaveChunker({ strategy: 'semantic_boundary', chunkSize: 800, chunkOverlap: 80 });

const chunks = chunker.chunk(handbookText);
// → DocumentChunk[], each a self-contained passage ready to embed and retrieve
console.log(chunks.length, 'chunks ready for embedding');
```

## What's in the box

- **Ingest & retrieve** — `weaveChunker`, `weaveEmbeddingPipeline`, `weaveRetriever`.
- **Better recall** — `weaveHybridRetriever` (keyword + vector), `weaveQueryRewriter`, `buildQueryExpansionPrompt`/`parseExpandedQueries` (multi-query + HyDE), `reciprocalRankFusion`.
- **Cited answers** — `buildCitedAnswerPrompt`, `parseCitedAnswer`, `locateQuote`, `verifyCitations` (drops hallucinated quotes), `answerCitationCoverage`, `enforceCitationStrictness`, `buildCitedContext`, `snippetAround`.
- **Per-chunk citations** — `weaveCitationExtractor`.
- **Observability** — `weaveRetrievalDiagnostics`.

## License

MIT.
