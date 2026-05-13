/**
 * Phase 5 — Dynamic Tool Subset (lever L3).
 *
 * Per-tick filter that narrows the tool catalog presented to the model based
 * on the policy's `toolSubset` config. Two strategies ship in Phase 5:
 *
 *   - `'all'`   → no filtering (pass-through, equivalent to no-op).
 *   - `'phase'` → look up `config.phases[ctx.phase]` and intersect with the
 *                 set of tools currently available. When phase is missing,
 *                 unknown, or the map entry is empty, returns `null` (= keep
 *                 all) so the strategy is NEVER load-bearing.
 *
 * `'intent-rag'` is reserved for a future phase and currently degrades to
 * pass-through (returns null, never throws).
 *
 * Reusability invariant: this module imports only from `@weaveintel/core`
 * and the cost-governor's own types. Apps wire it via the
 * `bundle.toolFilter` slot returned by `weaveCostGovernor()`.
 */

import type { ToolRegistry } from '@weaveintel/core';
import type { CostLeverContext, CostToolFilter } from './governor.js';
import type { ToolSubsetConfig } from './policy.js';

export interface ToolSubsetDecision {
  /** Tool keys retained for this tick. */
  readonly keep: ReadonlyArray<string>;
  /** Tool keys filtered out. */
  readonly dropped: ReadonlyArray<string>;
  /** Human-readable reason — useful for audit logs and operator debugging. */
  readonly reason: string;
  /** Whether the decision is a true filter (`true`) or a pass-through (`false`). */
  readonly filtered: boolean;
}

/**
 * Pure decision: given a config, the universe of available tool keys, and a
 * lever context, return which keys to keep / drop and why. Never throws.
 *
 * Pass-through (`filtered: false`, `keep === availableKeys`) is returned in
 * any of:
 *   - config is missing, malformed, or `strategy === 'all'`
 *   - `strategy === 'phase'` but `ctx.phase` is missing
 *   - `strategy === 'phase'` and `config.phases[ctx.phase]` is missing/empty
 *   - `strategy === 'intent-rag'` (reserved; degrades to pass-through)
 */
export function decideToolSubset(
  config: ToolSubsetConfig | null | undefined,
  availableKeys: ReadonlyArray<string>,
  ctx: CostLeverContext,
): ToolSubsetDecision {
  const passThrough = (reason: string): ToolSubsetDecision => ({
    keep: availableKeys,
    dropped: [],
    reason,
    filtered: false,
  });

  if (!config || typeof config !== 'object') return passThrough('no-config');
  if (config.strategy === 'all') return passThrough('strategy=all');
  if (config.strategy === 'intent-rag') return passThrough('strategy=intent-rag (reserved)');
  if (config.strategy !== 'phase') return passThrough(`unknown-strategy=${String(config.strategy)}`);

  const phase = ctx.phase;
  if (!phase || typeof phase !== 'string') return passThrough('phase=missing');

  const allowed = config.phases?.[phase];
  if (!allowed || allowed.length === 0) return passThrough(`phase=${phase} not-mapped`);

  const allowSet = new Set(allowed);
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const key of availableKeys) {
    if (allowSet.has(key)) keep.push(key);
    else dropped.push(key);
  }

  // If the intersection is empty, fall back to pass-through rather than
  // starve the model — operators almost always misconfigure phase mappings
  // before getting them right, and a tool-less ReAct loop just spins.
  if (keep.length === 0) {
    return passThrough(`phase=${phase} mapped-but-no-overlap (allowed=${allowed.length}, available=${availableKeys.length})`);
  }

  return { keep, dropped, reason: `phase=${phase}`, filtered: true };
}

/**
 * Build a `CostToolFilter` closing over a `ToolSubsetConfig`. The returned
 * filter is the canonical hook wired into `CostGovernorBundle.toolFilter` by
 * `weaveCostGovernor()` when the policy's `toolSubset.strategy !== 'all'`.
 *
 * Returns `null` (= keep all) on any pass-through outcome. Returns the kept
 * subset otherwise. Never throws — failures fall through to pass-through.
 */
export function weaveToolSubsetFilter(config: ToolSubsetConfig): CostToolFilter {
  return (toolKeys, ctx) => {
    try {
      const decision = decideToolSubset(config, toolKeys, ctx);
      return decision.filtered ? decision.keep : null;
    } catch {
      return null;
    }
  };
}

/**
 * Apply a `CostToolFilter` to an existing `ToolRegistry`, returning a new
 * registry containing only the tools whose schema name survives the filter.
 * Pass-through (filter returns `null`) returns the original registry
 * unchanged.
 *
 * `targetRegistry` is the empty registry to populate (so callers can
 * pre-construct a policy-enforced or otherwise wrapped registry and have it
 * receive only the kept tools). When omitted, callers must use the returned
 * registry instead of the original.
 */
export async function applyToolFilterToRegistry(
  source: ToolRegistry,
  filter: CostToolFilter,
  ctx: CostLeverContext,
  targetRegistry: ToolRegistry,
): Promise<{ registry: ToolRegistry; kept: ReadonlyArray<string>; dropped: ReadonlyArray<string>; filtered: boolean }> {
  const tools = source.list();
  const allKeys = tools.map((t) => t.schema.name);
  let result: ReadonlyArray<string> | null;
  try {
    result = await filter(allKeys, ctx);
  } catch {
    result = null;
  }

  if (result === null) {
    // Pass-through: copy everything into the target registry.
    for (const t of tools) targetRegistry.register(t);
    return { registry: targetRegistry, kept: allKeys, dropped: [], filtered: false };
  }

  const keepSet = new Set(result);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) {
    if (keepSet.has(t.schema.name)) {
      targetRegistry.register(t);
      kept.push(t.schema.name);
    } else {
      dropped.push(t.schema.name);
    }
  }
  return { registry: targetRegistry, kept, dropped, filtered: true };
}
