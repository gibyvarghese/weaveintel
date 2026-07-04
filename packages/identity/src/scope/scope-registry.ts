/**
 * @weaveintel/identity/scope — scope-registry.ts
 *
 * ScopeRegistry — the central store for scope definitions and cross-scope policies.
 *
 * The registry is the "firewall rule table" for the scope system:
 *   - AgentScopes are the network segments
 *   - ScopeCrossPolicies are the firewall rules
 *   - The registry evaluates whether a crossing is allowed
 *
 * Instantiation:
 *   - One registry per application (a singleton in the host application)
 *   - Populate from DB at startup via ScopeRegistry.fromRows()
 *   - Or populate programmatically with register*() methods
 *
 * Policy lookup order (first match wins):
 *   1. Exact match: fromScope + toScope
 *   2. Wildcard target: fromScope + '*'
 *   3. Wildcard source: '*' + toScope
 *   4. Default: DENY
 */
import type { AgentScope, ScopeCrossPolicy, ScopeCheckResult, ScopeContext } from './types.js';
import { getCrossScopeHopCount, isScopeContextExpired } from './scope-context.js';

export class ScopeRegistry {
  private readonly scopes = new Map<string, AgentScope>();
  // Key: "fromScope::toScope" for exact, "fromScope::*" for wildcard, "*::toScope" for reverse wildcard
  private readonly policies = new Map<string, ScopeCrossPolicy>();

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register a scope definition.
   * Overwrites any previously registered scope with the same name.
   */
  registerScope(scope: AgentScope): void {
    this.scopes.set(scope.name, scope);
  }

  /**
   * Register a cross-scope policy.
   * Overwrites any existing policy for the same fromScope→toScope pair.
   */
  registerPolicy(policy: ScopeCrossPolicy): void {
    const key = `${policy.fromScope}::${policy.toScope}`;
    this.policies.set(key, policy);
  }

  /** Register multiple scopes at once. */
  registerScopes(scopes: readonly AgentScope[]): void {
    for (const scope of scopes) this.registerScope(scope);
  }

  /** Register multiple policies at once. */
  registerPolicies(policies: readonly ScopeCrossPolicy[]): void {
    for (const policy of policies) this.registerPolicy(policy);
  }

  // ── Lookups ───────────────────────────────────────────────────────────

  getScope(name: string): AgentScope | undefined {
    return this.scopes.get(name);
  }

  getAllScopes(): AgentScope[] {
    return Array.from(this.scopes.values());
  }

  getPoliciesFrom(fromScope: string): ScopeCrossPolicy[] {
    return Array.from(this.policies.values()).filter(
      (p) => p.fromScope === fromScope || p.fromScope === '*',
    );
  }

  // ── Policy Evaluation ─────────────────────────────────────────────────

  /**
   * Core policy evaluation — can an agent in `fromScope` delegate to `toScope`?
   *
   * Called by ScopeGuard before any cross-scope operation.
   *
   * @param fromScope Current agent scope
   * @param toScope   Target scope
   * @param ctx       Current runtime ScopeContext (for chain depth and expiry checks)
   */
  canDelegate(
    fromScope: string,
    toScope: string,
    ctx: ScopeContext,
  ): ScopeCheckResult {
    // ── Guard: context expiry ────────────────────────────────────────────
    if (isScopeContextExpired(ctx)) {
      return {
        allowed: false,
        reason: `Scope context expired at ${new Date(ctx.expiresAt).toISOString()}`,
        violationType: 'expired-context',
      };
    }

    // ── Short-circuit: same scope (within-scope delegation is always ok) ─
    if (fromScope === toScope) {
      const scope = this.scopes.get(fromScope);
      const maxDepth = scope?.maxDelegationDepth ?? 5;
      const currentDepth = getCrossScopeHopCount(ctx);
      if (currentDepth >= maxDepth) {
        return {
          allowed: false,
          reason: `Delegation depth ${currentDepth} exceeds max ${maxDepth} for scope '${fromScope}'`,
          violationType: 'delegation-depth',
        };
      }
      return { allowed: true };
    }

    // ── Guard: confused-deputy check — agents cannot spontaneously escalate ─
    // The 'system' scope is an orchestration-only scope. No agent should be
    // able to enter 'system' unless the user's conversation started there.
    // Any attempt to cross INTO 'system' from a non-system scope is blocked.
    if (toScope === 'system' && fromScope !== 'system') {
      return {
        allowed: false,
        reason: `Confused-deputy protection: scope '${fromScope}' cannot escalate to 'system'`,
        violationType: 'confused-deputy',
      };
    }

    // ── Policy lookup ─────────────────────────────────────────────────────
    const policy = this.resolvePolicy(fromScope, toScope);

    if (!policy) {
      // No policy found — default deny (allowlist model)
      return {
        allowed: false,
        reason: `No policy found for '${fromScope}'→'${toScope}' (default deny)`,
        violationType: 'no-policy',
      };
    }

    if (!policy.allowed) {
      return {
        allowed: false,
        reason: `Policy explicitly denies '${fromScope}'→'${toScope}'`,
        violationType: 'explicit-deny',
      };
    }

    // ── Chain depth check ─────────────────────────────────────────────────
    const maxCrossScopeDepth = policy.maxDelegationDepth ?? 1;
    const currentCrossHops = getCrossScopeHopCount(ctx);
    if (currentCrossHops >= maxCrossScopeDepth) {
      return {
        allowed: false,
        reason: `Cross-scope hop count ${currentCrossHops} would exceed policy max ${maxCrossScopeDepth} for '${fromScope}'→'${toScope}'`,
        violationType: 'delegation-depth',
      };
    }

    // ── Allowed ─────────────────────────────────────────────────────────
    return {
      allowed: true,
      requiresA2A: policy.requiresA2A ?? false,
    };
  }

  /**
   * Check if a skill (identified by its `agenticScope`) is accessible
   * from the current context.
   *
   * If the skill's scope matches the current context scope — always allowed.
   * If they differ — evaluates the cross-scope policy.
   */
  canActivateSkill(skillScope: string, ctx: ScopeContext): ScopeCheckResult {
    if (ctx.currentScope === skillScope) {
      return { allowed: true };
    }
    // Skills in the 'system' scope are always accessible from any scope —
    // they represent core orchestration primitives that don't need isolation.
    if (skillScope === 'system') {
      return { allowed: true };
    }
    return this.canDelegate(ctx.currentScope, skillScope, ctx);
  }

  // ── Policy Resolution ─────────────────────────────────────────────────

  /**
   * Finds the most-specific policy for a from→to pair.
   *
   * Priority (first match wins):
   *   1. Exact: "analytics::kaggle"
   *   2. Source wildcard: "*::kaggle"
   *   3. Target wildcard: "analytics::*"
   *   4. Double wildcard: "*::*"
   *   5. null (no match → default deny)
   */
  private resolvePolicy(
    fromScope: string,
    toScope: string,
  ): ScopeCrossPolicy | null {
    return (
      this.policies.get(`${fromScope}::${toScope}`) ??
      this.policies.get(`*::${toScope}`) ??
      this.policies.get(`${fromScope}::*`) ??
      this.policies.get('*::*') ??
      null
    );
  }

  // ── Debug Helpers ─────────────────────────────────────────────────────

  /**
   * Returns a human-readable summary of the registry state.
   * Useful for logging at startup to confirm scope config loaded correctly.
   */
  describe(): string {
    const scopeNames = [...this.scopes.keys()].sort().join(', ');
    const policyCount = this.policies.size;
    return `ScopeRegistry: ${this.scopes.size} scopes [${scopeNames}], ${policyCount} policies`;
  }
}
