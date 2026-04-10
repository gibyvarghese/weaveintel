/**
 * @weaveintel/core — Vector store & retrieval contracts
 *
 * Why: Retrieval is independent of agents — it works standalone. The contracts
 * separate storage (VectorStore) from retrieval strategy (Retriever) so you
 * can compose different strategies without changing storage backends.
 */

import type { HasCapabilities } from './capabilities.js';
import type { ExecutionContext } from './context.js';
import type { DocumentChunk } from './documents.js';

// ─── Vector store ────────────────────────────────────────────

export interface VectorStoreConfig {
  readonly name: string;
  readonly dimensions: number;
  readonly metric?: 'cosine' | 'euclidean' | 'dotProduct';
  readonly namespace?: string;
}

export interface VectorRecord {
  readonly id: string;
  readonly embedding: readonly number[];
  readonly content: string;
  readonly metadata: Record<string, unknown>;
}

export interface VectorSearchOptions {
  readonly embedding: readonly number[];
  readonly topK: number;
  readonly filter?: Record<string, unknown>;
  readonly minScore?: number;
  readonly includeMetadata?: boolean;
  readonly namespace?: string;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
}

export interface VectorStore extends HasCapabilities {
  readonly config: VectorStoreConfig;

  upsert(ctx: ExecutionContext, records: VectorRecord[]): Promise<void>;
  search(ctx: ExecutionContext, options: VectorSearchOptions): Promise<VectorSearchResult[]>;
  delete(ctx: ExecutionContext, ids: string[]): Promise<void>;
  count?(ctx: ExecutionContext): Promise<number>;
}

// ─── Retriever ───────────────────────────────────────────────

export interface RetrievalQuery {
  readonly query: string;
  readonly topK?: number;
  readonly filter?: Record<string, unknown>;
  readonly minScore?: number;
  readonly rerank?: boolean;
}

export interface RetrievalResult {
  readonly chunks: readonly DocumentChunk[];
  readonly query: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Retriever {
  retrieve(ctx: ExecutionContext, query: RetrievalQuery): Promise<RetrievalResult>;
}

// ─── Chunker ─────────────────────────────────────────────────

export type ChunkingStrategy =
  | 'fixed_size'
  | 'token_aware'
  | 'semantic_boundary'
  | 'heading_aware'
  | 'code_aware'
  | 'table_aware'
  | 'adaptive';

export interface ChunkerConfig {
  readonly strategy: ChunkingStrategy;
  readonly chunkSize?: number;
  readonly chunkOverlap?: number;
  readonly maxChunks?: number;
}

export interface Chunker {
  chunk(content: string, config?: Partial<ChunkerConfig>): DocumentChunk[];
}

// ─── Indexer ─────────────────────────────────────────────────

export interface IndexerConfig {
  readonly batchSize?: number;
  readonly parallelism?: number;
}

export interface Indexer {
  index(ctx: ExecutionContext, chunks: DocumentChunk[]): Promise<void>;
}
