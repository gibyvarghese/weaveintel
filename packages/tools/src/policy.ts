/**
 * @weaveintel/tools — Tool Policy Enforcement
 *
 * Phase 2 of the Tool Platform. Provides:
 *  - ToolPolicyResolver interface (DB-backed in GeneWeave, in-memory for tests)
 *  - ToolAuditEmitter interface (DB-backed in GeneWeave, noop for tests)
 *  - ToolRateLimiter & ToolApprovalGate interfaces
 *  - resolveEffectivePolicy() — merges policy sources in precedence order
 *  - createPolicyEnforcedTool() — wraps a single Tool with enforcement
 *  - createPolicyEnforcedRegistry() — wraps an entire ToolRegistry
 */

import type {
  Tool,
  ToolInput,
  ToolOutput,
  ToolRegistry,
  ToolRiskLevel,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';
import type {
  EffectiveToolPolicy,
  ToolAuditEvent,
  ToolAuditOutcome,
  ToolPolicyViolationReason,
} from '@weaveintel/core';
import type { ToolHealthTracker } from './registry.js';

// ─── Resolution Context ──────────────────────────────────────

export interface PolicyResolutionContext {
  /** Persona of the executing agent (influences risk level gate). */
  agentPersona?: string;
  /** If a skill is active, its tool_policy_key overrides global policy. */
  skillPolicyKey?: string;
  /** Chat ID for per-chat rate limit scoping. */
  chatId?: string;
  /** User ID for per-user audit records. */
  userId?: string;
}

// ─── ToolPolicyResolver ──────────────────────────────────────

/**
 * Contract for looking up the effective policy for a tool.
 * GeneWeave supplies a DB-backed implementation (DbToolPolicyResolver).
 * Tests use InMemoryToolPolicyResolver.
 */
export interface ToolPolicyResolver {
  resolve(toolName: string, context?: PolicyResolutionContext): Promise<EffectiveToolPolicy>;
}

/** Default pass-through policy (no restrictions). */
export const DEFAULT_TOOL_POLICY: EffectiveToolPolicy = {
  enabled: true,
  riskLevel: 'read-only',
  requiresApproval: false,
  requireDryRun: false,
  logInputOutput: false,
  allowedRiskLevels: ['read-only', 'write', 'destructive', 'privileged', 'financial', 'external-side-effect'],
  source: 'default',
};

/** In-memory resolver for tests and dev environments (no DB required). */
export class InMemoryToolPolicyResolver implements ToolPolicyResolver {
  constructor(
    private readonly policies: Map<string, Partial<EffectiveToolPolicy>> = new Map(),
  ) {}

  async resolve(toolName: string): Promise<EffectiveToolPolicy> {
    const override = this.policies.get(toolName) ?? this.policies.get('*');
    return {
      ...DEFAULT_TOOL_POLICY,
      source: override ? 'global_policy' : 'default',
      ...override,
    };
  }
}

// ─── ToolAuditEmitter ────────────────────────────────────────

/**
 * Contract for persisting tool audit events.
 * GeneWeave implements this against the tool_audit_events table.
 */
export interface ToolAuditEmitter {
  emit(event: ToolAuditEvent): Promise<void>;
}

/** No-op emitter — used when audit persistence is not required. */
export const noopAuditEmitter: ToolAuditEmitter = {
  async emit(): Promise<void> {},
};

// ─── ToolRateLimiter ─────────────────────────────────────────

/**
 * Contract for per-tool, per-scope rate limiting.
 * GeneWeave implements this using a sliding window in SQLite.
 */
export interface ToolRateLimiter {
  /** Returns true if the call is allowed (increments the counter). */
  check(toolName: string, scopeKey: string, limitPerMinute: number): Promise<boolean>;
  remaining(toolName: string, scopeKey: string, limitPerMinute: number): Promise<number>;
}

// ─── ToolApprovalGate ────────────────────────────────────────

export type ApprovalDecision =
  | { status: 'approved' }
  | { status: 'pending'; approvalRequestId: string }
  | { status: 'denied'; reason: string };

/**
 * Contract for blocking tool execution pending human approval.
 * GeneWeave integrates this with the existing human_task_policies table.
 */
export interface ToolApprovalGate {
  check(toolName: string, chatId: string, input: ToolInput): Promise<ApprovalDecision>;
}

// ─── ToolPolicyViolationError ────────────────────────────────

export class ToolPolicyViolationError extends Error {
  public override readonly name = 'ToolPolicyViolationError';

  constructor(
    public readonly toolName: string,
    public readonly reason: ToolPolicyViolationReason,
    public readonly policy: EffectiveToolPolicy,
    message?: string,
  ) {
    super(message ?? `Tool '${toolName}' invocation denied: ${reason}`);
  }
}

// ─── resolveEffectivePolicy ──────────────────────────────────

/**
 * Merges multiple policy sources in precedence order.
 * Precedence (highest wins): personaOverride > skillOverride > globalPolicy > catalogEntry > DEFAULT
 */
export function resolveEffectivePolicy(
  catalogEntry?: Partial<EffectiveToolPolicy>,
  globalPolicy?: Partial<EffectiveToolPolicy>,
  skillOverride?: Partial<EffectiveToolPolicy>,
  personaOverride?: Partial<EffectiveToolPolicy>,
): EffectiveToolPolicy {
  const source: EffectiveToolPolicy['source'] =
    personaOverride ? 'persona_override'
    : skillOverride ? 'skill_override'
    : globalPolicy ? 'global_policy'
    : 'default';

  return {
    ...DEFAULT_TOOL_POLICY,
    ...catalogEntry,
    ...globalPolicy,
    ...skillOverride,
    ...personaOverride,
    source,
  };
}

// ─── createPolicyEnforcedTool ────────────────────────────────

export interface PolicyEnforcedToolOptions {
  resolver: ToolPolicyResolver;
  auditEmitter?: ToolAuditEmitter;
  healthTracker?: ToolHealthTracker;
  rateLimiter?: ToolRateLimiter;
  approvalGate?: ToolApprovalGate;
  resolutionContext?: PolicyResolutionContext;
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Wraps a single Tool with policy enforcement.
 * Enforcement sequence:
 *   1. Resolve effective policy
 *   2. Check if tool is enabled
 *   3. Check circuit breaker
 *   4. Check risk level gate
 *   5. Check approval gate
 *   6. Check rate limit
 *   7. Execute with optional timeout
 *   8. Record health stats and emit audit event
 */
export function createPolicyEnforcedTool(
  tool: Tool,
  opts: PolicyEnforcedToolOptions,
): Tool {
  const emitter = opts.auditEmitter ?? noopAuditEmitter;

  async function buildAuditEvent(
    outcome: ToolAuditOutcome,
    durationMs: number,
    extra?: {
      violationReason?: ToolPolicyViolationReason;
      input?: ToolInput;
      output?: ToolOutput;
      errorMessage?: string;
      policyId?: string;
    },
  ): Promise<ToolAuditEvent> {
    const ctx = opts.resolutionContext;
    const previewify = (v: unknown): string | undefined => {
      if (v === undefined) return undefined;
      try {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 4000 ? s.slice(0, 4000) + '...[truncated]' : s;
      } catch {
        return String(v).slice(0, 4000);
      }
    };
    return {
      toolName: tool.schema.name,
      chatId: ctx?.chatId,
      userId: ctx?.userId,
      agentPersona: ctx?.agentPersona,
      skillKey: ctx?.skillPolicyKey,
      policyId: extra?.policyId,
      outcome,
      violationReason: extra?.violationReason,
      durationMs,
      createdAt: new Date().toISOString(),
      errorMessage: extra?.errorMessage,
      inputPreview: previewify(extra?.input),
      outputPreview: previewify(extra?.output),
    };
  }

  const enforcedInvoke = async (input: ToolInput, ctx: ExecutionContext): Promise<ToolOutput> => {
    const policy = await opts.resolver.resolve(tool.schema.name, opts.resolutionContext);
    const scopeKey = opts.resolutionContext?.chatId ?? 'global';

    // 1. Enabled check
    if (!policy.enabled) {
      await emitter.emit(await buildAuditEvent('denied_policy', 0, { violationReason: 'disabled', policyId: policy.policyId }));
      throw new ToolPolicyViolationError(tool.schema.name, 'disabled', policy);
    }

    // 2. Circuit breaker check
    if (opts.healthTracker?.isCircuitOpen(tool.schema.name)) {
      await emitter.emit(await buildAuditEvent('circuit_open', 0, { violationReason: 'circuit_open', policyId: policy.policyId }));
      throw new ToolPolicyViolationError(tool.schema.name, 'circuit_open', policy);
    }

    // 3. Risk level gate — check the tool's own risk level against allowed levels
    const toolRiskLevel = (tool.schema as { riskLevel?: ToolRiskLevel }).riskLevel ?? 'read-only';
    if (!policy.allowedRiskLevels.includes(toolRiskLevel)) {
      await emitter.emit(await buildAuditEvent('denied_policy', 0, { violationReason: 'risk_level_blocked', policyId: policy.policyId }));
      throw new ToolPolicyViolationError(tool.schema.name, 'risk_level_blocked', policy);
    }

    // 4. Approval gate
    if (policy.requiresApproval && opts.approvalGate) {
      const chatId = opts.resolutionContext?.chatId ?? '';
      const decision = await opts.approvalGate.check(tool.schema.name, chatId, input);
      if (decision.status !== 'approved') {
        await emitter.emit(await buildAuditEvent('denied_approval', 0, { violationReason: 'approval_required', policyId: policy.policyId }));
        throw new ToolPolicyViolationError(
          tool.schema.name,
          'approval_required',
          policy,
          decision.status === 'pending' ? `Approval pending: ${decision.approvalRequestId}` : `Approval denied: ${decision.reason}`,
        );
      }
    }

    // 5. Rate limit check
    if (policy.rateLimitPerMinute && opts.rateLimiter) {
      const allowed = await opts.rateLimiter.check(tool.schema.name, scopeKey, policy.rateLimitPerMinute);
      if (!allowed) {
        await emitter.emit(await buildAuditEvent('denied_rate_limit', 0, { violationReason: 'rate_limited', policyId: policy.policyId }));
        throw new ToolPolicyViolationError(tool.schema.name, 'rate_limited', policy);
      }
    }

    // 6. Execute with optional timeout
    const startMs = Date.now();
    let timedOut = false;

    const invokePromise = tool.invoke(ctx, input);
    const timeoutMs = policy.timeoutMs;

    let result: ToolOutput;
    try {
      if (timeoutMs && timeoutMs > 0) {
        result = await Promise.race([
          invokePromise,
          new Promise<never>((_res, rej) =>
            setTimeout(() => {
              timedOut = true;
              rej(new Error(`Tool '${tool.schema.name}' timed out after ${timeoutMs}ms`));
            }, timeoutMs),
          ),
        ]);
      } else {
        result = await invokePromise;
      }
    } catch (err: unknown) {
      const durationMs = Date.now() - startMs;
      opts.healthTracker?.record(tool.schema.name, durationMs, true);
      if (timedOut) {
        await emitter.emit(await buildAuditEvent('timeout', durationMs, { policyId: policy.policyId, errorMessage: String(err) }));
        throw err;
      }
      await emitter.emit(await buildAuditEvent('error', durationMs, { policyId: policy.policyId, errorMessage: String(err) }));
      throw err;
    }

    const durationMs = Date.now() - startMs;
    // A tool may resolve normally yet still indicate failure via `isError: true`
    // (e.g. a sandboxed runner that returned a JSON error payload). Record that
    // as an error outcome so health metrics and audit dashboards reflect reality.
    const toolReportedError = !!result.isError;
    opts.healthTracker?.record(tool.schema.name, durationMs, toolReportedError);

    const outcome: ToolAuditOutcome = toolReportedError ? 'error' : 'success';
    const errorMessage = toolReportedError
      ? (typeof result.content === 'string' ? result.content : 'Tool reported isError=true').slice(0, 1000)
      : undefined;

    await emitter.emit(await buildAuditEvent(outcome, durationMs, {
      policyId: policy.policyId,
      input: policy.logInputOutput ? input : undefined,
      output: policy.logInputOutput ? result : undefined,
      errorMessage,
    }));

    return result;
  };

  return {
    schema: tool.schema,
    invoke: (ctx: ExecutionContext, input: ToolInput) => enforcedInvoke(input, ctx),
  };
}

// ─── createPolicyEnforcedRegistry ───────────────────────────

/**
 * Wraps an entire ToolRegistry, applying policy enforcement to every tool.
 * This is the primary integration point for GeneWeave.
 *
 * The returned registry is a new registry containing enforced versions of all
 * tools from the original. New tools registered after this call are NOT automatically
 * wrapped — call this after all tools have been registered.
 */
export function createPolicyEnforcedRegistry(
  registry: ToolRegistry,
  opts: PolicyEnforcedToolOptions,
): ToolRegistry {
  const enforcedRegistry = weaveToolRegistry();

  for (const tool of registry.list()) {
    enforcedRegistry.register(
      createPolicyEnforcedTool(tool, opts),
    );
  }

  return enforcedRegistry;
}
