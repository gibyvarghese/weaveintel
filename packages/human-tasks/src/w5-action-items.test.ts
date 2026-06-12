/**
 * W5 — @weaveintel/human-tasks action-item tests
 *
 * Covers:
 *  - createActionItem: always blocking=false, provenance required, dueAt optional
 *  - completeActionItem: status→completed, bus event with provenance
 *  - cancelActionItem: status→rejected, bus event with provenance
 *  - listByAssignee: returns only tasks for that principal
 *  - Regression: approval tasks still have blocking=undefined (not forced false)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createActionItem,
  completeActionItem,
  cancelActionItem,
  createApprovalTask,
} from './index.js';
import { InMemoryHumanTaskRepository } from './repository.js';

// ---------------------------------------------------------------------------
// createActionItem
// ---------------------------------------------------------------------------

describe('createActionItem', () => {
  it('creates with blocking=false', () => {
    const task = createActionItem({
      title: 'Follow up on report',
      provenance: { createdBy: 'agent', sourceRunId: 'run-1', sourceRef: 'step-3' },
    });
    expect(task.type).toBe('action-item');
    expect(task.blocking).toBe(false);
    expect(task.status).toBe('pending');
  });

  it('sets provenance', () => {
    const task = createActionItem({
      title: 'Action',
      provenance: { createdBy: 'system', sourceRunId: 'r2' },
    });
    expect(task.provenance?.createdBy).toBe('system');
    expect(task.provenance?.sourceRunId).toBe('r2');
  });

  it('sets dueAt when provided', () => {
    const due = '2025-12-31T00:00:00.000Z';
    const task = createActionItem({
      title: 'Review',
      provenance: { createdBy: 'agent' },
      dueAt: due,
    });
    expect(task.dueAt).toBe(due);
  });

  it('dueAt is undefined when not provided', () => {
    const task = createActionItem({
      title: 'Review',
      provenance: { createdBy: 'agent' },
    });
    expect(task.dueAt).toBeUndefined();
  });

  it('has a UUID id', () => {
    const task = createActionItem({ title: 'x', provenance: { createdBy: 'agent' } });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------
// completeActionItem
// ---------------------------------------------------------------------------

describe('completeActionItem', () => {
  it('marks as completed in repository', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const task = createActionItem({ title: 'Do it', provenance: { createdBy: 'agent' } });
    await repo.save(task);
    const updated = await completeActionItem(task.id, { repository: repo });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();
  });

  it('emits task.completed bus event with provenance', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const task = createActionItem({
      title: 'Do it',
      provenance: { createdBy: 'agent', sourceRunId: 'run-42' },
    });
    await repo.save(task);
    const emitted: { type: string; data: Record<string, unknown> }[] = [];
    const bus = { emit: (e: { type: string; data: Record<string, unknown> }) => { emitted.push(e); } };
    await completeActionItem(task.id, { repository: repo, bus, tenantId: 'tenant-a' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('task.completed');
    expect((emitted[0]?.data['provenance'] as Record<string, string>)?.['sourceRunId']).toBe('run-42');
  });

  it('throws if task not found', async () => {
    const repo = new InMemoryHumanTaskRepository();
    await expect(completeActionItem('nonexistent', { repository: repo })).rejects.toThrow('not found');
  });

  it('throws if task type is not action-item', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const approvalTask = createApprovalTask({
      title: 'Approve X',
      action: 'deploy',
      context: {},
    });
    await repo.save(approvalTask);
    await expect(completeActionItem(approvalTask.id, { repository: repo })).rejects.toThrow("not 'action-item'");
  });
});

// ---------------------------------------------------------------------------
// cancelActionItem
// ---------------------------------------------------------------------------

describe('cancelActionItem', () => {
  it('marks as rejected in repository', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const task = createActionItem({ title: 'Do it', provenance: { createdBy: 'agent' } });
    await repo.save(task);
    const updated = await cancelActionItem(task.id, { repository: repo });
    expect(updated.status).toBe('rejected');
  });

  it('emits task.cancelled bus event', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const task = createActionItem({ title: 'Do it', provenance: { createdBy: 'principal' } });
    await repo.save(task);
    const emitted: { type: string }[] = [];
    const bus = { emit: (e: { type: string }) => { emitted.push(e); } };
    await cancelActionItem(task.id, { repository: repo, bus });
    expect(emitted[0]?.type).toBe('task.cancelled');
  });

  it('throws if task not found', async () => {
    const repo = new InMemoryHumanTaskRepository();
    await expect(cancelActionItem('x', { repository: repo })).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// listByAssignee
// ---------------------------------------------------------------------------

describe('listByAssignee', () => {
  it('returns tasks for the given assignee', async () => {
    const repo = new InMemoryHumanTaskRepository();
    const t1 = createActionItem({ title: 'T1', provenance: { createdBy: 'agent' }, assignee: 'alice' });
    const t2 = createActionItem({ title: 'T2', provenance: { createdBy: 'agent' }, assignee: 'bob' });
    const t3 = createActionItem({ title: 'T3', provenance: { createdBy: 'agent' }, assignee: 'alice' });
    await repo.save(t1); await repo.save(t2); await repo.save(t3);
    const results = await repo.listByAssignee('alice');
    expect(results).toHaveLength(2);
    expect(results.every(t => t.assignee === 'alice')).toBe(true);
  });

  it('returns empty when assignee has no tasks', async () => {
    const repo = new InMemoryHumanTaskRepository();
    expect(await repo.listByAssignee('nobody')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: approval tasks retain their own lifecycle
// ---------------------------------------------------------------------------

describe('regression: approval task', () => {
  it('approval task does not have blocking=false', () => {
    const task = createApprovalTask({ title: 'Approve deploy', action: 'deploy', context: {} });
    expect(task.type).toBe('approval');
    // approval tasks don't set blocking — it should be undefined
    expect(task.blocking).toBeUndefined();
  });
});
