/**
 * Phase 4 — reducer HITL approval support.
 *
 * approval.request → a pending approval + a `requires-action` part;
 * approval.resolved → approved/denied/modified. Positive, negative, security.
 */
import { describe, it, expect } from 'vitest';
import { streamReducer, emptyRunViewModel } from './index.js';
import type { RunEventEnvelope, RunViewModel, ApprovalPart } from './index.js';

let SEQ = 0;
function apply(vm: RunViewModel, kind: string, payload: Record<string, unknown>): RunViewModel {
  return streamReducer(vm, { runId: 'r1', sequence: SEQ++, kind, payload } as RunEventEnvelope);
}
function fresh(): RunViewModel { SEQ = 0; return emptyRunViewModel(); }
const appPart = (vm: RunViewModel, taskId: string): ApprovalPart | undefined =>
  vm.parts.find((p): p is ApprovalPart => p.type === 'approval' && p.taskId === taskId);

describe('reducer — approval request', () => {
  it('records a pending approval + a requires-action part (positive)', () => {
    let vm = fresh();
    vm = apply(vm, 'approval.request', { taskId: 't1', toolName: 'send_email', title: 'Approve send_email', riskLevel: 'medium', actions: [{ label: 'Approve', value: 'approve' }] });
    expect(vm.approvals).toHaveLength(1);
    expect(vm.approvals[0]).toMatchObject({ taskId: 't1', toolName: 'send_email', status: 'pending' });
    expect(appPart(vm, 't1')!.state).toBe('requires-action');
    expect(appPart(vm, 't1')!.toolName).toBe('send_email');
  });

  it('synthesizes an id when taskId is absent (negative/robustness)', () => {
    let vm = fresh();
    vm = apply(vm, 'approval.request', { toolName: 'x' });
    expect(vm.approvals).toHaveLength(1);
    expect(vm.approvals[0]!.taskId).toMatch(/^approval-/);
  });

  it('upserts a repeated request for the same taskId', () => {
    let vm = fresh();
    vm = apply(vm, 'approval.request', { taskId: 't1', toolName: 'a' });
    vm = apply(vm, 'approval.request', { taskId: 't1', toolName: 'a' });
    expect(vm.approvals).toHaveLength(1);
  });
});

describe('reducer — approval resolution', () => {
  function withPending(): RunViewModel {
    let vm = fresh();
    vm = apply(vm, 'approval.request', { taskId: 't1', toolName: 'send_email' });
    return vm;
  }

  it('approve → approved (positive)', () => {
    let vm = withPending();
    vm = apply(vm, 'approval.resolved', { taskId: 't1', action: 'approve' });
    expect(vm.approvals[0]!.status).toBe('approved');
    expect(appPart(vm, 't1')!.state).toBe('approved');
  });

  it('reject → denied', () => {
    let vm = withPending();
    vm = apply(vm, 'approval.resolved', { taskId: 't1', action: 'reject' });
    expect(vm.approvals[0]!.status).toBe('denied');
    expect(appPart(vm, 't1')!.state).toBe('denied');
  });

  it('modify → modified', () => {
    let vm = withPending();
    vm = apply(vm, 'approval.resolved', { taskId: 't1', action: 'modify' });
    expect(vm.approvals[0]!.status).toBe('modified');
    expect(appPart(vm, 't1')!.state).toBe('modified');
  });

  it('an unknown action defaults to denied (security)', () => {
    let vm = withPending();
    vm = apply(vm, 'approval.resolved', { taskId: 't1', action: 'sneaky' });
    expect(vm.approvals[0]!.status).toBe('denied');
  });

  it('resolution for an unknown taskId is a harmless no-op (negative)', () => {
    let vm = withPending();
    vm = apply(vm, 'approval.resolved', { taskId: 'nope', action: 'approve' });
    expect(vm.approvals[0]!.status).toBe('pending'); // untouched
  });
});

describe('reducer — approval integration', () => {
  it('keeps two concurrent approvals independent', () => {
    let vm = fresh();
    vm = apply(vm, 'approval.request', { taskId: 'a', toolName: 'x' });
    vm = apply(vm, 'approval.request', { taskId: 'b', toolName: 'y' });
    vm = apply(vm, 'approval.resolved', { taskId: 'b', action: 'approve' });
    expect(vm.approvals.find((a) => a.taskId === 'a')!.status).toBe('pending');
    expect(vm.approvals.find((a) => a.taskId === 'b')!.status).toBe('approved');
    expect(appPart(vm, 'a')!.state).toBe('requires-action');
    expect(appPart(vm, 'b')!.state).toBe('approved');
  });

  it('does not mutate prior state (purity)', () => {
    const base = fresh();
    const next = apply(base, 'approval.request', { taskId: 't1', toolName: 'x' });
    expect(base.approvals).toHaveLength(0);
    expect(next.approvals).toHaveLength(1);
  });

  it('ignores a duplicate sequence (idempotent)', () => {
    let vm = emptyRunViewModel();
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'approval.request', payload: { taskId: 't1', toolName: 'x' } });
    vm = streamReducer(vm, { runId: 'r1', sequence: 0, kind: 'approval.request', payload: { taskId: 't1', toolName: 'x' } });
    expect(vm.approvals).toHaveLength(1);
  });
});
