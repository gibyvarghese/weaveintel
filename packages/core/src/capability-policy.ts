/**
 * @weaveintel/core — capability-policy.ts
 *
 * Phase 5 — Capability Policy Bindings.
 *
 * A `CapabilityPolicyBinding` ties a runtime capability (workflow / mesh /
 * agent) to a policy (tool_policy / rate_limit / approval). Bindings are
 * persisted in the host DB; the engine and live-agents runtime resolve
 * the effective policy at execution time using the typed `policy_kind`
 * + `policy_ref` pair.
 *
 * The contract lives in core (no DB or framework imports) so any package
 * can produce or consume bindings without a circular dependency.
 */

export type CapabilityBindingKind = 'workflow' | 'mesh' | 'agent';

export type CapabilityPolicyKind = 'tool_policy' | 'rate_limit' | 'approval';

export interface CapabilityPolicyBinding {
  id: string;
  /** What the binding applies to (workflow run, mesh, live agent). */
  bindingKind: CapabilityBindingKind;
  /** Reference into the binding-kind table — usually the row id or key. */
  bindingRef: string;
  /** What kind of policy is being bound (operator-defined taxonomy). */
  policyKind: CapabilityPolicyKind;
  /** Reference into the policy table for `policyKind`. */
  policyRef: string;
  /**
   * When multiple bindings apply (e.g. agent + mesh), higher precedence
   * wins. Defaults to 0; agent-level bindings should generally use 100,
   * mesh-level 50, workflow-level 10.
   */
  precedence: number;
  createdAt?: string;
}

/**
 * Resolve the highest-precedence binding for a given (kind, ref, policyKind)
 * tuple. Returns `null` when nothing matches. Pure helper so apps can reuse
 * it without owning DB-specific resolution logic.
 */
export function resolveCapabilityBinding(
  bindings: readonly CapabilityPolicyBinding[],
  bindingKind: CapabilityBindingKind,
  bindingRef: string,
  policyKind: CapabilityPolicyKind,
): CapabilityPolicyBinding | null {
  let best: CapabilityPolicyBinding | null = null;
  for (const b of bindings) {
    if (b.bindingKind !== bindingKind) continue;
    if (b.bindingRef !== bindingRef) continue;
    if (b.policyKind !== policyKind) continue;
    if (!best || b.precedence > best.precedence) best = b;
  }
  return best;
}
