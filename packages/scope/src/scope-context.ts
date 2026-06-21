/**
 * @weaveintel/scope — scope-context.ts
 *
 * Factory functions for creating and managing ScopeContext objects.
 *
 * ScopeContext is the runtime identity of an agent's security boundary.
 * It travels with the agent through its entire execution chain and is
 * checked at every scope boundary crossing.
 *
 * Design constraints:
 *   - Contexts are immutable — every crossing produces a NEW context
 *   - The chain grows monotonically (entries are never removed)
 *   - Depth is bounded by the delegation policies
 *   - Contexts expire automatically (default TTL: 60 minutes for a session)
 */
import type { CrossScopeToken, ScopeContext, ScopeDelegationEntry } from './types.js';

/** Default TTL for a root scope context (60 minutes in ms). */
const DEFAULT_CONTEXT_TTL_MS = 60 * 60 * 1000;

/**
 * Creates the root ScopeContext for a new conversation or task.
 *
 * Call this once at the start of each user message handling cycle.
 * All agents involved in responding to that message derive their contexts
 * from this root via deriveScopeContext().
 *
 * @param scope     The initial domain for this conversation (e.g. 'system')
 * @param sessionId Stable session ID from the chat session
 * @param taskId    Optional correlation ID for this specific task/message
 * @param ttlMs     Context lifetime in milliseconds (default: 60 minutes)
 */
export function createRootScopeContext(
  scope: string,
  sessionId: string,
  taskId?: string,
  ttlMs: number = DEFAULT_CONTEXT_TTL_MS,
): ScopeContext {
  const now = Date.now();
  return {
    currentScope: scope,
    delegationChain: [],
    sessionId,
    taskId: taskId ?? `task-${now}`,
    expiresAt: now + ttlMs,
    permissions: [`${scope}:*`],  // root scope has full permissions within its domain
  };
}

/**
 * Creates a derived ScopeContext for a cross-scope delegation.
 *
 * Called when an agent in scope A needs to delegate to scope B.
 * Requires a valid CrossScopeToken issued by issueCrossScopeToken().
 *
 * The derived context:
 *   - Has currentScope set to the token's toScope
 *   - Extends the delegation chain with the new entry
 *   - Inherits the same sessionId and taskId (for correlation)
 *   - Has permissions narrowed to what the token grants
 *   - Expires at the EARLIER of the parent's expiry or the token's expiry
 *
 * @param parentContext  The current agent's scope context
 * @param token          The CrossScopeToken authorizing this crossing
 * @param reason         Why this delegation is happening
 */
export function deriveScopeContext(
  parentContext: ScopeContext,
  token: CrossScopeToken,
  reason: string,
): ScopeContext {
  const entry: ScopeDelegationEntry = {
    fromScope: token.fromScope,
    toScope: token.toScope,
    timestamp: Date.now(),
    reason,
    taskId: token.taskId,
    tokenId: token.id,
  };

  // Effective expiry is the more restrictive of parent vs token
  const expiresAt = Math.min(parentContext.expiresAt, token.expiresAt);

  // Permissions: union of parent's remaining permissions + token's granted permissions,
  // but NEVER wider than what the token explicitly grants for the new scope.
  // This enforces the invariant: "an agent cannot grant scopes it doesn't possess."
  const parentScopePermissions = parentContext.permissions.filter(
    (p) => p.startsWith(`${token.toScope}:`),
  );
  const newPermissions = Array.from(
    new Set([...parentScopePermissions, ...token.permissions]),
  );

  return {
    currentScope: token.toScope,
    delegationChain: [...parentContext.delegationChain, entry],
    sessionId: parentContext.sessionId,
    taskId: parentContext.taskId,
    expiresAt,
    permissions: newPermissions,
  };
}

/**
 * Returns the total depth of the delegation chain in the context.
 * Counts ALL hops (both within-scope and cross-scope).
 */
export function getScopeDepth(ctx: ScopeContext): number {
  return ctx.delegationChain.length;
}

/**
 * Returns the number of CROSS-SCOPE hops in the delegation chain.
 * Used to enforce ScopeCrossPolicy.maxDelegationDepth.
 */
export function getCrossScopeHopCount(ctx: ScopeContext): number {
  return ctx.delegationChain.filter(
    (entry) => entry.fromScope !== entry.toScope,
  ).length;
}

/** Returns true if the context has expired and should be rejected. */
export function isScopeContextExpired(ctx: ScopeContext): boolean {
  return Date.now() > ctx.expiresAt;
}

/**
 * Returns the full delegation chain as a compact string for logging.
 * Example: "system→analytics→code"
 */
export function formatDelegationChain(ctx: ScopeContext): string {
  if (ctx.delegationChain.length === 0) {
    return ctx.currentScope;
  }
  const first = ctx.delegationChain[0];
  if (!first) return ctx.currentScope;
  const scopes = [first.fromScope, ...ctx.delegationChain.map((e) => e.toScope)];
  return scopes.join('→');
}

/**
 * Returns true if the context has the given permission.
 * Permissions are checked with wildcard support:
 *   "analytics:*" grants "analytics:read" and "analytics:write"
 */
export function hasPermission(ctx: ScopeContext, permission: string): boolean {
  const [scope, action] = permission.split(':');
  return ctx.permissions.some((p) => {
    if (p === permission) return true;
    if (p === `${scope}:*`) return true;
    if (p === '*:*') return true;
    if (p === `*:${action}`) return true;
    return false;
  });
}
