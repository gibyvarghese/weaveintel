/**
 * @weaveintel/cache — Cache invalidation rule evaluation
 *
 * Evaluates CacheInvalidationRule triggers against events and
 * patterns to determine which cache entries should be evicted.
 */

import type { CacheInvalidationRule, CacheStore, SemanticCache } from '@weaveintel/core';
import { isScannableCacheStore } from '@weaveintel/core';

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
 * Apply matched invalidation rules against a CacheStore. Rule `config` supports:
 *   - `clearAll: true`      → wipe the whole store;
 *   - `prefix: string`      → `deleteByPrefix` (scoped, when the store is scannable);
 *   - `prefixFromPayload: 'k'` → `deleteByPrefix(String(event.payload[k]))`
 *                              (e.g. a per-user scope prefix on a `session_end` event);
 *   - `scope: string`       → `store.clear(scope)` (legacy);
 *   - `keyPattern: string`  → `store.delete(keyPattern)` (exact key).
 *
 * Pass the triggering `event` so payload-derived targets resolve.
 */
export async function applyInvalidation(
  store: CacheStore,
  rules: CacheInvalidationRule[],
  event?: InvalidationEvent,
): Promise<number> {
  const scannable = isScannableCacheStore(store) ? store : null;
  let cleared = 0;
  for (const rule of rules) {
    const cfg = (rule.config ?? {}) as Record<string, unknown>;

    if (cfg['clearAll'] === true) { await store.clear(); cleared++; continue; }

    let prefix = cfg['prefix'] as string | undefined;
    const fromPayload = cfg['prefixFromPayload'] as string | undefined;
    if (!prefix && fromPayload && event?.payload && typeof event.payload[fromPayload] === 'string') {
      prefix = event.payload[fromPayload] as string;
    }
    if (prefix) {
      if (scannable) cleared += await scannable.deleteByPrefix(prefix);
      else { await store.clear(prefix); cleared++; }
      continue;
    }

    const scope = cfg['scope'] as string | undefined;
    if (scope) {
      if (scannable) cleared += await scannable.deleteByPrefix(scope);
      else await store.clear(scope);
      cleared++;
    }
    const keyPattern = cfg['keyPattern'] as string | undefined;
    if (keyPattern) { await store.delete(keyPattern); cleared++; }
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
      await cache.invalidate(query, { scope: cfg['scope'] as string | undefined });
      cleared++;
    }
    const clearScope = cfg['clearScope'] as string | undefined;
    if (clearScope !== undefined) {
      await cache.clear(clearScope);
      cleared++;
    }
  }
  return cleared;
}

// ─── Runtime invalidator (Phase 5) ───────────────────────────

export interface CacheInvalidatorOptions {
  store: CacheStore;
  semanticCache?: SemanticCache;
  /** Resolve the active invalidation rules (e.g. from the DB). */
  getRules?: () => Promise<CacheInvalidationRule[]> | CacheInvalidationRule[];
}

/** A direct invalidation target for the admin "Invalidate Now" / GDPR erasure path. */
export interface InvalidateTarget {
  /** Wipe the entire response cache. */
  all?: boolean;
  /** `deleteByPrefix` a scope prefix (e.g. one user / tenant). */
  prefix?: string;
  /** Legacy `store.clear(scope)`. */
  scope?: string;
  /** Also clear the semantic cache (optionally only `semanticScope`). */
  semantic?: boolean;
  semanticScope?: string;
}

export interface CacheInvalidator {
  /** Evaluate the active rules against `event` and apply the matched invalidations. */
  handleEvent(event: InvalidationEvent): Promise<{ matched: number; cleared: number }>;
  /** Directly invalidate a target (manual / GDPR erasure). Returns entries removed (best-effort). */
  invalidate(target: InvalidateTarget): Promise<number>;
}

/**
 * Wire the (previously dead) invalidation engine into a live invalidator that an
 * app drives from real events (model-pricing change, prompt-template update,
 * knowledge/source update, session end) and from a manual admin action.
 */
export function createCacheInvalidator(opts: CacheInvalidatorOptions): CacheInvalidator {
  const scannable = isScannableCacheStore(opts.store) ? opts.store : null;
  return {
    async handleEvent(event) {
      const rules = (await opts.getRules?.()) ?? [];
      const matched = evaluateInvalidationRules(rules, event);
      let cleared = await applyInvalidation(opts.store, matched, event);
      if (opts.semanticCache) cleared += await applySemanticInvalidation(opts.semanticCache, matched);
      return { matched: matched.length, cleared };
    },
    async invalidate(target) {
      let cleared = 0;
      if (target.all) {
        await opts.store.clear();
        if (target.semantic) await opts.semanticCache?.clear();
        return 1;
      }
      if (target.prefix) {
        if (scannable) cleared += await scannable.deleteByPrefix(target.prefix);
        else await opts.store.clear(target.prefix);
      } else if (target.scope) {
        if (scannable) cleared += await scannable.deleteByPrefix(target.scope);
        else await opts.store.clear(target.scope);
      }
      if (target.semantic) await opts.semanticCache?.clear(target.semanticScope);
      return cleared;
    },
  };
}
