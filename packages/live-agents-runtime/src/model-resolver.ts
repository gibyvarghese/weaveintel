/**
 * Model Resolver — Phase 3.5 of the DB-driven live-agents runtime.
 *
 * Pure-data facade that turns the three model_* columns on a
 * `live_agents` (or `live_agent_definitions`) row into a normalised spec
 * the geneweave bridge can hand to `@weaveintel/routing` (or use directly
 * via the pinned id escape hatch).
 *
 * Resolution rules (per docs/live-agents/DB_DRIVEN_RUNTIME_PLAN.md §5b.4):
 *
 *   1. If `model_pinned_id` is set → caller MUST honour it and bypass
 *      routing (used for replay / reproducibility runs).
 *   2. Else parse `model_capability_json` (defensively — invalid JSON is
 *      treated as null, never throws) and pass the result + optional
 *      `model_routing_policy_key` to the routing package.
 *   3. If everything is null → caller falls back to platform default.
 *
 * The runtime package never imports `@weaveintel/routing` itself; this
 * file is intentionally dependency-free so it stays cheap to consume from
 * tests and any app that wires up routing differently.
 */

/**
 * Minimal shape that both `LiveAgentRow` and `LiveAgentDefinitionRow`
 * (in geneweave's `db-types.ts`) satisfy. Plain field-shape interface —
 * NOT an index signature — so concrete row types are assignable.
 */
export interface AgentModelFieldsRowLike {
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
}

/**
 * Discriminator describing where the resolved model spec came from. Useful
 * for `live_run_events` audit rows ("why did this agent get this model?").
 */
export type AgentModelSource =
  | 'pinned'      // model_pinned_id was set; routing was bypassed
  | 'capability'  // model_capability_json was set; routing should run
  | 'default';    // nothing set; caller should use platform default

export interface ResolvedAgentModelSpec {
  /** Pre-parsed capability spec (or null when absent / unparseable). */
  capabilitySpec: Record<string, unknown> | null;
  /** Optional routing-policy override key. Null = use system default. */
  routingPolicyKey: string | null;
  /** Pinned id wins over routing when non-null. */
  pinnedId: string | null;
  source: AgentModelSource;
}

/**
 * Parse the three `model_*` columns into a normalised spec. Never throws —
 * malformed JSON in `model_capability_json` is silently coerced to null so
 * a single bad row cannot crash a tick.
 */
export function resolveAgentModelSpec(row: AgentModelFieldsRowLike): ResolvedAgentModelSpec {
  const pinnedId = nonEmpty(row.model_pinned_id);
  const routingPolicyKey = nonEmpty(row.model_routing_policy_key);
  const capabilitySpec = parseCapabilityJson(row.model_capability_json);

  let source: AgentModelSource;
  if (pinnedId) source = 'pinned';
  else if (capabilitySpec) source = 'capability';
  else source = 'default';

  return { capabilitySpec, routingPolicyKey, pinnedId, source };
}

function nonEmpty(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function parseCapabilityJson(raw: string | null | undefined): Record<string, unknown> | null {
  const s = nonEmpty(raw);
  if (s == null) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
