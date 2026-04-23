/**
 * @weaveintel/human-tasks — Unit tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHumanTask,
  createApprovalTask,
  createReviewTask,
  createEscalationTask,
  InMemoryTaskQueue,
  RepositoryBackedTaskQueue,
  JsonFileHumanTaskRepository,
  DecisionLog,
  createDecision,
  PolicyEvaluator,
  createPolicy,
} from '../index.js';

// ─── Task factories ──────────────────────────────────────────

describe('createHumanTask', () => {
  it('creates a task with defaults', () => {
    const task = createHumanTask({ type: 'approval', title: 'Approve deploy' });
    expect(task.id).toBeDefined();
    expect(task.type).toBe('approval');
    expect(task.title).toBe('Approve deploy');
    expect(task.status).toBe('pending');
    expect(task.priority).toBe('normal');
    expect(task.createdAt).toBeDefined();
  });

  it('sets optional fields', () => {
    const task = createHumanTask({
      type: 'review',
      title: 'Review output',
      description: 'Check quality',
      priority: 'urgent',
      assignee: 'alice',
      data: { key: 'val' },
      workflowRunId: 'wf-1',
      workflowStepId: 'step-2',
      slaDeadline: '2099-01-01T00:00:00Z',
    });
    expect(task.priority).toBe('urgent');
    expect(task.assignee).toBe('alice');
    expect(task.data).toEqual({ key: 'val' });
    expect(task.workflowRunId).toBe('wf-1');
    expect(task.slaDeadline).toBe('2099-01-01T00:00:00Z');
  });
});

describe('createApprovalTask', () => {
  it('creates an approval task', () => {
    const task = createApprovalTask({
      title: 'Approve action',
      action: 'deploy',
      context: { env: 'prod' },
      riskLevel: 'high',
    });
    expect(task.type).toBe('approval');
    expect(task.data.action).toBe('deploy');
    expect(task.data.context).toEqual({ env: 'prod' });
    expect(task.data.riskLevel).toBe('high');
    expect(task.result).toBeUndefined();
  });
});

describe('createReviewTask', () => {
  it('creates a review task', () => {
    const task = createReviewTask({
      title: 'Review doc',
      content: 'Hello world',
      contentType: 'text',
      criteria: ['grammar', 'accuracy'],
    });
    expect(task.type).toBe('review');
    expect(task.data.content).toBe('Hello world');
    expect(task.data.criteria).toEqual(['grammar', 'accuracy']);
  });
});

describe('createEscalationTask', () => {
  it('creates an escalation task with high priority by default', () => {
    const task = createEscalationTask({
      title: 'Escalation',
      reason: 'Agent failed',
      agentId: 'agent-1',
    });
    expect(task.type).toBe('escalation');
    expect(task.priority).toBe('high');
    expect(task.data.reason).toBe('Agent failed');
    expect(task.data.agentId).toBe('agent-1');
  });
});

// ─── InMemoryTaskQueue ───────────────────────────────────────

describe('InMemoryTaskQueue', () => {
  let queue: InMemoryTaskQueue;

  beforeEach(() => {
    queue = new InMemoryTaskQueue();
  });

  it('enqueues and retrieves a task', async () => {
    const task = await queue.enqueue({
      type: 'approval',
      title: 'Test',
      status: 'pending',
      priority: 'normal',
    });
    expect(task.id).toBeDefined();
    expect(task.createdAt).toBeDefined();
    const got = await queue.get(task.id);
    expect(got?.title).toBe('Test');
  });

  it('dequeues by priority (urgent first)', async () => {
    await queue.enqueue({ type: 'review', title: 'Low', status: 'pending', priority: 'low' });
    await queue.enqueue({ type: 'review', title: 'Urgent', status: 'pending', priority: 'urgent' });
    await queue.enqueue({ type: 'review', title: 'High', status: 'pending', priority: 'high' });
    const task = await queue.dequeue('bob');
    expect(task?.title).toBe('Urgent');
    expect(task?.status).toBe('assigned');
    expect(task?.assignee).toBe('bob');
  });

  it('returns null when no pending tasks', async () => {
    const task = await queue.dequeue('bob');
    expect(task).toBeNull();
  });

  it('lists tasks with filters', async () => {
    await queue.enqueue({ type: 'approval', title: 'A', status: 'pending', priority: 'normal' });
    await queue.enqueue({ type: 'review', title: 'B', status: 'pending', priority: 'high' });
    const approvals = await queue.list({ type: ['approval'] });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.title).toBe('A');
  });

  it('completes a task with decision', async () => {
    const task = await queue.enqueue({ type: 'approval', title: 'C', status: 'pending', priority: 'normal' });
    await queue.complete(task.id, {
      taskId: task.id,
      decidedBy: 'alice',
      decision: 'approved',
      decidedAt: new Date().toISOString(),
    });
    const completed = await queue.get(task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.completedAt).toBeDefined();
  });

  it('throws when completing a terminal task', async () => {
    const task = await queue.enqueue({ type: 'approval', title: 'D', status: 'pending', priority: 'normal' });
    await queue.expire(task.id);
    await expect(queue.complete(task.id, {
      taskId: task.id, decidedBy: 'x', decision: 'y', decidedAt: new Date().toISOString(),
    })).rejects.toThrow('already in terminal state');
  });

  it('expires a task', async () => {
    const task = await queue.enqueue({ type: 'review', title: 'E', status: 'pending', priority: 'normal' });
    await queue.expire(task.id);
    const expired = await queue.get(task.id);
    expect(expired?.status).toBe('expired');
  });

  it('expireOverdue expires past-SLA tasks', async () => {
    await queue.enqueue({
      type: 'approval',
      title: 'Overdue',
      status: 'pending',
      priority: 'normal',
      slaDeadline: '2000-01-01T00:00:00Z', // well in the past
    });
    const count = await queue.expireOverdue();
    expect(count).toBe(1);
  });

  it('stats returns counts by status', async () => {
    await queue.enqueue({ type: 'approval', title: 'X', status: 'pending', priority: 'normal' });
    await queue.enqueue({ type: 'approval', title: 'Y', status: 'pending', priority: 'high' });
    await queue.dequeue('bob'); // assigns one
    const stats = await queue.stats();
    expect(stats['pending']).toBe(1);
    expect(stats['assigned']).toBe(1);
  });
});

// ─── DecisionLog ─────────────────────────────────────────────

describe('DecisionLog', () => {
  let log: DecisionLog;

  beforeEach(() => {
    log = new DecisionLog();
  });

  it('records and retrieves decisions', () => {
    const task = createHumanTask({ type: 'approval', title: 'Test' });
    const decision = createDecision(task.id, 'alice', 'approved', { reason: 'Looks good' });
    log.record(task, decision);
    expect(log.getByTask(task.id)).toHaveLength(1);
    expect(log.getByDecider('alice')).toHaveLength(1);
    expect(log.getAll()).toHaveLength(1);
  });

  it('clear empties the log', () => {
    const task = createHumanTask({ type: 'review', title: 'T' });
    log.record(task, createDecision(task.id, 'bob', 'rejected'));
    log.clear();
    expect(log.getAll()).toHaveLength(0);
  });
});

describe('createDecision', () => {
  it('creates a decision with timestamp', () => {
    const d = createDecision('task-1', 'alice', 'approved', { reason: 'OK', data: { note: 'yes' } });
    expect(d.taskId).toBe('task-1');
    expect(d.decidedBy).toBe('alice');
    expect(d.decision).toBe('approved');
    expect(d.reason).toBe('OK');
    expect(d.data).toEqual({ note: 'yes' });
    expect(d.decidedAt).toBeDefined();
  });
});

// ─── PolicyEvaluator ─────────────────────────────────────────

describe('PolicyEvaluator', () => {
  let evaluator: PolicyEvaluator;

  beforeEach(() => {
    evaluator = new PolicyEvaluator();
  });

  it('returns not required when no policies', () => {
    const result = evaluator.check({ trigger: 'deploy' });
    expect(result.required).toBe(false);
  });

  it('matches a specific trigger', () => {
    const policy = createPolicy({ name: 'Deploy Gate', trigger: 'deploy', taskType: 'approval' });
    evaluator.addPolicy(policy);
    const result = evaluator.check({ trigger: 'deploy' });
    expect(result.required).toBe(true);
    expect(result.policy?.name).toBe('Deploy Gate');
  });

  it('does not match different trigger', () => {
    evaluator.addPolicy(createPolicy({ name: 'Deploy Gate', trigger: 'deploy', taskType: 'approval' }));
    const result = evaluator.check({ trigger: 'search' });
    expect(result.required).toBe(false);
  });

  it('wildcard * matches any trigger', () => {
    evaluator.addPolicy(createPolicy({ name: 'Global', trigger: '*', taskType: 'review' }));
    const result = evaluator.check({ trigger: 'anything' });
    expect(result.required).toBe(true);
  });

  it('skips disabled policies', () => {
    evaluator.addPolicy(createPolicy({ name: 'Disabled', trigger: '*', taskType: 'approval', enabled: false }));
    const result = evaluator.check({ trigger: 'anything' });
    expect(result.required).toBe(false);
  });

  it('removePolicy removes by id', () => {
    const p = createPolicy({ name: 'X', trigger: 'x', taskType: 'approval' });
    evaluator.addPolicy(p);
    expect(evaluator.listPolicies()).toHaveLength(1);
    evaluator.removePolicy(p.id);
    expect(evaluator.listPolicies()).toHaveLength(0);
  });

  it('computeSlaDeadline returns ISO string', () => {
    const p = createPolicy({ name: 'SLA', trigger: 'x', taskType: 'approval', slaHours: 4 });
    const d = evaluator.computeSlaDeadline(p, new Date('2025-01-01T00:00:00Z'));
    expect(d).toBe('2025-01-01T04:00:00.000Z');
  });

  it('computeSlaDeadline returns undefined when no slaHours', () => {
    const p = createPolicy({ name: 'No SLA', trigger: 'x', taskType: 'review' });
    expect(evaluator.computeSlaDeadline(p)).toBeUndefined();
  });
});

describe('createPolicy', () => {
  it('creates a policy with defaults', () => {
    const p = createPolicy({ name: 'Test', trigger: 'tool_call', taskType: 'approval' });
    expect(p.id).toBeDefined();
    expect(p.name).toBe('Test');
    expect(p.trigger).toBe('tool_call');
    expect(p.taskType).toBe('approval');
    expect(p.defaultPriority).toBe('normal');
    expect(p.assignmentStrategy).toBe('round-robin');
    expect(p.enabled).toBe(true);
  });
});

// ─── Phase 3C: InMemoryTaskQueue.reject() ───────────────────

describe('InMemoryTaskQueue.reject()', () => {
  let queue: InMemoryTaskQueue;

  beforeEach(() => {
    queue = new InMemoryTaskQueue();
  });

  it('rejects a pending task and sets status to rejected', async () => {
    const task = await queue.enqueue({ type: 'approval', title: 'Reject Me', status: 'pending', priority: 'normal' });
    await queue.reject(task.id, {
      taskId: task.id,
      decidedBy: 'manager',
      decision: 'rejected',
      reason: 'Not acceptable',
      decidedAt: new Date().toISOString(),
    });
    const updated = await queue.get(task.id);
    expect(updated?.status).toBe('rejected');
    expect(updated?.completedAt).toBeDefined();
  });

  it('rejects an assigned task', async () => {
    const task = await queue.enqueue({ type: 'review', title: 'Assigned Task', status: 'pending', priority: 'normal' });
    await queue.dequeue('reviewer'); // assigns it
    await queue.reject(task.id, {
      taskId: task.id,
      decidedBy: 'reviewer',
      decision: 'rejected',
      decidedAt: new Date().toISOString(),
    });
    const updated = await queue.get(task.id);
    expect(updated?.status).toBe('rejected');
  });

  it('throws when rejecting a task that is already in terminal state', async () => {
    const task = await queue.enqueue({ type: 'approval', title: 'Done', status: 'pending', priority: 'normal' });
    await queue.expire(task.id);
    await expect(queue.reject(task.id, {
      taskId: task.id,
      decidedBy: 'x',
      decision: 'rejected',
      decidedAt: new Date().toISOString(),
    })).rejects.toThrow('already in terminal state');
  });

  it('throws when rejecting a nonexistent task', async () => {
    await expect(queue.reject('nonexistent-id', {
      taskId: 'nonexistent-id',
      decidedBy: 'x',
      decision: 'rejected',
      decidedAt: new Date().toISOString(),
    })).rejects.toThrow('not found');
  });
});

describe('Phase 3D durable human-task state extraction', () => {
  it('persists tasks in JsonFileHumanTaskRepository across queue instances', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ht-repo-'));
    const filePath = join(tempDir, 'tasks.json');

    try {
      const repoA = new JsonFileHumanTaskRepository(filePath);
      const queueA = new RepositoryBackedTaskQueue(repoA);

      const created = await queueA.enqueue({
        type: 'approval',
        title: 'Approve deployment',
        status: 'pending',
        priority: 'high',
      });

      const repoB = new JsonFileHumanTaskRepository(filePath);
      const queueB = new RepositoryBackedTaskQueue(repoB);

      const loaded = await queueB.get(created.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.title).toBe('Approve deployment');

      const claimed = await queueB.dequeue('alice');
      expect(claimed?.assignee).toBe('alice');
      expect(claimed?.status).toBe('assigned');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

