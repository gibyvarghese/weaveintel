/**
 * Example 03: RAG Pipeline
 *
 * Demonstrates document ingestion (chunk → embed → index)
 * and retrieval-augmented generation (query → retrieve → generate).
 * Uses fake models and vector store for deterministic execution.
 */
import { createExecutionContext } from '@weaveintel/core';
import type { Document } from '@weaveintel/core';
import { createChunker, createEmbeddingPipeline, createVectorRetriever } from '@weaveintel/retrieval';
import { createFakeEmbeddingModel, createFakeVectorStore, createFakeModel } from '@weaveintel/testing';

async function main() {
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // Setup
  const embeddingModel = createFakeEmbeddingModel({ dimensions: 128 });
  const vectorStore = createFakeVectorStore();
  const chunker = createChunker({ strategy: 'fixed_size', chunkSize: 200, overlap: 50 });

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

  const pipeline = createEmbeddingPipeline({
    chunker,
    embeddingModel,
    vectorStore,
  });

  for (const doc of documents) {
    const chunks = await pipeline.ingest(doc, ctx);
    console.log(`  Ingested "${doc.metadata.title}" → ${chunks.length} chunks`);
  }

  // --- Retrieve ---
  console.log('\n=== Retrieval ===');

  const retriever = createVectorRetriever({
    embeddingModel,
    vectorStore,
    topK: 3,
  });

  const query = 'Who created TypeScript?';
  const results = await retriever.retrieve(query, ctx);

  console.log(`Query: "${query}"`);
  console.log(`Retrieved ${results.length} chunks:`);
  for (const chunk of results) {
    console.log(`  [score=${chunk.score?.toFixed(3)}] ${chunk.content.slice(0, 80)}...`);
  }

  // --- Generate answer with context ---
  console.log('\n=== Generation ===');

  const model = createFakeModel({
    responses: [
      {
        content: 'TypeScript was developed by Microsoft and first released in 2012.',
        toolCalls: [],
      },
    ],
  });

  const context = results.map((r) => r.content).join('\n\n');
  const answer = await model.chat(
    {
      messages: [
        {
          role: 'system',
          content: `Answer based on context:\n\n${context}`,
        },
        { role: 'user', content: query },
      ],
    },
    ctx,
  );

  console.log(`Answer: ${answer.content}`);
}

main().catch(console.error);
