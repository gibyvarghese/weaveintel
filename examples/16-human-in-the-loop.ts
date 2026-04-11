/**
 * Example 16 — Human-in-the-Loop with Contracts
 *
 * Demonstrates:
 *  • Human task creation (approval, review, escalation)
 *  • Task queue with priority ordering
 *  • Decision logging with audit trail
 *  • Policy evaluation for automatic approvals
 *  • Completion contracts with evidence bundles
 *  • Agent with approval gates before executing risky tools
 *
 * No API keys needed — uses in-memory queues and fake model.
 *
 * Run: npx tsx examples/16-human-in-the-loop.ts
 */

import {
  createApprovalTask,
  createReviewTask,
  createEscalationTask,
  InMemoryTaskQueue,
  DecisionLog,
  createDecision,
  PolicyEvaluator,
  createPolicy,
} from '@weaveintel/human-tasks';

import {
  createContract,
  createEvidence,
  createEvidenceBundle,
  createCompletionReport,
  defineContract,
} from '@weaveintel/contracts';

import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Approval Tasks ────────────────────────────────── */

header('1. Create Approval Tasks');

const queue = new InMemoryTaskQueue();

// Data deletion requires manager approval
const deleteApproval = createApprovalTask({
  title: 'Delete customer records — ACME Corp',
  description: 'Request to permanently delete 1,200 customer records for ACME Corp per GDPR erasure request.',
  requester: 'agent-data-cleanup',
  approvers: ['manager-jane', 'compliance-officer'],
  priority: 'high',
  metadata: { customerId: 'acme-001', recordCount: 1200, regulation: 'GDPR Art. 17' },
});

// Model deployment requires team lead review
const deployApproval = createApprovalTask({
  title: 'Deploy fine-tuned model to production',
  description: 'Deploy customer-sentiment-v3 model after eval score of 0.92.',
  requester: 'agent-ml-pipeline',
  approvers: ['team-lead-bob'],
  priority: 'medium',
  metadata: { modelId: 'customer-sentiment-v3', evalScore: 0.92, stage: 'production' },
});

queue.enqueue(deleteApproval);
queue.enqueue(deployApproval);

console.log('Tasks in queue:');
for (const task of queue.list()) {
  console.log(`  📋 [${task.priority.toUpperCase()}] ${task.title}`);
  console.log(`     Requester: ${task.requester} | Approvers: ${task.approvers.join(', ')}`);
  console.log(`     Status: ${task.status}`);
}

/* ── 2. Review Tasks ──────────────────────────────────── */

header('2. Code Review Tasks');

const codeReview = createReviewTask({
  title: 'Review PR #247: Add context-window pruning',
  description: 'Agent-generated code for context-window pruning in the retrieval pipeline. Needs human verification before merge.',
  requester: 'agent-code-gen',
  reviewers: ['senior-dev-alice', 'senior-dev-charlie'],
  priority: 'medium',
  metadata: { prNumber: 247, filesChanged: 5, linesAdded: 180, linesRemoved: 30 },
  criteria: ['correctness', 'performance', 'test-coverage'],
});

queue.enqueue(codeReview);
console.log(`  📝 ${codeReview.title}`);
console.log(`     Reviewers: ${codeReview.reviewers.join(', ')}`);
console.log(`     Criteria: ${codeReview.criteria.join(', ')}`);

/* ── 3. Escalation Tasks ──────────────────────────────── */

header('3. Escalation Tasks');

const escalation = createEscalationTask({
  title: 'Agent stuck — ambiguous customer request',
  description: 'Customer asked "handle everything" — agent cannot determine scope without human clarification.',
  agent: 'support-agent-7',
  reason: 'Ambiguous request — cannot determine action scope',
  severity: 'high',
  context: {
    customerId: 'customer-42',
    conversationId: 'conv-8891',
    lastMessage: 'Just handle everything for me',
    agentAttempts: 3,
  },
});

queue.enqueue(escalation);
console.log(`  🚨 ${escalation.title}`);
console.log(`     Severity: ${escalation.severity} | Agent: ${escalation.agent}`);
console.log(`     Reason: ${escalation.reason}`);

/* ── 4. Decision Logging ──────────────────────────────── */

header('4. Decision Logging & Audit Trail');

const decisionLog = new DecisionLog();

// Simulate approvals and rejections
decisionLog.record(createDecision({
  taskId: deleteApproval.id,
  reviewer: 'manager-jane',
  decision: 'approved',
  reasoning: 'GDPR request verified. 30-day retention period elapsed. Approved for deletion.',
  timestamp: new Date().toISOString(),
}));

decisionLog.record(createDecision({
  taskId: deployApproval.id,
  reviewer: 'team-lead-bob',
  decision: 'rejected',
  reasoning: 'Eval score is good (0.92) but need A/B test results first. Requesting additional evidence.',
  timestamp: new Date().toISOString(),
}));

decisionLog.record(createDecision({
  taskId: codeReview.id,
  reviewer: 'senior-dev-alice',
  decision: 'approved_with_comments',
  reasoning: 'Logic is correct. Minor suggestion: extract the pruning threshold to a config param.',
  timestamp: new Date().toISOString(),
}));

console.log('Decision log:');
for (const d of decisionLog.list()) {
  const emoji = d.decision === 'approved' ? '✅'
    : d.decision === 'rejected' ? '❌'
    : '🟡';
  console.log(`  ${emoji} Task ${d.taskId.slice(0, 8)}... — ${d.decision} by ${d.reviewer}`);
  console.log(`     "${d.reasoning}"`);
}

/* ── 5. Automatic Policy Evaluation ───────────────────── */

header('5. Automatic Policy Evaluation');

const policyEvaluator = new PolicyEvaluator();

policyEvaluator.addPolicy(createPolicy({
  id: 'auto-approve-low-risk',
  name: 'Auto-approve low-risk read operations',
  check: (ctx) => {
    const risk = String(ctx['riskLevel'] || '');
    const action = String(ctx['action'] || '');
    if (risk === 'low' && /^(read|list|get)/.test(action)) {
      return { autoApprove: true, reason: 'Low-risk read operation — auto-approved' };
    }
    return { autoApprove: false };
  },
}));

policyEvaluator.addPolicy(createPolicy({
  id: 'block-prod-without-review',
  name: 'Block production changes without review',
  check: (ctx) => {
    const env = String(ctx['environment'] || '');
    const hasReview = Boolean(ctx['hasReview']);
    if (env === 'production' && !hasReview) {
      return { autoApprove: false, block: true, reason: 'Production changes require review' };
    }
    return { autoApprove: false };
  },
}));

const policyTests = [
  { action: 'read_logs', riskLevel: 'low', environment: 'staging', hasReview: false },
  { action: 'delete_records', riskLevel: 'high', environment: 'production', hasReview: false },
  { action: 'deploy_model', riskLevel: 'medium', environment: 'production', hasReview: true },
  { action: 'list_users', riskLevel: 'low', environment: 'production', hasReview: false },
];

for (const test of policyTests) {
  const result = policyEvaluator.evaluate(test);
  const icon = result.autoApprove ? '🟢 Auto-approved' : result.block ? '🔴 Blocked' : '🟡 Needs human review';
  console.log(`  ${icon}: ${test.action} (${test.riskLevel} risk, ${test.environment})`);
  if (result.reason) console.log(`     ${result.reason}`);
}

/* ── 6. Completion Contracts ──────────────────────────── */

header('6. Completion Contracts with Evidence');

const contract = defineContract({
  id: 'data-deletion-contract',
  name: 'GDPR Data Deletion Contract',
  version: '1.0',
  tasks: [
    { id: 'verify-identity', name: 'Verify requester identity', required: true },
    { id: 'backup-data', name: 'Create backup before deletion', required: true },
    { id: 'delete-records', name: 'Delete records from all stores', required: true },
    { id: 'verify-deletion', name: 'Verify records are gone', required: true },
    { id: 'notify-requester', name: 'Notify requester of completion', required: true },
  ],
  acceptance: {
    allRequired: true,
    minEvidence: 3,
  },
});

console.log(`Contract: ${contract.name} v${contract.version}`);
console.log(`Tasks: ${contract.tasks.map(t => t.name).join(' → ')}`);

// Create evidence for each task
const evidenceBundle = createEvidenceBundle([
  createEvidence({
    taskId: 'verify-identity',
    type: 'document',
    description: 'GDPR erasure request document verified',
    data: { requestId: 'gdpr-2025-001', verifiedBy: 'compliance-officer', verifiedAt: new Date().toISOString() },
  }),
  createEvidence({
    taskId: 'backup-data',
    type: 'artifact',
    description: 'Backup created in cold storage',
    data: { backupId: 'bk-acme-20250412', location: 's3://backups/acme/', sizeBytes: 45_000_000 },
  }),
  createEvidence({
    taskId: 'delete-records',
    type: 'log',
    description: 'Deletion confirmed across 3 data stores',
    data: { stores: ['primary-db', 'search-index', 'cache'], deletedCount: 1200, timestamp: new Date().toISOString() },
  }),
  createEvidence({
    taskId: 'verify-deletion',
    type: 'test',
    description: 'Verification queries returned 0 results',
    data: { queries: 3, resultsFound: 0, verifiedAt: new Date().toISOString() },
  }),
  createEvidence({
    taskId: 'notify-requester',
    type: 'notification',
    description: 'Email sent to requester confirming deletion',
    data: { recipient: 'legal@acme.com', sentAt: new Date().toISOString(), templateId: 'gdpr-completion' },
  }),
]);

console.log(`\nEvidence bundle: ${evidenceBundle.items.length} items`);
for (const ev of evidenceBundle.items) {
  console.log(`  📎 [${ev.type}] ${ev.description}`);
}

// Generate completion report
const report = createCompletionReport(contract, evidenceBundle);
console.log(`\nCompletion report:`);
console.log(`  Status: ${report.complete ? '✅ COMPLETE' : '❌ INCOMPLETE'}`);
console.log(`  Tasks completed: ${report.completedTasks}/${report.totalTasks}`);
console.log(`  Evidence items: ${report.evidenceCount}`);

/* ── 7. Agent with Approval Gates ─────────────────────── */

header('7. Agent with Approval-Gated Tool Calls');

const ctx = weaveContext({ userId: 'agent-system', timeout: 30_000 });

// The approval queue acts as a gate
const approvalQueue = new InMemoryTaskQueue();
const approvalLog = new DecisionLog();

const tools = weaveToolRegistry();
tools.register(
  weaveTool({
    name: 'read_customer_data',
    description: 'Read customer data (low risk, auto-approved)',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
    execute: async (args) => {
      console.log(`    🟢 Auto-approved: reading customer ${args['customerId']}`);
      return JSON.stringify({ id: args['customerId'], name: 'ACME Corp', plan: 'Enterprise' });
    },
  }),
);
tools.register(
  weaveTool({
    name: 'delete_customer_data',
    description: 'Delete customer data (high risk, requires approval)',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' }, reason: { type: 'string' } },
      required: ['customerId', 'reason'],
    },
    execute: async (args) => {
      // Create approval task
      const task = createApprovalTask({
        title: `Delete data for ${args['customerId']}`,
        description: `Reason: ${args['reason']}`,
        requester: 'agent-system',
        approvers: ['manager'],
        priority: 'high',
      });
      approvalQueue.enqueue(task);
      // Simulate immediate approval
      approvalLog.record(createDecision({
        taskId: task.id,
        reviewer: 'manager',
        decision: 'approved',
        reasoning: 'GDPR compliance — approved',
        timestamp: new Date().toISOString(),
      }));
      console.log(`    ⏳ Approval requested and granted for deleting ${args['customerId']}`);
      return JSON.stringify({ status: 'approved_and_executed', deletedRecords: 1200 });
    },
  }),
);

const agentModel = weaveFakeModel({
  responses: [
    // Step 1: Read customer data first
    JSON.stringify({
      content: null,
      toolCalls: [{ id: 'tc1', name: 'read_customer_data', arguments: '{"customerId":"acme-001"}' }],
    }),
    // Step 2: Proceed with deletion
    JSON.stringify({
      content: null,
      toolCalls: [{ id: 'tc2', name: 'delete_customer_data', arguments: '{"customerId":"acme-001","reason":"GDPR erasure request"}' }],
    }),
    // Step 3: Final response
    'I\'ve completed the GDPR data deletion for ACME Corp (acme-001):\n\n1. **Verified** the customer record exists (Enterprise plan)\n2. **Submitted** a deletion request which was approved by the manager\n3. **Deleted** 1,200 records per the GDPR erasure request\n\nThe operation has been logged for compliance audit.',
  ],
});

const agent = weaveAgent({
  model: agentModel,
  tools,
  systemPrompt: 'You are a compliance agent. For read operations, proceed directly. For deletions, the tool will handle the approval workflow.',
  maxSteps: 4,
});

console.log('Agent processing: "Delete all ACME Corp data per GDPR request"\n');
const result = await agent.run(
  { messages: [{ role: 'user', content: 'Process GDPR erasure request for customer acme-001 (ACME Corp)' }] },
  ctx,
);

console.log(`\nAgent steps: ${result.steps?.length || 'N/A'}`);
console.log(`Approval tasks created: ${approvalQueue.list().length}`);
console.log(`Decisions logged: ${approvalLog.list().length}`);
console.log(`\nFinal response:\n${result.content}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Approval, review, and escalation task types');
console.log('✅ Priority task queue with ordering');
console.log('✅ Decision logging with audit trail');
console.log('✅ Automatic policy evaluation (auto-approve / block)');
console.log('✅ Completion contracts with evidence bundles');
console.log('✅ Agent with approval-gated tool calls');
console.log('✅ Full GDPR data-deletion workflow end-to-end');
