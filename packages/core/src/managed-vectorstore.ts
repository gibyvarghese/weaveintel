/**
 * @weaveintel/core — Managed vector store contracts
 *
 * Why: Cloud providers offer managed vector stores with file ingestion,
 * chunking, and search — beyond the basic VectorStore contract which deals
 * with raw embeddings. This contract enables provider-managed vector stores
 * with file-level operations, automatic chunking, and hosted search.
 */

import type { ExecutionContext } from './context.js';

// ─── Managed vector store types ──────────────────────────────

export interface ManagedVectorStoreConfig {
  readonly name: string;
  readonly expiresAfterDays?: number;
  readonly chunkingStrategy?: ManagedChunkingStrategy;
  readonly metadata?: Record<string, unknown>;
}

export type ManagedChunkingStrategy =
  | { readonly type: 'auto' }
  | {
      readonly type: 'static';
      readonly maxChunkSizeTokens: number;
      readonly chunkOverlapTokens: number;
    };

export interface ManagedVectorStoreInfo {
  readonly id: string;
  readonly name: string;
  readonly status: 'completed' | 'in_progress' | 'expired';
  readonly fileCounts: {
    readonly total: number;
    readonly completed: number;
    readonly inProgress: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ManagedVectorStoreFile {
  readonly id: string;
  readonly vectorStoreId: string;
  readonly status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  readonly chunkingStrategy?: ManagedChunkingStrategy;
  readonly createdAt: number;
}

export interface ManagedVectorSearchOptions {
  readonly query: string;
  readonly maxResults?: number;
  readonly filters?: Record<string, unknown>;
  readonly rankingOptions?: {
    readonly ranker?: string;
    readonly scoreThreshold?: number;
  };
}

export interface ManagedVectorSearchResult {
  readonly fileId: string;
  readonly filename: string;
  readonly score: number;
  readonly content: string;
  readonly attributes?: Record<string, unknown>;
}

export interface ManagedFileBatch {
  readonly id: string;
  readonly vectorStoreId: string;
  readonly status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  readonly fileCounts: {
    readonly total: number;
    readonly completed: number;
    readonly inProgress: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly createdAt: number;
}

// ─── Managed vector store interface ──────────────────────────

export interface ManagedVectorStore {
  create(ctx: ExecutionContext, config: ManagedVectorStoreConfig): Promise<ManagedVectorStoreInfo>;
  list(ctx: ExecutionContext): Promise<ManagedVectorStoreInfo[]>;
  retrieve(ctx: ExecutionContext, storeId: string): Promise<ManagedVectorStoreInfo>;
  update(ctx: ExecutionContext, storeId: string, config: Partial<ManagedVectorStoreConfig>): Promise<ManagedVectorStoreInfo>;
  delete(ctx: ExecutionContext, storeId: string): Promise<void>;
  search(ctx: ExecutionContext, storeId: string, options: ManagedVectorSearchOptions): Promise<ManagedVectorSearchResult[]>;

  // File operations
  addFile(ctx: ExecutionContext, storeId: string, fileId: string, chunkingStrategy?: ManagedChunkingStrategy): Promise<ManagedVectorStoreFile>;
  listFiles(ctx: ExecutionContext, storeId: string): Promise<ManagedVectorStoreFile[]>;
  retrieveFile(ctx: ExecutionContext, storeId: string, fileId: string): Promise<ManagedVectorStoreFile>;
  removeFile(ctx: ExecutionContext, storeId: string, fileId: string): Promise<void>;

  // Batch operations
  createFileBatch(ctx: ExecutionContext, storeId: string, fileIds: string[], chunkingStrategy?: ManagedChunkingStrategy): Promise<ManagedFileBatch>;
  retrieveFileBatch(ctx: ExecutionContext, storeId: string, batchId: string): Promise<ManagedFileBatch>;
}
