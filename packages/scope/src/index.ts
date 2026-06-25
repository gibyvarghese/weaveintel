// SPDX-License-Identifier: MIT
/**
 * @weaveintel/scope — public API
 *
 * Agentic Scope Isolation for multi-agent AI systems.
 *
 * Quick start:
 *
 *   import {
 *     ScopeRegistry, ScopeGuard, ScopeViolationError,
 *     createRootScopeContext, deriveScopeContext,
 *     WEAVEINTEL_DEFAULT_SCOPES, WEAVEINTEL_DEFAULT_POLICIES,
 *   } from '@weaveintel/scope';
 *
 *   // 1. Bootstrap once at startup
 *   const registry = new ScopeRegistry();
 *   registry.registerScopes(WEAVEINTEL_DEFAULT_SCOPES);
 *   registry.registerPolicies(WEAVEINTEL_DEFAULT_POLICIES);
 *
 *   // 2. Create root context at the start of each message
 *   const ctx = createRootScopeContext('system', sessionId, taskId);
 *
 *   // 3. Check before activating a skill
 *   const guard = new ScopeGuard(registry, { enforce: true });
 *   const result = guard.checkSkillActivation(skill.agenticScope, ctx, skill.id);
 *   if (!result.allowed) throw new ScopeViolationError(result.reason!, result);
 *
 *   // 4. Cross-scope delegation via A2A
 *   const delegateResult = guard.checkA2ADelegation('analytics', 'code', ctx);
 *   if (delegateResult.allowed && delegateResult.requiresA2A) {
 *     const token = guard.issueDelegationToken('analytics', 'code', ctx, ['code:execute']);
 *     const childCtx = deriveScopeContext(ctx, token, 'run analysis script');
 *     // ... make A2A call with childCtx
 *   }
 */

// Types
export type {
  AgentScope,
  ScopeCrossPolicy,
  ScopePolicyCondition,
  ScopeDelegationEntry,
  ScopeContext,
  CrossScopeToken,
  ScopeCheckResult,
  ScopeAccessEvent,
} from './types.js';

// Errors
export { ScopeViolationError, InvalidScopeTokenError } from './errors.js';

// Context management
export {
  createRootScopeContext,
  deriveScopeContext,
  getScopeDepth,
  getCrossScopeHopCount,
  isScopeContextExpired,
  formatDelegationChain,
  hasPermission,
} from './scope-context.js';

// Token management
export {
  issueCrossScopeToken,
  validateCrossScopeToken,
  isCrossScopeTokenExpired,
  describeCrossScopeToken,
} from './scope-token.js';

// Registry
export { ScopeRegistry } from './scope-registry.js';

// Guard (the main enforcement API)
export { ScopeGuard } from './scope-guard.js';
export type { ScopeGuardOptions, ScopeCheckEvent } from './scope-guard.js';

// Default scope definitions
export {
  WEAVEINTEL_DEFAULT_SCOPES,
  WEAVEINTEL_DEFAULT_POLICIES,
  SKILL_SCOPE_MAP,
  getScopeForSkill,
} from './default-scopes.js';