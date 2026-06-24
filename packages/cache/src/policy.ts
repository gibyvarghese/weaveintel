/**
 * @weaveintel/cache — Cache policy evaluation
 *
 * Determines whether a request should be cached, served from cache,
 * or bypassed. Policies support TTL, scope isolation, bypass patterns,
 * determinism gating, and event-driven invalidation.
 */

import type { CachePolicy, CacheScopeType } from '@weaveintel/core';

export interface CachePolicyOptions {
  id: string;
  name: string;
  enabled?: boolean;
  scope?: CacheScopeType;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  bypassPatterns?: string[];
  outputBypassPatterns?: string[];
  invalidateOnEvents?: string[];
  keyHashing?: 'none' | 'sha256';
  tenantIsolation?: boolean;
  temperatureGate?: number;
}

/**
 * Create a CachePolicy with sensible, secure-by-default values.
 */
export function createCachePolicy(opts: CachePolicyOptions): CachePolicy {
  return {
    id: opts.id,
    name: opts.name,
    enabled: opts.enabled ?? true,
    scope: opts.scope ?? 'global',
    ttlMs: opts.ttlMs ?? 300_000, // 5 minutes default
    maxEntries: opts.maxEntries,
    maxBytes: opts.maxBytes,
    bypassPatterns: opts.bypassPatterns,
    outputBypassPatterns: opts.outputBypassPatterns,
    invalidateOnEvents: opts.invalidateOnEvents,
    keyHashing: opts.keyHashing ?? 'sha256',
    tenantIsolation: opts.tenantIsolation ?? true,
    temperatureGate: opts.temperatureGate ?? 0,
  };
}

/** Max admin-supplied pattern length — a cheap ReDoS / abuse guard. */
const MAX_PATTERN_LENGTH = 512;

/**
 * Test a single (admin-supplied) pattern against text. Tries it as a
 * case-insensitive regex; on an invalid or oversized pattern it falls back to a
 * literal substring match so a bad pattern can never throw at request time.
 */
function matchesPattern(pattern: string, input: string): boolean {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
    return pattern ? input.toLowerCase().includes(pattern.slice(0, MAX_PATTERN_LENGTH).toLowerCase()) : false;
  }
  try {
    return new RegExp(pattern, 'i').test(input);
  } catch {
    return input.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Evaluate whether a cache request should bypass based on the policy's
 * *input* bypass patterns (matched against the prompt).
 */
export function shouldBypass(policy: CachePolicy, input: string): boolean {
  if (!policy.enabled) return true;
  if (!policy.bypassPatterns || policy.bypassPatterns.length === 0) return false;
  return policy.bypassPatterns.some((pat) => matchesPattern(pat, input));
}

/**
 * Evaluate whether a *response* should bypass caching. Checks both the input
 * bypass patterns and any `outputBypassPatterns` against the generated content,
 * so a benign prompt that yields sensitive output (e.g. a leaked secret) is not
 * written to the cache.
 */
export function shouldBypassResponse(policy: CachePolicy, output: string): boolean {
  if (!policy.enabled) return true;
  const patterns = [...(policy.bypassPatterns ?? []), ...(policy.outputBypassPatterns ?? [])];
  if (patterns.length === 0) return false;
  return patterns.some((pat) => matchesPattern(pat, output));
}

/**
 * Determinism gate: should a response generated at `temperature` be cached
 * under this policy? Caches only when the effective temperature is at or below
 * the policy's `temperatureGate` (default 0 → deterministic responses only).
 */
export function isCacheableTemperature(policy: CachePolicy, temperature: number | undefined): boolean {
  const gate = policy.temperatureGate ?? 0;
  const effective = temperature ?? 0; // unset ⇒ treat as deterministic intent
  return effective <= gate;
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
