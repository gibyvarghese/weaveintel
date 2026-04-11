/**
 * @weaveintel/testing — Fake implementations for testing
 *
 * Deterministic fake providers, vector stores, and MCP servers
 * that let you write unit tests without real API calls.
 */

import type {
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
  TokenUsage,
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
  VectorStore,
  VectorStoreConfig,
  VectorRecord,
  VectorSearchOptions,
  VectorSearchResult,
  ExecutionContext,
  CapabilityId,
} from '@weaveintel/core';
import { weaveCapabilities, Capabilities } from '@weaveintel/core';

// ─── Fake model ──────────────────────────────────────────────

/** A single canned response — either a plain string or an object with content + toolCalls. */
export type FakeResponse = string | { content: string; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> };

export interface FakeModelOptions {
  /** Predefined responses. Cycled through in order. Accepts plain strings or rich objects. */
  responses?: FakeResponse[];
  /** Function to generate responses dynamically */
  responseFn?: (request: ModelRequest) => string;
  /** Simulated latency in ms */
  latencyMs?: number;
  /** Model info overrides */
  modelId?: string;
  provider?: string;
}

export function weaveFakeModel(opts: FakeModelOptions = {}): Model {
  const rawResponses = opts.responses ?? ['This is a fake response.'];
  let callIndex = 0;

  const info: ModelInfo = {
    provider: opts.provider ?? 'fake',
    modelId: opts.modelId ?? 'fake-model',
    capabilities: new Set([Capabilities.Chat]),
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  };

  const capSet = weaveCapabilities(Capabilities.Chat);

  function resolveResponse(request: ModelRequest): { content: string; toolCalls?: ModelResponse['toolCalls'] } {
    if (opts.responseFn) {
      return { content: opts.responseFn(request) };
    }
    const raw = rawResponses[callIndex % rawResponses.length]!;
    if (typeof raw === 'string') {
      return { content: raw };
    }
    return {
      content: raw.content,
      toolCalls: raw.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
    };
  }

  return {
    info,
    ...capSet,

    async generate(_ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      if (opts.latencyMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));
      }

      const { content, toolCalls } = resolveResponse(request);
      callIndex++;

      const usage: TokenUsage = {
        promptTokens: JSON.stringify(request.messages).length / 4,
        completionTokens: content.length / 4,
        totalTokens: (JSON.stringify(request.messages).length + content.length) / 4,
      };

      return {
        id: `fake_${callIndex}`,
        content,
        toolCalls,
        finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage,
        model: info.modelId,
      };
    },

    async *stream(_ctx: ExecutionContext, request: ModelRequest): ModelStream {
      if (opts.latencyMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.latencyMs));
      }

      const { content } = resolveResponse(request);
      callIndex++;

      // Stream character by character
      for (const char of content) {
        yield { type: 'text', text: char } as StreamChunk;
      }

      yield {
        type: 'usage',
        usage: {
          promptTokens: JSON.stringify(request.messages).length / 4,
          completionTokens: content.length / 4,
          totalTokens: (JSON.stringify(request.messages).length + content.length) / 4,
        },
      } as StreamChunk;

      yield { type: 'done' } as StreamChunk;
    },
  };
}

// ─── Fake embedding model ────────────────────────────────────

export function weaveFakeEmbedding(opts?: {
  dimensions?: number;
  modelId?: string;
}): EmbeddingModel {
  const dimensions = opts?.dimensions ?? 384;
  const info: ModelInfo = {
    provider: 'fake',
    modelId: opts?.modelId ?? 'fake-embedding',
    capabilities: new Set([Capabilities.Embedding]),
  };

  const capSet = weaveCapabilities(Capabilities.Embedding);

  return {
    info,
    ...capSet,

    async embed(_ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse> {
      // Generate deterministic embeddings based on content hash
      const embeddings = request.input.map((text) => {
        const embedding = new Array(dimensions);
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
          hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        for (let i = 0; i < dimensions; i++) {
          hash = ((hash << 5) - hash + i) | 0;
          embedding[i] = (hash & 0xffff) / 0xffff - 0.5;
        }
        // Normalize
        const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
        return embedding.map((v) => v / norm);
      });

      return {
        embeddings,
        model: info.modelId,
        usage: { totalTokens: request.input.reduce((s, t) => s + t.length / 4, 0) },
      };
    },
  };
}

// ─── Fake vector store ───────────────────────────────────────

export function weaveFakeVectorStore(opts?: { dimensions?: number }): VectorStore {
  const records = new Map<string, VectorRecord>();
  const dims = opts?.dimensions ?? 384;
  const capSet = weaveCapabilities(Capabilities.VectorSearch);

  function cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  return {
    config: { name: 'fake-vector-store', dimensions: dims, metric: 'cosine' as const },
    ...capSet,

    async upsert(_ctx: ExecutionContext, newRecords: VectorRecord[]): Promise<void> {
      for (const r of newRecords) {
        records.set(r.id, r);
      }
    },

    async search(_ctx: ExecutionContext, options: VectorSearchOptions): Promise<VectorSearchResult[]> {
      const results: VectorSearchResult[] = [];

      for (const record of records.values()) {
        const score = cosineSim(options.embedding as number[], record.embedding as number[]);
        if (options.minScore != null && score < options.minScore) continue;
        results.push({
          id: record.id,
          score,
          content: record.content,
          metadata: record.metadata ?? {},
        });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, options.topK ?? 10);
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      for (const id of ids) {
        records.delete(id);
      }
    },

  };
}

// ─── Fake MCP transport (for testing MCP client/server) ──────

import type { MCPTransport } from '@weaveintel/core';

export function weaveFakeTransport(): { client: MCPTransport; server: MCPTransport } {
  let clientHandler: ((msg: unknown) => void) | null = null;
  let serverHandler: ((msg: unknown) => void) | null = null;

  const client: MCPTransport = {
    type: 'stdio',
    async send(message: unknown): Promise<void> {
      // Messages from client go to server
      queueMicrotask(() => serverHandler?.(message));
    },
    onMessage(handler: (msg: unknown) => void): void {
      clientHandler = handler;
    },
    async close(): Promise<void> {
      clientHandler = null;
    },
  };

  const server: MCPTransport = {
    type: 'stdio',
    async send(message: unknown): Promise<void> {
      // Messages from server go to client
      queueMicrotask(() => clientHandler?.(message));
    },
    onMessage(handler: (msg: unknown) => void): void {
      serverHandler = handler;
    },
    async close(): Promise<void> {
      serverHandler = null;
    },
  };

  return { client, server };
}
