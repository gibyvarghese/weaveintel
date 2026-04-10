/**
 * @weaveintel/retrieval — Embedding pipeline & retriever
 *
 * Why: The embedding pipeline connects chunking → embedding → indexing.
 * The retriever connects query → embedding → vector search → (optional) reranking.
 * Both are composable and work with any embedding model and vector store.
 */

import type {
  ExecutionContext,
  EmbeddingModel,
  RerankerModel,
  VectorStore,
  VectorRecord,
  DocumentChunk,
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  Document,
  Indexer,
  EventBus,
} from '@weaveintel/core';
import { createEvent, EventTypes } from '@weaveintel/core';
import { createChunker } from './chunker.js';
import type { ChunkerConfig } from '@weaveintel/core';

// ─── Embedding pipeline ──────────────────────────────────────

export interface EmbeddingPipelineConfig {
  embeddingModel: EmbeddingModel;
  vectorStore: VectorStore;
  chunkerConfig?: Partial<ChunkerConfig>;
  batchSize?: number;
  eventBus?: EventBus;
}

export function createEmbeddingPipeline(config: EmbeddingPipelineConfig): Indexer & {
  ingestDocument(ctx: ExecutionContext, doc: Document): Promise<DocumentChunk[]>;
  ingestText(ctx: ExecutionContext, text: string, metadata?: Record<string, unknown>): Promise<DocumentChunk[]>;
} {
  const chunker = createChunker(config.chunkerConfig);
  const batchSize = config.batchSize ?? 100;

  async function embedAndStore(ctx: ExecutionContext, chunks: DocumentChunk[]): Promise<DocumentChunk[]> {
    const enrichedChunks: DocumentChunk[] = [];

    // Batch embed
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);

      config.eventBus?.emit(
        createEvent(EventTypes.IndexingStart, { batchIndex: i, batchSize: batch.length }, ctx),
      );

      const embeddingResponse = await config.embeddingModel.embed(ctx, { input: texts });
      const records: VectorRecord[] = [];

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const embedding = embeddingResponse.embeddings[j]!;
        enrichedChunks.push({ ...chunk, embedding });
        records.push({
          id: chunk.id,
          embedding,
          content: chunk.content,
          metadata: {
            ...chunk.metadata,
            documentId: chunk.documentId,
            chunkIndex: chunk.index,
          },
        });
      }

      await config.vectorStore.upsert(ctx, records);

      config.eventBus?.emit(
        createEvent(EventTypes.IndexingEnd, { indexed: records.length }, ctx),
      );
    }

    return enrichedChunks;
  }

  return {
    async index(ctx: ExecutionContext, chunks: DocumentChunk[]): Promise<void> {
      await embedAndStore(ctx, chunks);
    },

    async ingestDocument(ctx: ExecutionContext, doc: Document): Promise<DocumentChunk[]> {
      const chunks = chunker.chunk(doc.content);
      const withDocId = chunks.map((c) => ({
        ...c,
        documentId: doc.id,
        metadata: { ...c.metadata, ...doc.metadata },
        source: doc.source,
      }));
      return embedAndStore(ctx, withDocId);
    },

    async ingestText(
      ctx: ExecutionContext,
      text: string,
      metadata?: Record<string, unknown>,
    ): Promise<DocumentChunk[]> {
      const chunks = chunker.chunk(text);
      const enriched = metadata
        ? chunks.map((c) => ({ ...c, metadata: { ...c.metadata, ...metadata } }))
        : chunks;
      return embedAndStore(ctx, enriched);
    },
  };
}

// ─── Vector retriever ────────────────────────────────────────

export interface VectorRetrieverConfig {
  embeddingModel: EmbeddingModel;
  vectorStore: VectorStore;
  reranker?: RerankerModel;
  defaultTopK?: number;
  eventBus?: EventBus;
}

export function createVectorRetriever(config: VectorRetrieverConfig): Retriever {
  const defaultTopK = config.defaultTopK ?? 5;

  return {
    async retrieve(ctx: ExecutionContext, query: RetrievalQuery): Promise<RetrievalResult> {
      const topK = query.topK ?? defaultTopK;

      config.eventBus?.emit(
        createEvent(EventTypes.RetrieverQueryStart, { query: query.query, topK }, ctx),
      );

      // Embed the query
      const embeddingResponse = await config.embeddingModel.embed(ctx, { input: [query.query] });
      const queryEmbedding = embeddingResponse.embeddings[0]!;

      // Search vector store
      const fetchK = config.reranker ? topK * 3 : topK;
      const results = await config.vectorStore.search(ctx, {
        embedding: queryEmbedding,
        topK: fetchK,
        filter: query.filter,
        minScore: config.reranker ? undefined : query.minScore,
      });

      let finalResults = results;

      // Rerank if available
      if (config.reranker && results.length > 0) {
        const rerankResponse = await config.reranker.rerank(ctx, {
          query: query.query,
          documents: results.map((r) => r.content),
          topK,
        });
        finalResults = rerankResponse.results.map((r) => ({
          id: results[r.index]!.id,
          score: r.score,
          content: r.document,
          metadata: results[r.index]!.metadata,
        }));
      }

      // Apply min score filter after reranking
      if (query.minScore != null) {
        finalResults = finalResults.filter((r) => r.score >= query.minScore!);
      }

      const chunks: DocumentChunk[] = finalResults.map((r, i) => ({
        id: r.id,
        documentId: String(r.metadata['documentId'] ?? r.id),
        content: r.content,
        index: i,
        metadata: r.metadata,
      }));

      config.eventBus?.emit(
        createEvent(
          EventTypes.RetrieverQueryEnd,
          { query: query.query, resultsCount: chunks.length },
          ctx,
        ),
      );

      return { chunks, query: query.query };
    },
  };
}
