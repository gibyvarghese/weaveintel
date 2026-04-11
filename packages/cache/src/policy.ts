/**
 * @weaveintel/cache — Cache policy evaluation
 *
 * Determines whether a request should be cached, served from cache,
 * or bypassed. Policies support TTL, scope isolation, bypass patterns,
 * and event-driven invalidation.
 */

import type { CachePolicy, CacheScopeType } from '@weaveintel/core';

export interface CachePolicyOptions {
  id: string;
  name: string;
  enabled?: boolean;
  scope?: CacheScopeType;
  ttlMs?: number;
  maxEntries?: number;
  bypassPatterns?: string[];
  invalidateOnEvents?: string[];
}

/**
 * Create a CachePolicy with sensible defaults.
 */
export function createCachePolicy(opts: CachePolicyOptions): CachePolicy {
  return {
    id: opts.id,
    name: opts.name,
    enabled: opts.enabled ?? true,
    scope: opts.scope ?? 'global',
    ttlMs: opts.ttlMs ?? 300_000, // 5 minutes default
    maxEntries: opts.maxEntries,
    bypassPatterns: opts.bypassPatterns,
    invalidateOnEvents: opts.invalidateOnEvents,
  };
}

/**
 * Evaluate whether a cache request should bypass based on policy patterns.
 */
export function shouldBypass(policy: CachePolicy, input: string): boolean {
  if (!policy.enabled) return true;
  if (!policy.bypassPatterns || policy.bypassPatterns.length === 0) return false;
  return policy.bypassPatterns.some((pat) => {
    try {
      return new RegExp(pat, 'i').test(input);
    } catch {
      return input.toLowerCase().includes(pat.toLowerCase());
    }
  });
}

/**
 * Evaluate multiple policies and return the most specific applicable one.
 * Priority: user > session > tenant > agent > global.
 */
export function resolvePolicy(
  policies: CachePolicy[],
  context: { scope?: CacheScopeType },
): CachePolicy | null {
  const enabled = policies.filter((p) => p.enabled);
  if (enabled.length === 0) return null;

  const priority: Record<CacheScopeType, number> = {
    user: 5,
    session: 4,
    tenant: 3,
    agent: 2,
    global: 1,
  };

  // If requested scope, prefer that; otherwise pick the highest priority
  if (context.scope) {
    const match = enabled.find((p) => p.scope === context.scope);
    if (match) return match;
  }

  return enabled.sort((a, b) => (priority[b.scope] ?? 0) - (priority[a.scope] ?? 0))[0] ?? null;
}
