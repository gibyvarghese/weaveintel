/**
 * Live-Agents Phase 3 — `LiveAgentPolicy` first-class capability.
 *
 * Mirrors `weaveAgent`'s `policy: AgentPolicy` slot but for live agents
 * (multi-tick, persistent, supervised). A `LiveAgentPolicy` is a single
 * injectable bundle that composes the four tool-policy primitives from
 * `@weaveintel/tools`:
 *
 *   - `policyResolver` — resolves the effective policy per tool call
 *     (default merging, skill overrides, persona overrides). Also gates
 *     `enabled`, `riskLevel`, `requiresApproval`, `requireDryRun`.
 *   - `approvalGate`   — blocks a tool invocation pending human approval
 *     when policy.requiresApproval is true.
 *   - `rateLimiter`    — bounds calls per (tool, scope) per minute.
 *   - `auditEmitter`   — persists every invocation outcome.
 *
 * When a `LiveAgentPolicy` is supplied to `createAgenticTaskHandler`, the
 * handler wraps the per-tick `tools` registry with
 * `createPolicyEnforcedRegistry()` automatically — domain code never needs
 * to thread the four primitives through prepare() / handler / runtime.
 *
 * Construction:
 *
 *   ```ts
 *   import { weaveLiveAgentPolicy } from '@weaveintel/live-agents';
 *
 *   const policy = weaveLiveAgentPolicy({
 *     policyResolver: dbToolPolicyResolver,
 *     approvalGate:   dbToolApprovalGate,
 *     rateLimiter:    dbToolRateLimiter,
 *     auditEmitter:   dbToolAuditEmitter,
 *     // Optional: default resolution context applied to every call.
 *     defaultResolutionContext: { agentPersona: 'kaggle-strategist' },
 *   });
 *   ```
 *
 * Every primitive is optional — pass only the ones you need. A policy with
 * no fields set behaves like no policy at all. A policy with only an
 * `auditEmitter` enables audit-only mode (everything still runs but every
 * call is recorded).
 */

import type {
  ToolPolicyResolver,
  ToolApprovalGate,
  ToolRateLimiter,
  ToolAuditEmitter,
  PolicyResolutionContext,
} from '@weaveintel/tools';

// ─── LiveAgentPolicy ─────────────────────────────────────────

export interface LiveAgentPolicy {
  /** Tool-policy resolver (gates `enabled`, `riskLevel`, etc). */
  policyResolver?: ToolPolicyResolver;
  /** Human-approval gate for tools where `policy.requiresApproval` is true. */
  approvalGate?: ToolApprovalGate;
  /** Per-tool, per-scope rate limiter. */
  rateLimiter?: ToolRateLimiter;
  /** Audit event emitter — persists every invocation outcome. */
  auditEmitter?: ToolAuditEmitter;
  /**
   * Default `PolicyResolutionContext` applied to every per-tick wrap.
   * The handler will merge `{ chatId: agent.id, agentPersona: handler.name }`
   * over the top so per-call chat/persona scoping always wins.
   */
  defaultResolutionContext?: PolicyResolutionContext;
}

// ─── weaveLiveAgentPolicy ────────────────────────────────────

/**
 * User-facing constructor for a `LiveAgentPolicy`.
 *
 * Today it's a tiny pass-through (the interface IS the contract). The
 * factory shape is preserved so future versions can validate the bundle,
 * register telemetry, or accept `weaveLiveAgentPolicy(...polices)` for
 * composition without breaking callers.
 */
export function weaveLiveAgentPolicy(opts: LiveAgentPolicy): LiveAgentPolicy {
  return {
    ...(opts.policyResolver ? { policyResolver: opts.policyResolver } : {}),
    ...(opts.approvalGate ? { approvalGate: opts.approvalGate } : {}),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
    ...(opts.auditEmitter ? { auditEmitter: opts.auditEmitter } : {}),
    ...(opts.defaultResolutionContext
      ? { defaultResolutionContext: opts.defaultResolutionContext }
      : {}),
  };
}

/** True if any of the four primitives is set. Useful for guard branches. */
export function hasAnyPolicyCapability(p: LiveAgentPolicy | undefined): boolean {
  if (!p) return false;
  return Boolean(p.policyResolver || p.approvalGate || p.rateLimiter || p.auditEmitter);
}
