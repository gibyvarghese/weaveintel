/**
 * @weaveintel/provider-openai — OpenAI Vector Stores adapter
 *
 * Implements the generic ManagedVectorStore contract using OpenAI's
 * Vector Stores API. Supports CRUD for vector stores, file management,
 * file batches, and semantic search.
 */

import type {
  ExecutionContext,
  ManagedVectorStore,
  ManagedVectorStoreConfig,
  ManagedVectorStoreInfo,
  ManagedVectorStoreFile,
  ManagedVectorSearchOptions,
  ManagedVectorSearchResult,
  ManagedChunkingStrategy,
  ManagedFileBatch,
} from '@weaveintel/core';
import { deadlineSignal, normalizeError } from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  openaiRequest,
  openaiGetRequest,
  openaiDeleteRequest,
} from './shared.js';

// ─── Mappers ─────────────────────────────────────────────────

function toChunkingPayload(strategy?: ManagedChunkingStrategy): unknown | undefined {
  if (!strategy) return undefined;
  if (strategy.type === 'auto') return { type: 'auto' };
  return {
    type: 'static',
    static: {
      max_chunk_size_tokens: strategy.maxChunkSizeTokens,
      chunk_overlap_tokens: strategy.chunkOverlapTokens,
    },
  };
}

function parseStoreInfo(raw: Record<string, unknown>): ManagedVectorStoreInfo {
  const fc = raw['file_counts'] as Record<string, number> | undefined;
  return {
    id: String(raw['id']),
    name: String(raw['name'] ?? ''),
    status: String(raw['status'] ?? 'completed') as 'completed',
    fileCounts: {
      total: fc?.['total'] ?? 0,
      completed: fc?.['completed'] ?? 0,
      inProgress: fc?.['in_progress'] ?? 0,
      failed: fc?.['failed'] ?? 0,
      cancelled: fc?.['cancelled'] ?? 0,
    },
    createdAt: Number(raw['created_at'] ?? 0),
    expiresAt: raw['expires_at'] as number | undefined,
    metadata: raw['metadata'] as Record<string, unknown> | undefined,
  };
}

function parseStoreFile(raw: Record<string, unknown>): ManagedVectorStoreFile {
  return {
    id: String(raw['id']),
    vectorStoreId: String(raw['vector_store_id']),
    status: String(raw['status'] ?? 'completed') as 'completed',
    createdAt: Number(raw['created_at'] ?? 0),
  };
}

function parseFileBatch(raw: Record<string, unknown>): ManagedFileBatch {
  const fc = raw['file_counts'] as Record<string, number> | undefined;
  return {
    id: String(raw['id']),
    vectorStoreId: String(raw['vector_store_id']),
    status: String(raw['status'] ?? 'completed') as 'completed',
    fileCounts: {
      total: fc?.['total'] ?? 0,
      completed: fc?.['completed'] ?? 0,
      inProgress: fc?.['in_progress'] ?? 0,
      failed: fc?.['failed'] ?? 0,
      cancelled: fc?.['cancelled'] ?? 0,
    },
    createdAt: Number(raw['created_at'] ?? 0),
  };
}

// ─── OpenAI Vector Stores adapter ────────────────────────────

export function weaveOpenAIVectorStoreClient(
  providerOptions?: OpenAIProviderOptions,
): ManagedVectorStore {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);

  return {
    async create(ctx: ExecutionContext, config: ManagedVectorStoreConfig): Promise<ManagedVectorStoreInfo> {
      const body: Record<string, unknown> = { name: config.name };
      if (config.expiresAfterDays) body['expires_after'] = { anchor: 'last_active_at', days: config.expiresAfterDays };
      if (config.chunkingStrategy) body['chunking_strategy'] = toChunkingPayload(config.chunkingStrategy);
      if (config.metadata) body['metadata'] = config.metadata;

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/vector_stores', body, headers, signal)) as Record<string, unknown>;
        return parseStoreInfo(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async list(ctx: ExecutionContext): Promise<ManagedVectorStoreInfo[]> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, '/vector_stores', headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => parseStoreInfo(d as Record<string, unknown>));
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async retrieve(ctx: ExecutionContext, storeId: string): Promise<ManagedVectorStoreInfo> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}`, headers, signal)) as Record<string, unknown>;
        return parseStoreInfo(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async update(ctx: ExecutionContext, storeId: string, config: Partial<ManagedVectorStoreConfig>): Promise<ManagedVectorStoreInfo> {
      const body: Record<string, unknown> = {};
      if (config.name) body['name'] = config.name;
      if (config.expiresAfterDays) body['expires_after'] = { anchor: 'last_active_at', days: config.expiresAfterDays };
      if (config.metadata) body['metadata'] = config.metadata;

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}`, body, headers, signal)) as Record<string, unknown>;
        return parseStoreInfo(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async delete(ctx: ExecutionContext, storeId: string): Promise<void> {
      const signal = deadlineSignal(ctx);
      try {
        await openaiDeleteRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}`, headers, signal);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async search(ctx: ExecutionContext, storeId: string, options: ManagedVectorSearchOptions): Promise<ManagedVectorSearchResult[]> {
      const body: Record<string, unknown> = { query: options.query };
      if (options.maxResults) body['max_num_results'] = options.maxResults;
      if (options.filters) body['filters'] = options.filters;
      if (options.rankingOptions) body['ranking_options'] = { ranker: options.rankingOptions.ranker, score_threshold: options.rankingOptions.scoreThreshold };

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/search`, body, headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => {
          const r = d as Record<string, unknown>;
          return {
            fileId: String(r['file_id']),
            filename: String(r['filename'] ?? ''),
            score: Number(r['score'] ?? 0),
            content: ((r['content'] as unknown[]) ?? []).map((c) => String((c as Record<string, unknown>)['text'] ?? '')).join('\n'),
            attributes: r['attributes'] as Record<string, unknown> | undefined,
          };
        });
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async addFile(ctx: ExecutionContext, storeId: string, fileId: string, chunkingStrategy?: ManagedChunkingStrategy): Promise<ManagedVectorStoreFile> {
      const body: Record<string, unknown> = { file_id: fileId };
      if (chunkingStrategy) body['chunking_strategy'] = toChunkingPayload(chunkingStrategy);

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/files`, body, headers, signal)) as Record<string, unknown>;
        return parseStoreFile(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async listFiles(ctx: ExecutionContext, storeId: string): Promise<ManagedVectorStoreFile[]> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/files`, headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => parseStoreFile(d as Record<string, unknown>));
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async retrieveFile(ctx: ExecutionContext, storeId: string, fileId: string): Promise<ManagedVectorStoreFile> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`, headers, signal)) as Record<string, unknown>;
        return parseStoreFile(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async removeFile(ctx: ExecutionContext, storeId: string, fileId: string): Promise<void> {
      const signal = deadlineSignal(ctx);
      try {
        await openaiDeleteRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`, headers, signal);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async createFileBatch(ctx: ExecutionContext, storeId: string, fileIds: string[], chunkingStrategy?: ManagedChunkingStrategy): Promise<ManagedFileBatch> {
      const body: Record<string, unknown> = { file_ids: fileIds };
      if (chunkingStrategy) body['chunking_strategy'] = toChunkingPayload(chunkingStrategy);

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/file_batches`, body, headers, signal)) as Record<string, unknown>;
        return parseFileBatch(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async retrieveFileBatch(ctx: ExecutionContext, storeId: string, batchId: string): Promise<ManagedFileBatch> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/vector_stores/${encodeURIComponent(storeId)}/file_batches/${encodeURIComponent(batchId)}`, headers, signal)) as Record<string, unknown>;
        return parseFileBatch(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIVectorStore(options?: OpenAIProviderOptions): ManagedVectorStore {
  return weaveOpenAIVectorStoreClient(options);
}
