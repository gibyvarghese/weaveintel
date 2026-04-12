/**
 * Example 16 — Human-in-the-Loop Tasks
 *
 * Demonstrates:
 *  • Creating approval, review, and escalation tasks
 *  • Task queue with enqueue/dequeue/complete workflow
 *  • Decision logging with audit trail
 *  • Policy evaluator for automatic HITL triggers
 *  • SLA deadline computation
 *
 * WeaveIntel packages used:
 *   @weaveintel/human-tasks — Human oversight for AI-driven workflows:
 *     • createApprovalTask() / createReviewTask() / createEscalationTask()
 *       — Factory functions for typed task objects (with risk level, priority, assignee)
 *     • InMemoryTaskQueue    — FIFO queue with enqueue/dequeue/complete lifecycle
 *     • DecisionLog          — Append-only audit log of all HITL decisions
 *     • PolicyEvaluator      — Rule engine that decides when a task needs human review
 *                              vs. auto-approval based on risk, cost, and context
 *
 * No API keys needed — uses in-memory task primitives.
 *
 * Run: npx tsx examples/16-human-in-the-loop.ts
 */

import {
  createApprovalTask,
  createReviewTask,
  createEscalationTask,
  createHumanTask,
  createDecision,
  createPolicy,
  InMemoryTaskQueue,
  DecisionLog,
  PolicyEvaluator,
} from '@weaveintel/human-tasks';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Create different task types ───────────────────── */

header('1. Create Human Tasks');

// createApprovalTask() creates a typed task with riskLevel, estimatedImpact,
// and assignee fields — designed for high-stakes actions (deployments,
// financial ops) that need explicit human sign-off before proceeding.
const approval = createApprovalTask({
  title: 'Deploy to Production',
  description: 'Approve production deployment of v2.3.0',
  action: 'deploy-to-production',
  context: { version: '2.3.0', environment: 'production', changedFiles: 42 },
  riskLevel: 'high',
  estimatedImpact: 'All production users affected',
  priority: 'high',
  assignee: 'lead-engineer',
});
console.log(`  Approval: "${approval.title}" (${approval.type}, priority: ${approval.priority})`);

// createReviewTask() creates a content-review task with criteria[]
// that the reviewer uses as a checklist (accuracy, completeness, tone, etc.).
const review = createReviewTask({
  title: 'Review AI Response Quality',
  description: 'Review the quality of AI-generated summaries',
  content: 'The quarterly report shows a 15% increase in revenue...',
  contentType: 'text/plain',
  criteria: ['accuracy', 'completeness', 'tone', 'no-hallucinations'],
  originalInput: 'Summarize the Q3 financial report',
  priority: 'medium',
});
console.log(`  Review: "${review.title}" (${review.type}, criteria: ${(review.data as any)?.criteria?.length ?? 0})`);

// createEscalationTask() is for agent failures — captures agentId,
// failureDetails, and reason to help the on-call engineer diagnose.
const escalation = createEscalationTask({
  title: 'Agent Stuck in Loop',
  description: 'Agent exceeded max iterations without resolution',
  reason: 'Max iterations (50) exceeded without satisfying exit condition',
  agentId: 'research-agent-v2',
  failureDetails: 'Loop detected between search and summarize steps',
  priority: 'critical',
});
console.log(`  Escalation: "${escalation.title}" (${escalation.type}, priority: ${escalation.priority})`);

const genericTask = createHumanTask({
  type: 'input',
  title: 'Provide Missing Context',
  description: 'Agent needs additional context to proceed',
  priority: 'medium',
  data: { question: 'What is the target audience for this document?', options: ['technical', 'business', 'general'] },
});
console.log(`  Generic: "${genericTask.title}" (${genericTask.type})`);

/* ── 2. Task Queue ────────────────────────────────────── */

header('2. Task Queue — Enqueue & Process');

// InMemoryTaskQueue is a FIFO queue with assignee-aware dequeue.
// enqueue() stamps an id + createdAt; dequeue(assignee) returns the
// highest-priority pending task for that assignee; complete() archives it.
const queue = new InMemoryTaskQueue();

// Enqueue tasks
const queued1 = await queue.enqueue({
  type: approval.type,
  title: approval.title,
  description: approval.description,
  priority: approval.priority,
  assignee: 'lead-engineer',
  status: 'pending',
  data: approval.data,
});
console.log(`  Enqueued: "${queued1.title}" (id: ${queued1.id})`);

const queued2 = await queue.enqueue({
  type: review.type,
  title: review.title,
  description: review.description,
  priority: review.priority,
  assignee: 'qa-reviewer',
  status: 'pending',
  data: review.data,
});
console.log(`  Enqueued: "${queued2.title}" (id: ${queued2.id})`);

const queued3 = await queue.enqueue({
  type: escalation.type,
  title: escalation.title,
  description: escalation.description,
  priority: escalation.priority,
  assignee: 'on-call-engineer',
  status: 'pending',
  data: escalation.data,
});
console.log(`  Enqueued: "${queued3.title}" (id: ${queued3.id})`);

// List tasks
const allTasks = await queue.list();
console.log(`\n  Total tasks in queue: ${allTasks.length}`);

// Dequeue for a specific assignee
const nextTask = await queue.dequeue('lead-engineer');
if (nextTask) console.log(`  Dequeued for lead-engineer: "${nextTask.title}"`);

// Get stats
const stats = await queue.stats();
console.log(`  Queue stats: ${JSON.stringify(stats)}`);

/* ── 3. Complete Tasks with Decisions ─────────────────── */

header('3. Task Decisions');

const approvalDecision = createDecision(queued1.id, 'lead-engineer', 'approved', {
  reason: 'All tests passing, change set reviewed',
  data: { reviewedAt: new Date().toISOString() },
});
console.log(`  Decision for "${queued1.title}": ${approvalDecision.decision} by ${approvalDecision.decidedBy}`);

const reviewDecision = createDecision(queued2.id, 'qa-reviewer', 'approved', {
  reason: 'Response quality meets criteria — accurate, complete, appropriate tone',
});
console.log(`  Decision for "${queued2.title}": ${reviewDecision.decision}`);

const escalationDecision = createDecision(queued3.id, 'on-call-engineer', 'resolved', {
  reason: 'Fixed by adding max-depth guard and fallback response',
  data: { fix: 'Added circuit breaker with 10-step limit' },
});
console.log(`  Decision for "${queued3.title}": ${escalationDecision.decision}`);

// Complete tasks in queue
await queue.complete(queued1.id, approvalDecision);
await queue.complete(queued2.id, reviewDecision);
await queue.complete(queued3.id, escalationDecision);

const remainingTasks = await queue.list({ status: 'pending' });
console.log(`\n  Remaining pending tasks: ${remainingTasks.length}`);

/* ── 4. Decision Log ──────────────────────────────────── */

header('4. Decision Log — Audit Trail');

// DecisionLog is an append-only audit trail: record() stores the
// task + decision + timestamp. getAll() and getByDecider() support
// compliance reporting and post-hoc review of human decisions.
const log = new DecisionLog();

log.record(queued1, approvalDecision);
log.record(queued2, reviewDecision);
log.record(queued3, escalationDecision);

const allDecisions = log.getAll();
console.log(`  Total decisions logged: ${allDecisions.length}`);
for (const d of allDecisions) {
  console.log(`    [${d.taskType}] "${d.taskTitle}" → ${d.decision} by ${d.decidedBy}${d.reason ? ' — ' + d.reason.slice(0, 50) : ''}`);
}

const engineerDecisions = log.getByDecider('lead-engineer');
console.log(`\n  Decisions by lead-engineer: ${engineerDecisions.length}`);

/* ── 5. Policy Evaluator ──────────────────────────────── */

header('5. Policy Evaluator — Auto HITL Triggers');

// PolicyEvaluator checks incoming context against registered policies.
// Each policy specifies a trigger ('high-risk', 'low-confidence', 'financial'),
// a taskType to create, slaHours for response deadlines, and an optional
// autoEscalateAfterHours for timeout-based escalation.
const evaluator = new PolicyEvaluator();

evaluator.addPolicy(createPolicy({
  name: 'High Risk Approval',
  description: 'Require human approval for high-risk actions',
  trigger: 'high-risk',
  taskType: 'approval',
  defaultPriority: 'high',
  slaHours: 4,
  autoEscalateAfterHours: 8,
}));

evaluator.addPolicy(createPolicy({
  name: 'Low Confidence Review',
  description: 'Require review when confidence is below threshold',
  trigger: 'low-confidence',
  taskType: 'review',
  defaultPriority: 'medium',
  slaHours: 24,
}));

evaluator.addPolicy(createPolicy({
  name: 'Financial Transactions',
  description: 'All financial operations need explicit approval',
  trigger: 'financial',
  taskType: 'approval',
  defaultPriority: 'critical',
  slaHours: 1,
  autoEscalateAfterHours: 2,
}));

const policyChecks = [
  { trigger: 'high-risk', riskLevel: 'high', confidence: 0.95 },
  { trigger: 'low-confidence', confidence: 0.3 },
  { trigger: 'financial', estimatedImpact: '$50,000 transaction' },
  { trigger: 'routine', confidence: 0.99 },
];

for (const check of policyChecks) {
  const result = evaluator.check(check);
  if (result.required) {
    const sla = result.policy ? evaluator.computeSlaDeadline(result.policy) : undefined;
    console.log(`  🛑 "${check.trigger}" → HITL required (${result.policy?.name})${sla ? ', SLA: ' + sla.slice(0, 19) : ''}`);
  } else {
    console.log(`  ✅ "${check.trigger}" → no HITL required`);
  }
}

const activePolicies = evaluator.listPolicies();
console.log(`\n  Active policies: ${activePolicies.length}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Approval, review, and escalation task creation');
console.log('✅ Task queue with enqueue/dequeue/complete');
console.log('✅ Decision recording with reason and metadata');
console.log('✅ Decision log for full audit trail');
console.log('✅ Policy evaluator for automatic HITL triggers');
console.log('✅ SLA deadline computation');
}

main().catch(console.error);
