import { describe, it, expect } from 'vitest';
import {
  approveBreakGlass,
  denyBreakGlass,
  reapExpiredBreakGlass,
  findActiveGrant,
  validateNewBreakGlassRequest,
  MAX_GRANT_WINDOW_MS,
  MIN_GRANT_WINDOW_MS,
  DEFAULT_GRANT_WINDOW_MS,
  type BreakGlassRequest,
} from './break-glass.js';

const NOW = 1_700_000_000_000;

function makeRequest(overrides: Partial<BreakGlassRequest> = {}): BreakGlassRequest {
  return {
    id: 'req-1',
    tenantId: 'tenant-1',
    requestedBy: 'operator@weave.ai',
    reason: 'Production incident — data recovery',
    status: 'pending',
    customerApprover: null,
    approvedAt: null,
    expiresAt: NOW + DEFAULT_GRANT_WINDOW_MS,
    consumeCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

// ── approveBreakGlass ──────────────────────────────────────────

describe('approveBreakGlass', () => {
  it('transitions pending → approved', () => {
    const { approved, transition } = approveBreakGlass({
      request: makeRequest(),
      customerApprover: 'ciso@customer.com',
      now: NOW,
    });
    expect(approved.status).toBe('approved');
    expect(approved.customerApprover).toBe('ciso@customer.com');
    expect(approved.approvedAt).toBe(NOW);
    expect(transition.from).toBe('pending');
    expect(transition.to).toBe('approved');
  });

  it('throws when request is not pending', () => {
    expect(() =>
      approveBreakGlass({ request: makeRequest({ status: 'approved' }), customerApprover: 'x' }),
    ).toThrow("'approved'");
  });

  it('prevents self-approval', () => {
    expect(() =>
      approveBreakGlass({
        request: makeRequest(),
        customerApprover: 'operator@weave.ai',
        now: NOW,
      }),
    ).toThrow('dual approval');
  });

  it('caps window at MAX_GRANT_WINDOW_MS', () => {
    const { approved } = approveBreakGlass({
      request: makeRequest(),
      customerApprover: 'ciso@customer.com',
      windowMs: MAX_GRANT_WINDOW_MS * 10,
      now: NOW,
    });
    expect(approved.expiresAt - NOW).toBe(MAX_GRANT_WINDOW_MS);
  });

  it('enforces MIN_GRANT_WINDOW_MS floor', () => {
    const { approved } = approveBreakGlass({
      request: makeRequest(),
      customerApprover: 'ciso@customer.com',
      windowMs: 1,
      now: NOW,
    });
    expect(approved.expiresAt - NOW).toBe(MIN_GRANT_WINDOW_MS);
  });
});

// ── denyBreakGlass ���────────────────────────────────────────────

describe('denyBreakGlass', () => {
  it('transitions pending → denied', () => {
    const { denied, transition } = denyBreakGlass({
      request: makeRequest(),
      deniedBy: 'ciso@customer.com',
    });
    expect(denied.status).toBe('denied');
    expect(transition.from).toBe('pending');
    expect(transition.to).toBe('denied');
  });

  it('includes note in reason when provided', () => {
    const { transition } = denyBreakGlass({
      request: makeRequest(),
      deniedBy: 'ciso@customer.com',
      note: 'Policy violation',
    });
    expect(transition.reason).toContain('Policy violation');
  });

  it('throws when request is not pending', () => {
    expect(() =>
      denyBreakGlass({ request: makeRequest({ status: 'denied' }), deniedBy: 'x' }),
    ).toThrow("'denied'");
  });
});

// ── reapExpiredBreakGlass ──────────────────────────────────────

describe('reapExpiredBreakGlass', () => {
  it('marks expired pending requests', () => {
    const expired = makeRequest({ expiresAt: NOW - 1 });
    const transitions = reapExpiredBreakGlass([expired], NOW);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.to).toBe('expired');
    expect(transitions[0]!.from).toBe('pending');
  });

  it('marks expired approved requests', () => {
    const expired = makeRequest({ status: 'approved', expiresAt: NOW - 1 });
    const transitions = reapExpiredBreakGlass([expired], NOW);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.from).toBe('approved');
  });

  it('does not reap non-expired requests', () => {
    const active = makeRequest({ expiresAt: NOW + 1_000 });
    expect(reapExpiredBreakGlass([active], NOW)).toHaveLength(0);
  });

  it('does not reap already-terminal states', () => {
    const denied = makeRequest({ status: 'denied', expiresAt: NOW - 1 });
    const consumed = makeRequest({ status: 'consumed', expiresAt: NOW - 1 });
    expect(reapExpiredBreakGlass([denied, consumed], NOW)).toHaveLength(0);
  });
});

// ── findActiveGrant ────────────────────────────────────────────

describe('findActiveGrant', () => {
  it('returns an approved, non-expired grant for the correct tenant', () => {
    const grant = makeRequest({ status: 'approved', expiresAt: NOW + 10_000 });
    const found = findActiveGrant({ requests: [grant], tenantId: 'tenant-1', now: NOW });
    expect(found).not.toBeNull();
    expect(found!.id).toBe('req-1');
  });

  it('returns null for expired grants', () => {
    const grant = makeRequest({ status: 'approved', expiresAt: NOW - 1 });
    expect(findActiveGrant({ requests: [grant], tenantId: 'tenant-1', now: NOW })).toBeNull();
  });

  it('returns null for a different tenant', () => {
    const grant = makeRequest({ status: 'approved', expiresAt: NOW + 10_000 });
    expect(findActiveGrant({ requests: [grant], tenantId: 'tenant-2', now: NOW })).toBeNull();
  });

  it('returns null when no approved grants exist', () => {
    const pending = makeRequest({ status: 'pending', expiresAt: NOW + 10_000 });
    expect(findActiveGrant({ requests: [pending], tenantId: 'tenant-1', now: NOW })).toBeNull();
  });
});

// ── validateNewBreakGlassRequest ───────────────────────────────

describe('validateNewBreakGlassRequest', () => {
  it('returns expiresAt with the default window', () => {
    const { expiresAt, windowMs } = validateNewBreakGlassRequest({
      tenantId: 'tenant-1',
      requestedBy: 'op@weave.ai',
      reason: 'Incident response required',
      now: NOW,
    });
    expect(windowMs).toBe(DEFAULT_GRANT_WINDOW_MS);
    expect(expiresAt).toBe(NOW + DEFAULT_GRANT_WINDOW_MS);
  });

  it('throws on missing tenantId', () => {
    expect(() =>
      validateNewBreakGlassRequest({ tenantId: '', requestedBy: 'op', reason: 'valid reason' }),
    ).toThrow('tenantId');
  });

  it('throws on missing requestedBy', () => {
    expect(() =>
      validateNewBreakGlassRequest({ tenantId: 't', requestedBy: '', reason: 'valid reason' }),
    ).toThrow('requestedBy');
  });

  it('throws on reason shorter than 8 chars', () => {
    expect(() =>
      validateNewBreakGlassRequest({ tenantId: 't', requestedBy: 'op', reason: 'short' }),
    ).toThrow('reason');
  });

  it('caps window at MAX_GRANT_WINDOW_MS', () => {
    const { windowMs } = validateNewBreakGlassRequest({
      tenantId: 't',
      requestedBy: 'op',
      reason: 'long enough reason',
      windowMs: MAX_GRANT_WINDOW_MS * 2,
      now: NOW,
    });
    expect(windowMs).toBe(MAX_GRANT_WINDOW_MS);
  });
});
