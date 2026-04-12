/**
 * Example 03: RAG Pipeline
 *
 * Demonstrates document ingestion (chunk → embed → index)
 * and retrieval-augmented generation (query → retrieve → generate).
 * Uses fake models and vector store for deterministic execution.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core      — ExecutionContext and the Document type
 *   @weaveintel/retrieval — weaveEmbeddingPipeline() for ingest, weaveRetriever() for search
 *   @weaveintel/testing   — weaveFakeEmbedding / weaveFakeVectorStore / weaveFakeModel
 *                           for deterministic, no-API execution
 */
import { weaveContext } from '@weaveintel/core';
import type { Document } from '@weaveintel/core';
import { weaveEmbeddingPipeline, weaveRetriever } from '@weaveintel/retrieval';
import { weaveFakeEmbedding, weaveFakeVectorStore, weaveFakeModel } from '@weaveintel/testing';

async function main() {
  const ctx = weaveContext({ userId: 'demo-user' });

  // weaveFakeEmbedding() returns random fixed-dimension vectors.
  // In production you'd use weaveOpenAIModel({ model: 'text-embedding-3-small' })
  // or any provider that implements the EmbeddingModel interface.
  const embeddingModel = weaveFakeEmbedding({ dimensions: 128 });

  // weaveFakeVectorStore() is an in-memory store that implements the VectorStore
  // interface (upsert / query / delete). For production use weaveIntel supports
  // Pinecone, Qdrant, Weaviate, ChromaDB, etc. via @weaveintel/core connectors.
  const vectorStore = weaveFakeVectorStore();

  // --- Ingest documents ---
  console.log('=== Document Ingestion ===');

  const documents: Document[] = [
    {
      id: 'doc-1',
      content: `TypeScript is a strongly typed programming language that builds on JavaScript.
        It was developed by Microsoft and first released in 2012. TypeScript adds optional
        static typing and class-based object-oriented programming to the language. The 
        language is designed for development of large applications and transpiles to JavaScript.`,
      metadata: { source: 'wiki', title: 'TypeScript Overview' },
    },
    {
      id: 'doc-2',
      content: `Rust is a multi-paradigm, general-purpose programming language that emphasizes
        performance, type safety, and concurrency. It enforces memory safety without a garbage
        collector. Rust was originally designed by Graydon Hoare at Mozilla Research.
        It has consistently been the most loved programming language in Stack Overflow surveys.`,
      metadata: { source: 'wiki', title: 'Rust Overview' },
    },
    {
      id: 'doc-3',
      content: `Python is a high-level, general-purpose programming language. Its design
        philosophy emphasizes code readability. Python supports multiple programming paradigms,
        including structured, object-oriented and functional programming. It was created by
        Guido van Rossum and first released in 1991.`,
      metadata: { source: 'wiki', title: 'Python Overview' },
    },
  ];

  // weaveEmbeddingPipeline() creates a three-stage ingest pipeline:
  //   1. Chunker   — splits large documents into smaller pieces (here: 200 chars, 50 overlap)
  //   2. Embedder  — converts each chunk into a dense vector using the embedding model
  //   3. Indexer   — upserts the (vector, metadata) pairs into the vector store
  // The "fixed_size" strategy splits on character count; other strategies include
  // 'sentence', 'paragraph', and 'recursive' for smarter boundaries.
  const pipeline = weaveEmbeddingPipeline({
    chunkerConfig: { strategy: 'fixed_size', chunkSize: 200, overlap: 50 },
    embeddingModel,
    vectorStore,
  });

  for (const doc of documents) {
    const chunks = await pipeline.ingestDocument(ctx, doc);
    console.log(`  Ingested "${doc.metadata.title}" → ${chunks.length} chunks`);
  }

  // --- Retrieve ---
  console.log('\n=== Retrieval ===');

  // weaveRetriever() wraps the embedding model + vector store into a simple
  // .retrieve(ctx, { query }) call. It embeds the user's question, performs
  // a nearest-neighbor search in the vector store, and returns ranked chunks.
  // defaultTopK controls how many chunks to return.
  const retriever = weaveRetriever({
    embeddingModel,
    vectorStore,
    defaultTopK: 3,
  });

  const query = 'Who created TypeScript?';
  const results = await retriever.retrieve(ctx, { query });

  console.log(`Query: "${query}"`);
  console.log(`Retrieved ${results.chunks.length} chunks:`);
  for (const chunk of results.chunks) {
    console.log(`  ${chunk.content.slice(0, 80)}...`);
  }

  // --- Generate answer with context ---
  console.log('\n=== Generation ===');

  const model = weaveFakeModel({
    responses: [
      {
        content: 'TypeScript was developed by Microsoft and first released in 2012.',
        toolCalls: [],
      },
    ],
  });

  // The retrieved chunks are concatenated into a context string and injected
  // into the system prompt, giving the LLM relevant knowledge to answer
  // the user's question — this is the "augmented generation" step in RAG.
  const context = results.chunks.map((r) => r.content).join('\n\n');
  const answer = await model.generate(
    ctx,
    {
      messages: [
        {
          role: 'system',
          content: `Answer based on context:\n\n${context}`,
        },
        { role: 'user', content: query },
      ],
    },
  );

  console.log(`Answer: ${answer.content}`);
}

main().catch(console.error);
