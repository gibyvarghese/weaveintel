/**
 * @weaveintel/core — Caching contracts
 */

// ─── Cache Store ─────────────────────────────────────────────

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(scope?: string): Promise<void>;
  size(): Promise<number>;
}

// ─── Semantic Cache ──────────────────────────────────────────

export interface SemanticCache {
  find(query: string, threshold?: number): Promise<SemanticCacheHit | null>;
  store(query: string, response: unknown, metadata?: Record<string, unknown>): Promise<void>;
  invalidate(query: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SemanticCacheHit {
  query: string;
  response: unknown;
  similarity: number;
  cachedAt: string;
  metadata?: Record<string, unknown>;
}

// ─── Cache Policy ────────────────────────────────────────────

export type CacheScopeType = 'global' | 'tenant' | 'user' | 'session' | 'agent';

export interface CachePolicy {
  id: string;
  name: string;
  enabled: boolean;
  scope: CacheScopeType;
  ttlMs: number;
  maxEntries?: number;
  bypassPatterns?: string[];
  invalidateOnEvents?: string[];
  createdAt?: string;
}

// ─── Key Builder ─────────────────────────────────────────────

export interface CacheKeyBuilder {
  build(parts: Record<string, string | number | boolean>): string;
  parse(key: string): Record<string, string>;
}

// ─── Invalidation ────────────────────────────────────────────

export interface CacheInvalidationRule {
  id: string;
  name: string;
  trigger: 'event' | 'ttl' | 'manual' | 'source-change';
  pattern?: string;
  config?: Record<string, unknown>;
  enabled: boolean;
}

// ─── Cache Scope ─────────────────────────────────────────────

export interface CacheScope {
  type: CacheScopeType;
  id: string;
  policy?: CachePolicy;
}
