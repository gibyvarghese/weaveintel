/**
 * Live-Agents Phase 3 — Runtime-side `LiveAgentPolicy` factory.
 *
 * `weaveLiveAgentPolicy()` (in `@weaveintel/live-agents`) is the in-memory
 * constructor that takes already-built primitives. This file exposes the
 * runtime composition entry point for app-side consumers (geneweave).
 *
 * The factory is a thin assembler: it receives the four DB-backed adapters
 * (already implementing the `@weaveintel/tools` interfaces) and bundles
 * them into a `LiveAgentPolicy`. No DB types live in this package — apps
 * own the adapter constructors and inject the live instances here.
 *
 * Typical wiring in geneweave:
 *
 *   ```ts
 *   import {
 *     DbToolPolicyResolver,
 *     DbToolApprovalGate,
 *     DbToolRateLimiter,
 *     DbToolAuditEmitter,
 *   } from './tool-*.js'; // existing geneweave adapters
 *   import { weaveDbLiveAgentPolicy } from '@weaveintel/live-agents-runtime';
 *
 *   const policy = weaveDbLiveAgentPolicy({
 *     policyResolver: new DbToolPolicyResolver(db),
 *     approvalGate:   new DbToolApprovalGate(db),
 *     rateLimiter:    new DbToolRateLimiter(db),
 *     auditEmitter:   new DbToolAuditEmitter(db),
 *   });
 *
 *   await createHeartbeatSupervisor({ ..., policy });
 *   ```
 *
 * The same `policy` instance is safe to share across many supervisors and
 * many agents in a mesh — every primitive is expected to be effectively
 * stateless or DB-keyed.
 */

import {
  weaveLiveAgentPolicy,
  type LiveAgentPolicy,
} from '@weaveintel/live-agents';
import type {
  PolicyResolutionContext,
  ToolApprovalGate,
  ToolAuditEmitter,
  ToolPolicyResolver,
  ToolRateLimiter,
} from '@weaveintel/tools';

export interface WeaveDbLiveAgentPolicyOptions {
  /** Tool policy resolver (typically `DbToolPolicyResolver`). */
  policyResolver?: ToolPolicyResolver;
  /** Approval gate (typically `DbToolApprovalGate`). */
  approvalGate?: ToolApprovalGate;
  /** Rate limiter (typically `DbToolRateLimiter`). */
  rateLimiter?: ToolRateLimiter;
  /** Audit emitter (typically `DbToolAuditEmitter`). */
  auditEmitter?: ToolAuditEmitter;
  /**
   * Optional default `PolicyResolutionContext` applied to every per-tick
   * wrap. The handler always overrides `chatId` and `agentPersona` from
   * the live agent's identity, so this is for additional fields like
   * `skillPolicyKey` or `userId`.
   */
  defaultResolutionContext?: PolicyResolutionContext;
}

/**
 * Compose a `LiveAgentPolicy` from DB-backed adapters. Pure pass-through
 * to `weaveLiveAgentPolicy()` for now — separated so future versions can
 * add runtime-only concerns (telemetry, health checks on each adapter,
 * lazy DB hydration) without breaking the in-memory constructor.
 */
export function weaveDbLiveAgentPolicy(
  opts: WeaveDbLiveAgentPolicyOptions,
): LiveAgentPolicy {
  return weaveLiveAgentPolicy({
    ...(opts.policyResolver ? { policyResolver: opts.policyResolver } : {}),
    ...(opts.approvalGate ? { approvalGate: opts.approvalGate } : {}),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
    ...(opts.auditEmitter ? { auditEmitter: opts.auditEmitter } : {}),
    ...(opts.defaultResolutionContext
      ? { defaultResolutionContext: opts.defaultResolutionContext }
      : {}),
  });
}
