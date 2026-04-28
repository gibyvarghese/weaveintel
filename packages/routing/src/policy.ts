/**
 * @weaveintel/routing — Routing policy evaluator
 *
 * Applies RoutingPolicy constraints to filter candidate models
 * before scoring. Implements strategy-specific selection logic.
 */

import type { RoutingPolicy, RoutingConstraints, ModelHealth, ModelCapabilityRow, OutputModality } from '@weaveintel/core';

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

/**
 * Resolve the ordered fallback chain for a policy. Prefers `fallbackChain`
 * (multi-hop, anyWeave Phase 1+) and falls back to the legacy single-pair fields.
 */
export function fallbackChainCandidates(policy: RoutingPolicy): ModelCandidate[] {
  if (policy.fallbackChain && policy.fallbackChain.length > 0) {
    return [...policy.fallbackChain]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map(c => ({ modelId: c.modelId, providerId: c.providerId }));
  }
  const single = fallbackCandidate(policy);
  return single ? [single] : [];
}

// ─── Phase 2 task-aware filters ──────────────────────────────

/**
 * Keep only candidates that have an active capability row for `taskKey`.
 * Implements the spec's "absence = exclusion" rule (§7).
 *
 * Tenant-scoped rows (matching `tenantId`) take precedence over global (NULL) rows.
 * Returns the kept candidates plus an exclusion record explaining why each
 * dropped candidate was removed.
 */
export function filterByCapability(
  candidates: ModelCandidate[],
  taskKey: string,
  capabilityRows: ModelCapabilityRow[],
  tenantId?: string,
): { eligible: ModelCandidate[]; excluded: Array<{ candidate: ModelCandidate; reason: string }> } {
  // Index rows by (provider, model) preferring tenant override → global.
  const tenantHits = new Map<string, ModelCapabilityRow>();
  const globalHits = new Map<string, ModelCapabilityRow>();
  for (const r of capabilityRows) {
    if (r.taskKey !== taskKey) continue;
    if (r.isActive === false) continue;
    const k = `${r.providerId}:${r.modelId}`;
    if (r.tenantId && tenantId && r.tenantId === tenantId) tenantHits.set(k, r);
    else if (!r.tenantId) globalHits.set(k, r);
  }
  const eligible: ModelCandidate[] = [];
  const excluded: Array<{ candidate: ModelCandidate; reason: string }> = [];
  for (const c of candidates) {
    const k = `${c.providerId}:${c.modelId}`;
    if (tenantHits.has(k) || globalHits.has(k)) eligible.push(c);
    else excluded.push({ candidate: c, reason: `no active capability row for task=${taskKey}` });
  }
  return { eligible, excluded };
}

/**
 * Keep only candidates whose declared output modality matches the requirement.
 * Candidates with no modality data are excluded — modality is a hard requirement.
 */
export function filterByModality(
  candidates: ModelCandidate[],
  requiredModality: OutputModality,
  modalityMap: Map<string, OutputModality>,
): { eligible: ModelCandidate[]; excluded: Array<{ candidate: ModelCandidate; reason: string }> } {
  const eligible: ModelCandidate[] = [];
  const excluded: Array<{ candidate: ModelCandidate; reason: string }> = [];
  for (const c of candidates) {
    const k = `${c.providerId}:${c.modelId}`;
    const m = modalityMap.get(k);
    if (m === requiredModality) eligible.push(c);
    else excluded.push({ candidate: c, reason: `modality=${m ?? 'unknown'} ≠ required=${requiredModality}` });
  }
  return { eligible, excluded };
}

/**
 * Drop candidates whose estimated per-call cost exceeds `maxCostPerCall`.
 * Estimation uses an assumed token shape (in/out) supplied by the caller; default
 * is 1k input + 500 output tokens which is a conservative upper bound for short
 * orchestration calls.
 */
export function filterByCostCeiling(
  candidates: ModelCandidate[],
  costMap: Map<string, { inputCostPer1M: number; outputCostPer1M: number }>,
  maxCostPerCall: number,
  tokens: { inputTokens?: number; outputTokens?: number } = {},
): { eligible: ModelCandidate[]; excluded: Array<{ candidate: ModelCandidate; reason: string }> } {
  const inT = tokens.inputTokens ?? 1000;
  const outT = tokens.outputTokens ?? 500;
  const eligible: ModelCandidate[] = [];
  const excluded: Array<{ candidate: ModelCandidate; reason: string }> = [];
  for (const c of candidates) {
    const k = `${c.providerId}:${c.modelId}`;
    const co = costMap.get(k);
    if (!co) {
      // No cost info → cannot prove it's over budget; let it through (scorer handles unknowns).
      eligible.push(c);
      continue;
    }
    const est = (co.inputCostPer1M * inT + co.outputCostPer1M * outT) / 1_000_000;
    if (est <= maxCostPerCall) eligible.push(c);
    else excluded.push({ candidate: c, reason: `est=$${est.toFixed(6)} > ceiling=$${maxCostPerCall}` });
  }
  return { eligible, excluded };
}
