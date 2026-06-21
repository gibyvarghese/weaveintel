/**
 * @weaveintel/scope — types.ts
 *
 * Core interfaces for the Agentic Scope Isolation system.
 *
 * # The problem this solves
 *
 * In a multi-agent system, agents can accidentally (or maliciously) cross
 * functional domain boundaries. Example: a user asks "analyze my sales data"
 * — the analytics agent should handle this. But without scope enforcement,
 * the supervisor might also activate the Kaggle competition mesh (a completely
 * different domain) because it shares the surface-level concept of "data
 * analysis." This is a variant of the "Confused Deputy" security problem.
 *
 * Scope isolation gives each agent a named domain boundary. Crossing a
 * boundary requires explicit authorization via a CrossScopeToken issued
 * through the A2A protocol, and every crossing is logged immutably.
 *
 * # Key concepts
 *
 *   AgentScope        — a named domain (e.g. 'analytics', 'kaggle', 'code')
 *   ScopeCrossPolicy  — rules for when/how agents may cross domain boundaries
 *   ScopeContext      — runtime state tracking the current scope chain
 *   CrossScopeToken   — short-lived HMAC-signed token authorizing one crossing
 *   ScopeCheckResult  — the verdict from a policy evaluation
 */

// ── Scope Definitions ─────────────────────────────────────────────────────────

/**
 * A named domain boundary grouping related agents, skills, and tools.
 *
 * Think of a scope like a network segment: agents within a scope can
 * communicate freely; crossing to another scope requires a firewall rule
 * (ScopeCrossPolicy) and a ticket (CrossScopeToken).
 */
export interface AgentScope {
  /** Unique machine identifier — lowercase kebab (e.g. 'analytics', 'kaggle') */
  readonly name: string;
  /** Human-readable label shown in audit logs and UI */
  readonly displayName: string;
  /** Describes what category of agents/skills lives in this scope */
  readonly description: string;
  /**
   * Strict enforcement toggle. When false the scope system logs violations
   * but does not block them — useful during a phased rollout. Default: true.
   */
  readonly sandboxed?: boolean;
  /**
   * Maximum delegation chain depth allowed within this scope (same-scope hops).
   * Prevents infinite loops within a domain. Default: 5.
   */
  readonly maxDelegationDepth?: number;
  /**
   * Audit severity for violations originating from this scope.
   * 'none' = silent, 'log' = append to scope_access_log, 'alert' = log + emit metric.
   * Default: 'log'.
   */
  readonly auditLevel?: 'none' | 'log' | 'alert';
}

// ── Cross-Scope Policies ──────────────────────────────────────────────────────

/**
 * A rule that permits or denies one scope delegating work to another.
 *
 * Without a matching policy the system defaults to DENY (allowlist model).
 * The special `toScope: '*'` creates a wildcard rule that matches any target —
 * useful for the 'system' scope which orchestrates everything.
 */
export interface ScopeCrossPolicy {
  /** The scope initiating the delegation (e.g. 'analytics') */
  readonly fromScope: string;
  /**
   * The scope receiving the delegation.
   * '*' is a wildcard — matches any scope not covered by a more-specific rule.
   */
  readonly toScope: string;
  /** Whether the delegation is permitted */
  readonly allowed: boolean;
  /**
   * When true, the delegation MUST go through the A2A protocol with a valid
   * CrossScopeToken. Direct/implicit invocation is blocked even if allowed=true.
   * This ensures every cross-scope call is visible, logged, and revocable.
   */
  readonly requiresA2A?: boolean;
  /**
   * How many additional hops the delegation chain may grow by when crossing
   * this boundary. Separate from the within-scope maxDelegationDepth.
   * Default: 1 (one cross-scope hop per policy match).
   */
  readonly maxDelegationDepth?: number;
  /**
   * Additional conditions that must ALL be true for the delegation to proceed.
   * Even if `allowed` is true, failing any condition blocks the call.
   */
  readonly conditions?: readonly ScopePolicyCondition[];
  /** Audit level for events matching this specific policy */
  readonly auditLevel?: 'none' | 'log' | 'alert';
}

/**
 * A condition that must be satisfied before a cross-scope policy fires.
 *
 * Conditions let you build graduated access:
 *   - Allow kaggle→analytics only when explicitly requested by the user
 *   - Allow analytics→code only when a task correlation ID exists
 *   - Require HITL approval before any scope crossing to 'system'
 */
export type ScopePolicyCondition =
  /** User message must clearly express intent to use the target domain */
  | { readonly type: 'user-explicit-intent'; readonly minScore: number }
  /** A task correlation ID must be present (ensures traceability) */
  | { readonly type: 'task-correlation'; readonly required: true }
  /** HITL approval must have been granted before this crossing */
  | { readonly type: 'hitl-approved'; readonly required: true }
  /** Total delegation chain depth must be below this threshold */
  | { readonly type: 'max-hops'; readonly value: number };

// ── Runtime Scope Context ─────────────────────────────────────────────────────

/**
 * An entry in the delegation chain — immutable record of a single scope crossing.
 *
 * The full chain is carried in ScopeContext.delegationChain, providing a
 * complete audit trail of how a request travelled across domain boundaries.
 */
export interface ScopeDelegationEntry {
  /** Source scope (who delegated) */
  readonly fromScope: string;
  /** Destination scope (who received) */
  readonly toScope: string;
  /** Unix milliseconds timestamp of the crossing */
  readonly timestamp: number;
  /** Short description of why this delegation happened */
  readonly reason: string;
  /** Task correlation ID if available */
  readonly taskId?: string;
  /** ID of the CrossScopeToken that authorized this crossing */
  readonly tokenId?: string;
}

/**
 * Runtime security context carried through an agent's execution chain.
 *
 * Analogous to a SecurityContext in a web request pipeline — every
 * operation checks this before proceeding. Created at the root of each
 * conversation and narrowed/extended as agents delegate across scopes.
 *
 * Key invariant: currentScope can only be changed by issuing a CrossScopeToken
 * and calling deriveScopeContext(). There is no way to widen scope without
 * a policy match and a valid token.
 */
export interface ScopeContext {
  /** The scope this agent is currently operating within */
  readonly currentScope: string;
  /** Chain of delegations that led to this context (first = root, last = most recent) */
  readonly delegationChain: readonly ScopeDelegationEntry[];
  /** Stable session identifier grouping all calls in one user conversation */
  readonly sessionId: string;
  /** Task identifier — used as the bound claim on CrossScopeTokens */
  readonly taskId: string;
  /**
   * When this context expires, in Unix milliseconds.
   * Prevents stale scope contexts from persisting across session boundaries.
   */
  readonly expiresAt: number;
  /**
   * Resolved effective permissions accumulated through the delegation chain.
   * Format: "<scope>:<action>" (e.g. "code:execute", "analytics:read").
   * Permissions cannot exceed what the original root scope holds.
   */
  readonly permissions: readonly string[];
}

// ── Cross-Scope Tokens ────────────────────────────────────────────────────────

/**
 * A short-lived, cryptographically signed authorization ticket for one
 * cross-scope delegation.
 *
 * Modelled after OAuth 2.1 access tokens but simpler:
 *   - Bound to a specific fromScope→toScope pair
 *   - Bound to a specific taskId + sessionId (non-transferable)
 *   - Carries an explicit permissions list (least-privilege)
 *   - HMAC-SHA256 signed (prevents tampering without a DB lookup)
 *   - Expires after 10 minutes by default
 *
 * Security properties:
 *   - An agent cannot grant scopes it does not possess (no scope widening)
 *   - A token from scope A→B cannot be used for A→C (bound claim)
 *   - An expired token is rejected even if the signature is valid
 */
export interface CrossScopeToken {
  /** UUID v4 — unique identifier for this token */
  readonly id: string;
  /** The scope that issued this token (delegating authority) */
  readonly fromScope: string;
  /** The scope this token grants access to */
  readonly toScope: string;
  /** The task this token is bound to — must match ScopeContext.taskId */
  readonly taskId: string;
  /** The session this token is bound to — must match ScopeContext.sessionId */
  readonly sessionId: string;
  /** Permissions granted by this token */
  readonly permissions: readonly string[];
  /** Unix ms timestamp of issuance */
  readonly issuedAt: number;
  /** Unix ms timestamp of expiry (default: issuedAt + 10 minutes) */
  readonly expiresAt: number;
  /**
   * HMAC-SHA256 over a canonical JSON payload of the above fields (excluding
   * the signature field itself). Validated on every cross-scope check.
   */
  readonly signature: string;
}

// ── Policy Evaluation Results ─────────────────────────────────────────────────

/**
 * The verdict returned by ScopeGuard after evaluating a scope policy.
 *
 * When allowed=false, the caller should either:
 *   - Block the operation and return an informative error
 *   - Log the violation (always recommended even when not blocking)
 *
 * When allowed=true and requiresA2A=true, the caller MUST:
 *   - Issue a CrossScopeToken via issueCrossScopeToken()
 *   - Make the delegation via the A2A protocol (not a direct call)
 *   - Log the delegation in scope_access_log
 */
export interface ScopeCheckResult {
  /** Whether the operation is permitted */
  readonly allowed: boolean;
  /** Human-readable explanation — safe to include in error messages */
  readonly reason?: string;
  /**
   * The operation is allowed BUT only via the A2A protocol with a valid
   * CrossScopeToken. True when the policy has requiresA2A=true.
   */
  readonly requiresA2A?: boolean;
  /**
   * The class of violation, when allowed=false.
   * Recorded in scope_access_log and used for security monitoring metrics.
   */
  readonly violationType?:
    | 'scope-boundary'     // no policy permits this crossing (implicit deny)
    | 'explicit-deny'      // a policy explicitly denies this crossing
    | 'delegation-depth'   // chain depth exceeds the policy or scope limit
    | 'expired-context'    // ScopeContext.expiresAt has passed
    | 'confused-deputy'    // attempted to escalate to a privileged scope
    | 'no-policy'          // no policy for this pair; using default-deny
    | 'condition-failed'   // a policy condition was not satisfied
    | 'a2a-required';      // allowed but A2A protocol was bypassed
}

// ── Audit Events ──────────────────────────────────────────────────────────────

/**
 * An event emitted by the scope system to the audit log.
 *
 * The audit log is append-only and should never be modified or deleted.
 * It answers: "Who tried to cross which boundary, when, and was it allowed?"
 */
export interface ScopeAccessEvent {
  /** Unique event ID (UUID v4) */
  readonly id: string;
  /** Type of scope event */
  readonly eventType:
    | 'skill_activation'       // a skill was activated (scope check on skill.agenticScope)
    | 'cross_scope_delegation' // a cross-scope delegation was attempted
    | 'tool_invocation'        // a tool was invoked (scope check on tool's allowed scopes)
    | 'violation';             // any of the above failed the scope check
  readonly fromScope?: string;
  readonly toScope?: string;
  readonly skillId?: string;
  readonly toolName?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly userId?: string;
  /** Whether the operation was permitted */
  readonly allowed: boolean;
  /** Short reason for the decision */
  readonly reason?: string;
  /** Serialized delegation chain at the time of the event */
  readonly delegationChainJson?: string;
  /** ISO 8601 timestamp */
  readonly createdAt: string;
}
