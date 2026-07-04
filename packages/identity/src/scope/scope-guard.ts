/**
 * @weaveintel/identity/scope — scope-guard.ts
 *
 * ScopeGuard — the enforcement layer that sits at every scope boundary.
 *
 * Think of ScopeGuard as the security guard at each door between departments:
 *   - Checks if you have the right badge (scope context)
 *   - Looks up whether your department can enter this area (policy)
 *   - Issues a visitor badge if required (CrossScopeToken)
 *   - Writes in the visitor log (audit callback)
 *
 * Usage pattern in a consuming application:
 *
 *   const guard = new ScopeGuard(registry, { enforce: true, secret });
 *
 *   // Before activating a skill:
 *   const result = guard.checkSkillActivation(skill.agenticScope, ctx);
 *   if (!result.allowed) throw new ScopeViolationError(result.reason, result);
 *
 *   // Before an A2A delegation:
 *   const result = guard.checkA2ADelegation('analytics', 'code', ctx);
 *   if (result.allowed && result.requiresA2A) {
 *     const token = guard.issueDelegationToken('analytics', 'code', ctx, perms);
 *     // ... make A2A call with token
 *   }
 */
import type { CrossScopeToken, ScopeCheckResult, ScopeContext } from './types.js';
import { ScopeRegistry } from './scope-registry.js';
import { issueCrossScopeToken } from './scope-token.js';
import { isScopeContextExpired } from './scope-context.js';

export interface ScopeGuardOptions {
  /**
   * When false, the guard logs violations but returns allowed=true for all
   * checks. Use during a phased rollout. Default: true (enforce).
   */
  enforce?: boolean;
  /**
   * HMAC secret for signing CrossScopeTokens.
   * Defaults to a weak dev-only value — always set from env in production.
   */
  tokenSecret?: string;
  /**
   * Optional callback invoked after every scope check.
   * Used by the host application to write to scope_access_log.
   */
  onCheck?: (event: ScopeCheckEvent) => void | Promise<void>;
}

/** Passed to onCheck after each scope evaluation. */
export interface ScopeCheckEvent {
  readonly checkType: 'skill' | 'delegation' | 'tool';
  readonly result: ScopeCheckResult;
  readonly fromScope: string;
  readonly toScope?: string;
  readonly skillId?: string;
  readonly toolName?: string;
  readonly context: ScopeContext;
}

const DEV_FALLBACK_SECRET = 'weaveintel-scope-dev-secret-change-in-production';

export class ScopeGuard {
  private readonly registry: ScopeRegistry;
  private readonly enforce: boolean;
  private readonly tokenSecret: string;
  private readonly onCheck?: (event: ScopeCheckEvent) => void | Promise<void>;

  constructor(registry: ScopeRegistry, opts: ScopeGuardOptions = {}) {
    this.registry = registry;
    this.enforce = opts.enforce ?? true;
    this.tokenSecret = opts.tokenSecret ?? DEV_FALLBACK_SECRET;
    this.onCheck = opts.onCheck;
  }

  // ── Skill Activation ──────────────────────────────────────────────────

  /**
   * Checks whether a skill can be activated from the current scope context.
   *
   * Call this in discoverSkillsForInput() after the LLM selects candidates,
   * before returning the final skill list.
   *
   * @param skillScope  The AgentScope the skill belongs to (SkillDefinition.agenticScope)
   * @param ctx         Current ScopeContext
   * @param skillId     Skill ID for audit logging
   */
  checkSkillActivation(
    skillScope: string,
    ctx: ScopeContext,
    skillId?: string,
  ): ScopeCheckResult {
    const raw = this.registry.canActivateSkill(skillScope, ctx);
    const result = this.maybePermit(raw);

    this.emit({ checkType: 'skill', result, fromScope: ctx.currentScope, toScope: skillScope, skillId, context: ctx });
    return result;
  }

  // ── A2A Delegation ────────────────────────────────────────────────────

  /**
   * Checks whether scope `fromScope` can delegate work to scope `toScope`.
   *
   * Returns:
   *   - allowed=false → block the delegation
   *   - allowed=true, requiresA2A=false → allow (same scope or system→*)
   *   - allowed=true, requiresA2A=true → allowed, but MUST use A2A + token
   *
   * @param fromScope Current scope
   * @param toScope   Target scope
   * @param ctx       Current ScopeContext
   */
  checkA2ADelegation(
    fromScope: string,
    toScope: string,
    ctx: ScopeContext,
  ): ScopeCheckResult {
    const raw = this.registry.canDelegate(fromScope, toScope, ctx);
    const result = this.maybePermit(raw);

    this.emit({ checkType: 'delegation', result, fromScope, toScope, context: ctx });
    return result;
  }

  // ── Tool Invocation ───────────────────────────────────────────────────

  /**
   * Checks whether a tool can be called from the current scope context.
   *
   * Tools are assigned to scopes via the `allowedScopes` parameter.
   * A tool with no allowedScopes is allowed from any scope.
   *
   * @param toolName      Name of the tool being invoked
   * @param allowedScopes Scopes that are permitted to call this tool
   * @param ctx           Current ScopeContext
   */
  checkToolInvocation(
    toolName: string,
    allowedScopes: readonly string[],
    ctx: ScopeContext,
  ): ScopeCheckResult {
    // No scope restriction on this tool — allow from anywhere
    if (allowedScopes.length === 0) {
      const result: ScopeCheckResult = { allowed: true };
      this.emit({ checkType: 'tool', result, fromScope: ctx.currentScope, toolName, context: ctx });
      return result;
    }

    // Expired context — reject
    if (isScopeContextExpired(ctx)) {
      const result: ScopeCheckResult = {
        allowed: false,
        reason: 'Scope context expired',
        violationType: 'expired-context',
      };
      const final = this.maybePermit(result);
      this.emit({ checkType: 'tool', result: final, fromScope: ctx.currentScope, toolName, context: ctx });
      return final;
    }

    const currentScope = ctx.currentScope;
    if (allowedScopes.includes(currentScope) || allowedScopes.includes('*')) {
      const result: ScopeCheckResult = { allowed: true };
      this.emit({ checkType: 'tool', result, fromScope: currentScope, toolName, context: ctx });
      return result;
    }

    const raw: ScopeCheckResult = {
      allowed: false,
      reason: `Tool '${toolName}' is not allowed from scope '${currentScope}' (allowed: ${allowedScopes.join(', ')})`,
      violationType: 'scope-boundary',
    };
    const result = this.maybePermit(raw);
    this.emit({ checkType: 'tool', result, fromScope: currentScope, toolName, context: ctx });
    return result;
  }

  // ── Token Issuance ────────────────────────────────────────────────────

  /**
   * Issues a CrossScopeToken for a delegaton that passed checkA2ADelegation().
   *
   * Call this immediately before making the A2A call to the target scope.
   * Pass the token to deriveScopeContext() in the receiving agent.
   *
   * @param fromScope   Source scope
   * @param toScope     Target scope
   * @param ctx         Current ScopeContext (for binding claims)
   * @param permissions Permissions to grant in the target scope
   * @param ttlMs       Token lifetime (default: 10 minutes)
   */
  issueDelegationToken(
    fromScope: string,
    toScope: string,
    ctx: ScopeContext,
    permissions: readonly string[],
    ttlMs?: number,
  ): CrossScopeToken {
    return issueCrossScopeToken(
      fromScope,
      toScope,
      ctx.taskId,
      ctx.sessionId,
      permissions,
      this.tokenSecret,
      ttlMs,
    );
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /**
   * When enforce=false, overrides denied results to allowed=true while
   * keeping the violationType for audit logging.
   */
  private maybePermit(result: ScopeCheckResult): ScopeCheckResult {
    if (this.enforce || result.allowed) return result;
    return {
      ...result,
      allowed: true,  // audit-only mode: log but don't block
      reason: `[audit-only] ${result.reason ?? 'violation not enforced'}`,
    };
  }

  private emit(event: ScopeCheckEvent): void {
    if (this.onCheck) {
      // Fire-and-forget — we don't await the audit write to avoid blocking
      void Promise.resolve(this.onCheck(event));
    }
  }
}
