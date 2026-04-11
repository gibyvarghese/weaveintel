/**
 * @weaveintel/cache — Semantic cache
 *
 * Embedding-based similarity cache. When a query's embedding is close enough
 * to a cached entry (above the similarity threshold), the cached response is
 * returned instead of calling the model again.
 */

import type { SemanticCache, SemanticCacheHit } from '@weaveintel/core';

interface SemanticEntry {
  query: string;
  embedding: readonly number[];
  response: unknown;
  cachedAt: string;
  metadata?: Record<string, unknown>;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface SemanticCacheOptions {
  /** Default similarity threshold (0–1). Default 0.92 */
  defaultThreshold?: number;
  /** Maximum entries. Oldest evicted when exceeded. */
  maxEntries?: number;
  /** Embedding function — converts text to vector */
  embed: (text: string) => Promise<readonly number[]>;
}

/**
 * Creates an embedding-based semantic cache.
 */
export function weaveSemanticCache(opts: SemanticCacheOptions): SemanticCache {
  const entries: SemanticEntry[] = [];
  const defaultThreshold = opts.defaultThreshold ?? 0.92;
  const maxEntries = opts.maxEntries ?? 1000;

  return {
    async find(query: string, threshold?: number): Promise<SemanticCacheHit | null> {
      if (entries.length === 0) return null;
      const queryEmbedding = await opts.embed(query);
      const t = threshold ?? defaultThreshold;

      let bestSimilarity = -1;
      let bestEntry: SemanticEntry | null = null;

      for (const entry of entries) {
        const sim = cosineSimilarity(queryEmbedding, entry.embedding);
        if (sim >= t && sim > bestSimilarity) {
          bestSimilarity = sim;
          bestEntry = entry;
        }
      }

      if (!bestEntry) return null;

      return {
        query: bestEntry.query,
        response: bestEntry.response,
        similarity: bestSimilarity,
        cachedAt: bestEntry.cachedAt,
        metadata: bestEntry.metadata,
      };
    },

    async store(query: string, response: unknown, metadata?: Record<string, unknown>): Promise<void> {
      const embedding = await opts.embed(query);

      // Evict oldest if at capacity
      while (entries.length >= maxEntries) {
        entries.shift();
      }

      entries.push({
        query,
        embedding,
        response,
        cachedAt: new Date().toISOString(),
        metadata,
      });
    },

    async invalidate(query: string): Promise<void> {
      const embedding = await opts.embed(query);
      // Remove entries with high similarity to the query
      for (let i = entries.length - 1; i >= 0; i--) {
        if (cosineSimilarity(embedding, entries[i]!.embedding) > 0.95) {
          entries.splice(i, 1);
        }
      }
    },

    async clear(): Promise<void> {
      entries.length = 0;
    },
  };
}
