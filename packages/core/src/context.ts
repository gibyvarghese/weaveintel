/**
 * @weaveintel/core — Execution context
 *
 * Why: Every operation needs access to cancellation, tenant/user identity,
 * trace context, and request-scoped config. Instead of passing 10 parameters,
 * we propagate a single ExecutionContext.
 *
 * This is the backbone of multi-tenant awareness, observability, and cancellation.
 */

export interface ExecutionContext {
  /** Unique ID for this execution (trace root) */
  readonly executionId: string;

  /** Tenant isolation */
  readonly tenantId?: string;

  /** User identity for access control */
  readonly userId?: string;

  /** Abort signal for cancellation/timeout */
  readonly signal?: AbortSignal;

  /** Deadline timestamp (ms since epoch) */
  readonly deadline?: number;

  /** Parent span ID for trace continuity */
  readonly parentSpanId?: string;

  /** Arbitrary request-scoped metadata */
  readonly metadata: Readonly<Record<string, unknown>>;

  /** Budget constraints for this execution */
  readonly budget?: ExecutionBudget;
}

export interface ExecutionBudget {
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  readonly maxRetries?: number;
}

let idCounter = 0;

export function createExecutionContext(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    executionId: overrides.executionId ?? `exec_${Date.now()}_${++idCounter}`,
    tenantId: overrides.tenantId,
    userId: overrides.userId,
    signal: overrides.signal,
    deadline: overrides.deadline,
    parentSpanId: overrides.parentSpanId,
    metadata: overrides.metadata ?? {},
    budget: overrides.budget,
  };
}

/** Create a child context inheriting parent's signal and metadata */
export function childContext(
  parent: ExecutionContext,
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    ...parent,
    executionId: overrides.executionId ?? parent.executionId,
    parentSpanId: overrides.parentSpanId ?? parent.parentSpanId,
    metadata: { ...parent.metadata, ...overrides.metadata },
    budget: overrides.budget ?? parent.budget,
  };
}

/** Check if an execution context has expired */
export function isExpired(ctx: ExecutionContext): boolean {
  if (ctx.signal?.aborted) return true;
  if (ctx.deadline != null && Date.now() > ctx.deadline) return true;
  return false;
}

/** Create an AbortSignal that fires at the deadline */
export function deadlineSignal(ctx: ExecutionContext): AbortSignal | undefined {
  if (ctx.deadline == null) return ctx.signal;
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) return AbortSignal.abort('Deadline exceeded');
  const timeoutSignal = AbortSignal.timeout(remaining);
  if (!ctx.signal) return timeoutSignal;
  return AbortSignal.any([ctx.signal, timeoutSignal]);
}
