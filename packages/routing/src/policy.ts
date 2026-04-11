/**
 * @weaveintel/routing — Routing policy evaluator
 *
 * Applies RoutingPolicy constraints to filter candidate models
 * before scoring. Implements strategy-specific selection logic.
 */

import type { RoutingPolicy, RoutingConstraints, ModelHealth } from '@weaveintel/core';

// ─── Candidate ───────────────────────────────────────────────

export interface ModelCandidate {
  modelId: string;
  providerId: string;
  capabilities?: string[];
}

// ─── Policy evaluator ────────────────────────────────────────

/**
 * Filter candidates by the policy's constraints.
 * Returns models that pass all constraint checks.
 */
export function filterByConstraints(
  candidates: ModelCandidate[],
  constraints: RoutingConstraints | undefined,
  health: Map<string, ModelHealth>,
): ModelCandidate[] {
  if (!constraints) return candidates;

  return candidates.filter(c => {
    const k = `${c.providerId}:${c.modelId}`;
    const h = health.get(k);

    // Exclude providers
    if (constraints.excludeProviders?.includes(c.providerId)) return false;
    // Exclude models
    if (constraints.excludeModels?.includes(c.modelId)) return false;

    // Latency constraint
    if (constraints.maxLatencyMs != null && h && h.avgLatencyMs > constraints.maxLatencyMs) return false;

    // Required capabilities
    if (constraints.requiredCapabilities && constraints.requiredCapabilities.length > 0) {
      if (!c.capabilities) return false;
      for (const cap of constraints.requiredCapabilities) {
        if (!c.capabilities.includes(cap)) return false;
      }
    }

    return true;
  });
}

/**
 * Apply round-robin selection to a list of candidates.
 */
let roundRobinIndex = 0;
export function roundRobinSelect<T>(items: T[]): T {
  const item = items[roundRobinIndex % items.length]!;
  roundRobinIndex++;
  return item;
}

/**
 * Build a fallback candidate from a policy's fallback fields.
 */
export function fallbackCandidate(policy: RoutingPolicy): ModelCandidate | null {
  if (!policy.fallbackModelId || !policy.fallbackProviderId) return null;
  return { modelId: policy.fallbackModelId, providerId: policy.fallbackProviderId };
}
