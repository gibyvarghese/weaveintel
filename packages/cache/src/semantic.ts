/**
 * @weaveintel/cache — Semantic cache (Phase 4, redesigned).
 *
 * Embedding-similarity cache: when a query's embedding is close enough to a
 * cached entry (cosine ≥ threshold) the cached response is returned instead of
 * calling the model again. Hardened over the original:
 *
 *   - Scoped partitioning (`scope`) — a query from tenant B never matches
 *     tenant A's entries (cross-tenant/user isolation).
 *   - Per-entry TTL + lazy expiry.
 *   - LRU eviction (not FIFO) once `maxEntries` is exceeded.
 *   - An embedding cache so identical query text is never re-embedded.
 *   - Configurable invalidation radius.
 *   - A pluggable `VectorIndex` backend (in-memory by default; pgvector/Redis
 *     adapters can implement the same interface for native ANN search).
 */

import type {
  SemanticCache,
  SemanticCacheHit,
  SemanticCacheFindOptions,
  SemanticCacheStoreOptions,
} from '@weaveintel/core';

// ─── Vector index abstraction (pluggable backend) ────────────

export interface SemanticEntry {
  id: string;
  query: string;
  embedding: readonly number[];
  response: unknown;
  scope?: string;
  cachedAt: string;
  /** Epoch ms expiry, or null for no expiry. */
  expiresAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface VectorIndex {
  add(entry: SemanticEntry): void;
  /** Best live match in `scope` whose cosine ≥ `threshold`, or null. Bumps LRU. */
  search(embedding: readonly number[], opts: { scope?: string; threshold: number; now: number }): { entry: SemanticEntry; similarity: number } | null;
  /** Remove every entry matching the predicate; returns the count removed. */
  remove(pred: (e: SemanticEntry) => boolean): number;
  /** Clear all entries, or only those in `scope`. */
  clear(scope?: string): void;
  /** Live (non-expired) entry count. */
  size(now: number): number;
  /** Evict least-recently-used entries until size ≤ `maxEntries`. */
  prune(maxEntries: number, onEvict?: (e: SemanticEntry) => void): number;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** In-memory LRU vector index. Insertion-ordered Map; matched entries move to the end. */
export function createInMemoryVectorIndex(): VectorIndex {
  const data = new Map<string, SemanticEntry>();
  const isExpired = (e: SemanticEntry, now: number) => e.expiresAt !== null && now > e.expiresAt;

  return {
    add(entry) {
      data.delete(entry.id);
      data.set(entry.id, entry);
    },
    search(embedding, { scope, threshold, now }) {
      let best: { entry: SemanticEntry; similarity: number } | null = null;
      for (const [id, e] of data) {
        if (isExpired(e, now)) { data.delete(id); continue; }
        if ((e.scope ?? '') !== (scope ?? '')) continue;
        const sim = cosineSimilarity(embedding, e.embedding);
        if (sim >= threshold && (best === null || sim > best.similarity)) {
          best = { entry: e, similarity: sim };
        }
      }
      if (best) {
        // LRU touch — move the matched entry to the most-recent position.
        data.delete(best.entry.id);
        data.set(best.entry.id, best.entry);
      }
      return best;
    },
    remove(pred) {
      let n = 0;
      for (const [id, e] of data) if (pred(e)) { data.delete(id); n++; }
      return n;
    },
    clear(scope) {
      if (scope === undefined) { data.clear(); return; }
      for (const [id, e] of data) if ((e.scope ?? '') === scope) data.delete(id);
    },
    size(now) {
      let n = 0;
      for (const [id, e] of data) {
        if (isExpired(e, now)) { data.delete(id); continue; }
        n++;
      }
      return n;
    },
    prune(maxEntries, onEvict) {
      let evicted = 0;
      while (data.size > maxEntries) {
        const oldest = data.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const e = data.get(oldest)!;
        data.delete(oldest);
        onEvict?.(e);
        evicted++;
      }
      return evicted;
    },
  };
}

// ─── Embedding cache (avoid re-embedding identical text) ─────

function createEmbeddingCache(
  embed: (text: string) => Promise<readonly number[]>,
  maxEntries: number,
): (text: string) => Promise<readonly number[]> {
  const cache = new Map<string, readonly number[]>();
  return async (text: string) => {
    const cached = cache.get(text);
    if (cached) {
      cache.delete(text); cache.set(text, cached); // LRU touch
      return cached;
    }
    const embedding = await embed(text);
    cache.set(text, embedding);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return embedding;
  };
}

// ─── Semantic cache ──────────────────────────────────────────

export interface SemanticCacheOptions {
  /** Embedding function — converts text to a vector. */
  embed: (text: string) => Promise<readonly number[]>;
  /** Default similarity threshold (0–1). Default 0.92. */
  defaultThreshold?: number;
  /** Maximum entries before LRU eviction. Default 1000. */
  maxEntries?: number;
  /** Default per-entry TTL in ms. 0 = no expiry. Default 0. */
  ttlMs?: number;
  /** Cosine radius for `invalidate`. Default 0.95. */
  invalidationRadius?: number;
  /** Embedding LRU cache size (identical text → no re-embed). Default 500. */
  embeddingCacheSize?: number;
  /** Pluggable vector backend. Default in-memory. */
  index?: VectorIndex;
  /** Observability hooks. */
  onHit?: (similarity: number) => void;
  onMiss?: () => void;
}

let _idCounter = 0;

export function weaveSemanticCache(opts: SemanticCacheOptions): SemanticCache {
  const defaultThreshold = opts.defaultThreshold ?? 0.92;
  const maxEntries = opts.maxEntries ?? 1000;
  const defaultTtlMs = opts.ttlMs ?? 0;
  const invalidationRadius = opts.invalidationRadius ?? 0.95;
  const index = opts.index ?? createInMemoryVectorIndex();
  const embed = createEmbeddingCache(opts.embed, opts.embeddingCacheSize ?? 500);

  return {
    async find(query: string, findOpts?: SemanticCacheFindOptions): Promise<SemanticCacheHit | null> {
      const now = Date.now();
      if (index.size(now) === 0) { opts.onMiss?.(); return null; }
      const embedding = await embed(query);
      const threshold = findOpts?.threshold ?? defaultThreshold;
      const match = index.search(embedding, { scope: findOpts?.scope, threshold, now });
      if (!match) { opts.onMiss?.(); return null; }
      opts.onHit?.(match.similarity);
      return {
        query: match.entry.query,
        response: match.entry.response,
        similarity: match.similarity,
        cachedAt: match.entry.cachedAt,
        scope: match.entry.scope,
        metadata: match.entry.metadata,
      };
    },

    async store(query: string, response: unknown, storeOpts?: SemanticCacheStoreOptions): Promise<void> {
      const embedding = await embed(query);
      const ttl = storeOpts?.ttlMs ?? defaultTtlMs;
      const entry: SemanticEntry = {
        id: `se_${Date.now()}_${_idCounter++}`,
        query,
        embedding,
        response,
        scope: storeOpts?.scope,
        cachedAt: new Date().toISOString(),
        expiresAt: ttl > 0 ? Date.now() + ttl : null,
        metadata: storeOpts?.metadata,
      };
      index.add(entry);
      index.prune(maxEntries);
    },

    async invalidate(query: string, invOpts?: { scope?: string; radius?: number }): Promise<void> {
      const embedding = await embed(query);
      const radius = invOpts?.radius ?? invalidationRadius;
      const scope = invOpts?.scope;
      index.remove((e) =>
        (scope === undefined || (e.scope ?? '') === scope) &&
        cosineSimilarity(embedding, e.embedding) >= radius,
      );
    },

    async clear(scope?: string): Promise<void> {
      index.clear(scope);
    },

    async size(): Promise<number> {
      return index.size(Date.now());
    },
  };
}
