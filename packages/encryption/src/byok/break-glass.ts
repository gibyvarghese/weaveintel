/**
 * @weaveintel/encryption — Break-glass evaluator.
 *
 * Pure functions over a `BreakGlassRequest[]` snapshot. Mirrors the design of
 * `alert-evaluator.ts`: no DB / IO, host owns persistence and routing. Evaluators
 * can be unit-tested deterministically and reused by any host that supplies a
 * compatible request shape.
 *
 * Lifecycle:
 *
 *   pending  → operator + customer dual-approve → approved
 *            → customer denies                  → denied
 *            → expires before either acts       → expired
 *   approved → consumed by an unwrap delegate   → consumed
 *            → grant TTL elapses                → expired
 *
 * The evaluator is responsible for surfacing transitions only — it returns
 * the *intended* next status; the caller persists. This keeps the package
 * host-agnostic.
 */

export type BreakGlassStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed';

export interface BreakGlassRequest {
  readonly id: string;
  readonly tenantId: string;
  /** Operator (weaveintel-side) who initiated. */
  readonly requestedBy: string;
  /** Free-form justification (audited verbatim). */
  readonly reason: string;
  readonly status: BreakGlassStatus;
  /** Customer principal that approved (e.g. "ciso@example.com"). */
  readonly customerApprover: string | null;
  readonly approvedAt: number | null;
  /**
   * When the grant becomes invalid. Operator picks at request time; the
   * approver may shorten on approval. Hard-capped by `MAX_GRANT_WINDOW_MS`
   * during evaluation.
   */
  readonly expiresAt: number;
  /** Counter — tracks how many times the grant has been consumed (audit). */
  readonly consumeCount: number;
  readonly createdAt: number;
}

export interface BreakGlassTransition {
  readonly id: string;
  readonly tenantId: string;
  readonly from: BreakGlassStatus;
  readonly to: BreakGlassStatus;
  readonly reason: string;
}

export const MAX_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
export const MIN_GRANT_WINDOW_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_GRANT_WINDOW_MS = 60 * 60 * 1000; // 1h

export interface ApproveBreakGlassInput {
  readonly request: BreakGlassRequest;
  readonly customerApprover: string;
  readonly windowMs?: number;
  readonly now?: number;
}

export interface ApproveBreakGlassResult {
  readonly approved: BreakGlassRequest;
  readonly transition: BreakGlassTransition;
}

/**
 * Apply the customer-side approval. Returns the new request shape (caller
 * persists) plus the transition for the audit log.
 */
export function approveBreakGlass(input: ApproveBreakGlassInput): ApproveBreakGlassResult {
  const { request, customerApprover } = input;
  if (request.status !== 'pending') {
    throw new Error(`Cannot approve break-glass request in status '${request.status}'`);
  }
  if (request.requestedBy === customerApprover) {
    throw new Error('Operator cannot self-approve break-glass — dual approval required');
  }
  const now = input.now ?? Date.now();
  const requestedWindow = input.windowMs ?? Math.max(MIN_GRANT_WINDOW_MS, request.expiresAt - now);
  const window = Math.min(MAX_GRANT_WINDOW_MS, Math.max(MIN_GRANT_WINDOW_MS, requestedWindow));
  const approved: BreakGlassRequest = {
    ...request,
    status: 'approved',
    customerApprover,
    approvedAt: now,
    expiresAt: now + window,
  };
  const transition: BreakGlassTransition = {
    id: request.id,
    tenantId: request.tenantId,
    from: 'pending',
    to: 'approved',
    reason: `customer ${customerApprover} approved (window=${window}ms)`,
  };
  return { approved, transition };
}

export interface DenyBreakGlassInput {
  readonly request: BreakGlassRequest;
  readonly deniedBy: string;
  readonly note?: string;
  readonly now?: number;
}

export function denyBreakGlass(input: DenyBreakGlassInput): {
  denied: BreakGlassRequest;
  transition: BreakGlassTransition;
} {
  const { request, deniedBy } = input;
  if (request.status !== 'pending') {
    throw new Error(`Cannot deny break-glass request in status '${request.status}'`);
  }
  const denied: BreakGlassRequest = { ...request, status: 'denied', customerApprover: deniedBy };
  return {
    denied,
    transition: {
      id: request.id,
      tenantId: request.tenantId,
      from: 'pending',
      to: 'denied',
      reason: input.note ? `denied by ${deniedBy}: ${input.note}` : `denied by ${deniedBy}`,
    },
  };
}

/**
 * Mark expired requests. Pure: returns transitions only — caller persists.
 * Useful for a periodic sweeper or for the admin /health endpoint.
 */
export function reapExpiredBreakGlass(
  requests: readonly BreakGlassRequest[],
  now: number = Date.now(),
): BreakGlassTransition[] {
  const out: BreakGlassTransition[] = [];
  for (const r of requests) {
    if (r.status === 'pending' || r.status === 'approved') {
      if (now >= r.expiresAt) {
        out.push({
          id: r.id,
          tenantId: r.tenantId,
          from: r.status,
          to: 'expired',
          reason: `grant expired at ${new Date(r.expiresAt).toISOString()}`,
        });
      }
    }
  }
  return out;
}

/**
 * Decide whether a request authorises an unwrap RIGHT NOW. Returns the
 * matching request (the caller increments `consumeCount` and persists) or
 * `null` if no grant applies.
 */
export function findActiveGrant(opts: {
  requests: readonly BreakGlassRequest[];
  tenantId: string;
  now?: number;
}): BreakGlassRequest | null {
  const now = opts.now ?? Date.now();
  return (
    opts.requests.find(
      (r) =>
        r.tenantId === opts.tenantId &&
        r.status === 'approved' &&
        r.expiresAt > now,
    ) ?? null
  );
}

export interface ValidateNewRequestInput {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly windowMs?: number;
  readonly now?: number;
}

/**
 * Validate inputs for a new break-glass request. Returns the canonical
 * `expiresAt` to persist. Throws on invalid inputs (caller surfaces 400).
 */
export function validateNewBreakGlassRequest(input: ValidateNewRequestInput): {
  expiresAt: number;
  windowMs: number;
} {
  if (!input.tenantId || typeof input.tenantId !== 'string') {
    throw new Error('break-glass request requires tenantId');
  }
  if (!input.requestedBy || typeof input.requestedBy !== 'string') {
    throw new Error('break-glass request requires requestedBy (operator id)');
  }
  if (!input.reason || input.reason.trim().length < 8) {
    throw new Error('break-glass request requires reason (≥8 chars) — audited verbatim');
  }
  const now = input.now ?? Date.now();
  const requested = input.windowMs ?? DEFAULT_GRANT_WINDOW_MS;
  const window = Math.min(MAX_GRANT_WINDOW_MS, Math.max(MIN_GRANT_WINDOW_MS, requested));
  return { expiresAt: now + window, windowMs: window };
}
