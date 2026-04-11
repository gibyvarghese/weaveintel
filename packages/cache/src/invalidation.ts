/**
 * @weaveintel/cache — Cache invalidation rule evaluation
 *
 * Evaluates CacheInvalidationRule triggers against events and
 * patterns to determine which cache entries should be evicted.
 */

import type { CacheInvalidationRule, CacheStore, SemanticCache } from '@weaveintel/core';

/** An event payload that may trigger invalidation. */
export interface InvalidationEvent {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Evaluate a set of invalidation rules against an incoming event.
 * Returns the IDs of rules that matched (i.e. should trigger eviction).
 */
export function evaluateInvalidationRules(
  rules: CacheInvalidationRule[],
  event: InvalidationEvent,
): CacheInvalidationRule[] {
  const matched: CacheInvalidationRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.trigger !== event.type && (rule.trigger as string) !== '*') continue;

    if (rule.pattern) {
      const re = new RegExp(rule.pattern, 'i');
      const target = event.payload ? JSON.stringify(event.payload) : '';
      if (!re.test(target)) continue;
    }

    matched.push(rule);
  }
  return matched;
}

/**
 * Apply matched invalidation rules against a CacheStore.
 * Rules with config.scope clear that scope; rules with config.keyPattern
 * delete matching keys from the store.
 */
export async function applyInvalidation(
  store: CacheStore,
  rules: CacheInvalidationRule[],
): Promise<number> {
  let cleared = 0;
  for (const rule of rules) {
    const cfg = (rule.config ?? {}) as Record<string, unknown>;
    const scope = cfg['scope'] as string | undefined;
    if (scope) {
      await store.clear(scope);
      cleared++;
    }
    const keyPattern = cfg['keyPattern'] as string | undefined;
    if (keyPattern) {
      // Attempt to delete specified key pattern
      await store.delete(keyPattern);
      cleared++;
    }
  }
  return cleared;
}

/**
 * Apply matched invalidation rules against a SemanticCache.
 * Rules with config.query invalidate by semantic similarity;
 * rules with config.clearAll clear the entire cache.
 */
export async function applySemanticInvalidation(
  cache: SemanticCache,
  rules: CacheInvalidationRule[],
): Promise<number> {
  let cleared = 0;
  for (const rule of rules) {
    const cfg = (rule.config ?? {}) as Record<string, unknown>;
    const clearAll = cfg['clearAll'] as boolean | undefined;
    if (clearAll) {
      await cache.clear();
      cleared++;
      continue;
    }
    const query = cfg['query'] as string | undefined;
    if (query) {
      await cache.invalidate(query);
      cleared++;
    }
  }
  return cleared;
}
