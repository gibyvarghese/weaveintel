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

/**
 * Optional capability: a `CacheStore` that can enumerate and bulk-delete keys by
 * prefix. Distributed (Redis) and tiered stores implement this so cache
 * invalidation can target a tenant/user/version prefix without a full clear.
 * Use {@link isScannableCacheStore} to narrow a `CacheStore` at runtime.
 */
export interface ScannableCacheStore extends CacheStore {
  /** List keys, optionally filtered to those starting with `prefix`. */
  keys(prefix?: string): Promise<string[]>;
  /** Delete every key starting with `prefix`. Returns the number deleted. */
  deleteByPrefix(prefix: string): Promise<number>;
}

/** Runtime type-guard for {@link ScannableCacheStore}. */
export function isScannableCacheStore(store: CacheStore): store is ScannableCacheStore {
  return (
    typeof (store as Partial<ScannableCacheStore>).keys === 'function' &&
    typeof (store as Partial<ScannableCacheStore>).deleteByPrefix === 'function'
  );
}

/**
 * Optional capability: a `CacheStore` that holds an external connection (e.g.
 * Redis) and should be closed on shutdown. In-memory stores omit this.
 */
export interface ClosableCacheStore extends CacheStore {
  close(): Promise<void>;
}

// ─── Cache Observability (Phase 3) ───────────────────────────

/** A point-in-time view of cache effectiveness for a dashboard. */
export interface CacheStatsSnapshot {
  /** Response-cache (exact-match) counters since `startedAt`. */
  responseCache: {
    hits: number;
    misses: number;
    sets: number;
    evictions: number;
    /** hits / (hits + misses), 0 when there were no lookups. */
    hitRate: number;
  };
  /** Provider-native prompt-cache token accounting since `startedAt`. */
  promptCache: {
    turns: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estCostSavedUsd: number;
  };
  /** ISO timestamp the counters were last reset (process start). */
  startedAt: string;
}

/**
 * A metrics sink for the cache layer. `withMetrics()` feeds the response-cache
 * counters automatically; the chat path feeds prompt-cache token savings.
 * Concrete impl: `createCacheMetrics()` in `@weaveintel/cache`.
 */
export interface CacheMetrics {
  onHit(): void;
  onMiss(): void;
  onSet(bytes?: number): void;
  onEvict(): void;
  recordPromptCache(delta: { readTokens: number; writeTokens: number; costSavedUsd?: number }): void;
  snapshot(): CacheStatsSnapshot;
  reset(): void;
}

// ─── Semantic Cache ──────────────────────────────────────────

/** Options for a scoped semantic lookup. */
export interface SemanticCacheFindOptions {
  /**
   * Partition key. Entries are only matched within the same scope, so a query
   * from tenant B never returns tenant A's cached answer. Omit for the global
   * partition.
   */
  scope?: string;
  /** Override the cache's default similarity threshold (0–1) for this lookup. */
  threshold?: number;
}

/** Options for storing a scoped semantic entry. */
export interface SemanticCacheStoreOptions {
  /** Partition key (tenant/user isolation). */
  scope?: string;
  /** Per-entry TTL in milliseconds. Falls back to the cache default; 0 = no expiry. */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SemanticCache {
  /** Return the most similar cached response within `scope` above the threshold, or null. */
  find(query: string, opts?: SemanticCacheFindOptions): Promise<SemanticCacheHit | null>;
  /** Store `response` for `query` (embedding computed lazily) in `scope`. */
  store(query: string, response: unknown, opts?: SemanticCacheStoreOptions): Promise<void>;
  /** Remove entries within `radius` cosine similarity of `query` (scoped). */
  invalidate(query: string, opts?: { scope?: string; radius?: number }): Promise<void>;
  /** Clear all entries, or only those in `scope`. */
  clear(scope?: string): Promise<void>;
  /** Number of live entries. */
  size(): Promise<number>;
}

export interface SemanticCacheHit {
  query: string;
  response: unknown;
  similarity: number;
  cachedAt: string;
  scope?: string;
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
  // ─── Phase 0 hardening ─────────────────────────────────────
  /** Approximate byte cap for the policy's L1 budget. `0`/undefined = off. */
  maxBytes?: number;
  /** Key-generation mode. `'sha256'` keeps raw prompts out of cache keys. */
  keyHashing?: 'none' | 'sha256';
  /** When true, the tenant id is folded into the cache key (cross-tenant isolation). Default true. */
  tenantIsolation?: boolean;
  /**
   * Determinism gate: only cache when the effective sampling temperature is
   * ≤ this value. Default `0` — caches deterministic (temperature 0) responses
   * only. Raise toward `1`/`2` to cache higher-temperature responses too.
   */
  temperatureGate?: number;
  /** Patterns checked against the *response* — a match skips caching (sensitive output). */
  outputBypassPatterns?: string[];
  // ─── Phase 7 — stampede protection & cost-aware eviction ──────
  /**
   * Stale-while-revalidate window (ms). When > 0, an entry older than `ttlMs`
   * but within `ttlMs + swrMs` is served immediately while a background refresh
   * runs, so callers never block on a refresh. `0`/undefined disables SWR.
   */
  swrMs?: number;
  /**
   * Negative-cache TTL (ms). When > 0, a miss/error is remembered for this long
   * to shield the backend from a retry storm — never poisoning the positive
   * cache beyond this short TTL. `0`/undefined disables negative caching.
   */
  negativeTtlMs?: number;
  /** Eviction strategy for this policy's L1 budget (G‑6). */
  evictionPolicy?: 'lru' | 'lfu' | 'fifo' | 'tinylfu' | 'gdsf';
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
  /**
   * The event type this rule fires on. Common built-ins: `event`, `ttl`,
   * `manual`, `source-change`. Phase 5 also uses domain event names
   * (`model_change`, `prompt_update`, `knowledge_update`, `session_end`,
   * `preference_change`). `*` matches every event.
   */
  trigger: string;
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
