/**
 * Phase 2 — `CostPolicyResolver` runtime contract.
 *
 * The resolver answers "what cost policy should this agent / mesh / workflow
 * use right now?" at runtime, without baking provider-specific DB shapes
 * into the package. Geneweave (and any other consumer) implements
 * `CostPolicyResolver` over its own storage and passes the resolver into
 * runtime entry points like `weaveLiveMeshFromDb`.
 *
 * The package ships:
 *   - `weaveStaticCostPolicyResolver(policy)`   — pinned single policy.
 *   - `composeCostPolicyResolvers([a, b, c])`   — first non-null wins.
 *
 * Resolution semantics (consumer responsibility):
 *   The recommended precedence inside DB-backed resolvers mirrors Phase 5
 *   capability bindings — agent (100) > mesh (50) > workflow (10) > tenant
 *   default. Returning `null` means "no policy bound; caller should fall
 *   back to its own default (typically `balanced`)".
 */

import type { CostPolicy } from './policy.js';
import type { CostGovernorBundle } from './governor.js';
import { weaveCostGovernor } from './governor.js';
import { DEFAULT_COST_TIER } from './policy.js';

/** Lookup context — the runtime supplies whichever ids it has. */
export interface CostPolicyResolutionContext {
  readonly tenantId?: string;
  readonly meshId?: string;
  readonly agentId?: string;
  readonly workflowId?: string;
  /** Explicit per-run override (e.g. POST /api/.../runs body). Wins over DB. */
  readonly perRunOverride?: CostPolicy;
}

/** Result of a resolver lookup — the policy plus its provenance. */
export interface ResolvedCostPolicyBinding {
  readonly policy: CostPolicy;
  /** Where the policy came from. Helpful for audit + debugging. */
  readonly source: 'per_run_override' | 'agent_binding' | 'mesh_binding' | 'workflow_binding' | 'tenant_default' | 'package_default' | 'static';
  /** The id of the binding row when source is *_binding. */
  readonly bindingId?: string;
  /** The cost_policies row id when known. */
  readonly policyId?: string;
}

export interface CostPolicyResolver {
  resolve(ctx: CostPolicyResolutionContext): Promise<ResolvedCostPolicyBinding | null>;
}

/** Pinned resolver — always returns the same policy regardless of context. */
export function weaveStaticCostPolicyResolver(policy: CostPolicy): CostPolicyResolver {
  return {
    async resolve() {
      return { policy, source: 'static' };
    },
  };
}

/** Compose resolvers — first non-null wins. Errors are logged and treated as null. */
export function composeCostPolicyResolvers(resolvers: ReadonlyArray<CostPolicyResolver>): CostPolicyResolver {
  return {
    async resolve(ctx) {
      for (const r of resolvers) {
        try {
          const result = await r.resolve(ctx);
          if (result) return result;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[cost-governor] resolver failed; continuing', err);
        }
      }
      return null;
    },
  };
}

/**
 * Convenience: resolve a policy and immediately wrap it in a governor bundle.
 * If no policy is bound anywhere, falls back to the package default tier
 * (`balanced` today).
 */
export async function resolveCostGovernorBundle(
  resolver: CostPolicyResolver | undefined,
  ctx: CostPolicyResolutionContext,
): Promise<{ bundle: CostGovernorBundle; binding: ResolvedCostPolicyBinding }> {
  if (ctx.perRunOverride) {
    return {
      bundle: weaveCostGovernor(ctx.perRunOverride),
      binding: { policy: ctx.perRunOverride, source: 'per_run_override' },
    };
  }
  const binding = (resolver && (await resolver.resolve(ctx))) ?? {
    policy: { tier: DEFAULT_COST_TIER },
    source: 'package_default' as const,
  };
  return { bundle: weaveCostGovernor(binding.policy), binding };
}
