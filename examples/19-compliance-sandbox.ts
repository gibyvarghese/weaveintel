/**
 * Example 19 — Compliance, Sandbox & Reliability
 *
 * Demonstrates:
 *  • Data retention engine with configurable policies
 *  • Deletion manager for GDPR/CCPA compliance
 *  • Legal hold management (prevent deletion of held data)
 *  • Consent manager for tracking user consent
 *  • Audit export for compliance reporting
 *  • Sandboxed code execution with resource limits
 *  • Idempotency store for deduplication
 *  • Retry budgets with circuit-breaker behavior
 *  • Dead-letter queues for failed operations
 *  • Health checking for service reliability
 *
 * No API keys needed — all in-memory.
 *
 * Run: npx tsx examples/19-compliance-sandbox.ts
 */

import {
  createRetentionEngine,
  createDeletionManager,
  createLegalHoldManager,
  createConsentManager,
  createAuditExportManager,
} from '@weaveintel/compliance';

import {
  createSandboxPolicy,
  createSandbox,
  enforceLimits,
  createDefaultLimits,
} from '@weaveintel/sandbox';

import {
  createIdempotencyStore,
  createRetryBudget,
  createDeadLetterQueue,
  createHealthChecker,
} from '@weaveintel/reliability';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Data Retention Policies ───────────────────────── */

header('1. Data Retention Engine');

const retention = createRetentionEngine();

// Define retention policies
retention.addPolicy({
  id: 'chat-logs',
  name: 'Chat Log Retention',
  dataType: 'conversation',
  retentionDays: 90,
  action: 'archive',
  description: 'Archive chat logs after 90 days, delete after 365 days',
});

retention.addPolicy({
  id: 'pii-data',
  name: 'PII Data Retention',
  dataType: 'personal_data',
  retentionDays: 30,
  action: 'delete',
  description: 'Delete PII data after 30 days per GDPR',
});

retention.addPolicy({
  id: 'audit-logs',
  name: 'Audit Log Retention',
  dataType: 'audit',
  retentionDays: 2555, // 7 years
  action: 'archive',
  description: 'Retain audit logs for 7 years per SOX compliance',
});

console.log('Retention policies:');
for (const policy of retention.listPolicies()) {
  console.log(`  📋 ${policy.name}: ${policy.dataType} → ${policy.action} after ${policy.retentionDays}d`);
}

// Check if data should be retained
const testRecords = [
  { id: 'rec-1', dataType: 'conversation', createdAt: new Date(Date.now() - 100 * 86400000) }, // 100 days old
  { id: 'rec-2', dataType: 'personal_data', createdAt: new Date(Date.now() - 10 * 86400000) }, // 10 days old
  { id: 'rec-3', dataType: 'personal_data', createdAt: new Date(Date.now() - 45 * 86400000) }, // 45 days old
  { id: 'rec-4', dataType: 'audit', createdAt: new Date(Date.now() - 300 * 86400000) }, // 300 days old
];

console.log('\nRetention check:');
for (const rec of testRecords) {
  const result = retention.check(rec);
  const emoji = result.shouldAct ? '⚠️' : '✅';
  const ageDays = Math.floor((Date.now() - rec.createdAt.getTime()) / 86400000);
  console.log(`  ${emoji} ${rec.id} (${rec.dataType}, ${ageDays}d old): ${result.shouldAct ? result.action : 'retain'}`);
}

/* ── 2. Legal Holds ───────────────────────────────────── */

header('2. Legal Hold Management');

const legalHolds = createLegalHoldManager();

// Place legal holds
legalHolds.placeHold({
  id: 'hold-lawsuit-2025',
  name: 'Smith v. TechCorp — Discovery',
  reason: 'Litigation hold for ongoing lawsuit — preserve all communications',
  scope: { users: ['user-42', 'user-78'], dataTypes: ['conversation', 'email'] },
  placedBy: 'legal@techcorp.io',
  placedAt: new Date().toISOString(),
});

legalHolds.placeHold({
  id: 'hold-investigation',
  name: 'Internal Investigation — Q4 2024',
  reason: 'Preserve audit logs for internal investigation',
  scope: { dataTypes: ['audit', 'access_log'] },
  placedBy: 'compliance@techcorp.io',
  placedAt: new Date().toISOString(),
});

console.log('Active legal holds:');
for (const hold of legalHolds.listHolds()) {
  console.log(`  ⚖️  ${hold.name}`);
  console.log(`     Reason: ${hold.reason}`);
  console.log(`     Scope: ${JSON.stringify(hold.scope)}`);
}

// Check if data is under hold
const holdChecks = [
  { userId: 'user-42', dataType: 'conversation' },
  { userId: 'user-99', dataType: 'conversation' },
  { userId: 'user-78', dataType: 'audit' },
];

console.log('\nHold checks:');
for (const check of holdChecks) {
  const isHeld = legalHolds.isHeld(check);
  console.log(`  ${isHeld ? '🔒 HELD' : '🔓 Clear'}: user=${check.userId}, type=${check.dataType}`);
}

/* ── 3. Consent Management ────────────────────────────── */

header('3. Consent Manager');

const consent = createConsentManager();

// Record user consents
consent.record({
  userId: 'user-42',
  purpose: 'analytics',
  granted: true,
  timestamp: new Date().toISOString(),
  source: 'cookie-banner',
  version: '2.0',
});

consent.record({
  userId: 'user-42',
  purpose: 'marketing',
  granted: false,
  timestamp: new Date().toISOString(),
  source: 'cookie-banner',
  version: '2.0',
});

consent.record({
  userId: 'user-42',
  purpose: 'ai_training',
  granted: true,
  timestamp: new Date().toISOString(),
  source: 'settings-page',
  version: '1.0',
});

console.log('Consent status for user-42:');
const consents = consent.getConsents('user-42');
for (const c of consents) {
  console.log(`  ${c.granted ? '✅' : '❌'} ${c.purpose} (via ${c.source})`);
}

// Check specific consent
console.log('\nConsent checks:');
console.log(`  Analytics: ${consent.hasConsent('user-42', 'analytics') ? 'Granted' : 'Denied'}`);
console.log(`  Marketing: ${consent.hasConsent('user-42', 'marketing') ? 'Granted' : 'Denied'}`);
console.log(`  AI Training: ${consent.hasConsent('user-42', 'ai_training') ? 'Granted' : 'Denied'}`);

/* ── 4. Deletion Manager ──────────────────────────────── */

header('4. GDPR Deletion Manager');

const deletion = createDeletionManager(legalHolds);

// Attempt deletions (some blocked by legal hold)
const deletionRequests = [
  { userId: 'user-42', dataType: 'conversation', reason: 'GDPR erasure request' },
  { userId: 'user-99', dataType: 'conversation', reason: 'Account closure' },
  { userId: 'user-42', dataType: 'audit', reason: 'Data minimization' },
];

for (const req of deletionRequests) {
  const result = deletion.requestDeletion(req);
  const emoji = result.blocked ? '🔒' : result.executed ? '🗑️' : '⏳';
  console.log(`  ${emoji} ${req.userId}/${req.dataType}: ${result.status}`);
  if (result.blocked) {
    console.log(`     Reason: ${result.blockReason}`);
  }
}

/* ── 5. Audit Export ──────────────────────────────────── */

header('5. Audit Export');

const auditExport = createAuditExportManager();

// Log audit events
auditExport.log({ action: 'consent_recorded', userId: 'user-42', details: { purpose: 'analytics', granted: true }, timestamp: new Date().toISOString() });
auditExport.log({ action: 'legal_hold_placed', userId: 'system', details: { holdId: 'hold-lawsuit-2025' }, timestamp: new Date().toISOString() });
auditExport.log({ action: 'deletion_requested', userId: 'user-42', details: { dataType: 'conversation', blocked: true }, timestamp: new Date().toISOString() });
auditExport.log({ action: 'deletion_executed', userId: 'user-99', details: { dataType: 'conversation', recordsDeleted: 47 }, timestamp: new Date().toISOString() });

const exportData = auditExport.export({ format: 'json' });
console.log(`Audit export: ${exportData.entries.length} events`);
for (const entry of exportData.entries) {
  console.log(`  📝 ${entry.timestamp.slice(0, 19)} | ${entry.action} | user=${entry.userId}`);
}

/* ── 6. Sandboxed Execution ───────────────────────────── */

header('6. Sandboxed Code Execution');

const policy = createSandboxPolicy({
  name: 'agent-code-execution',
  allowedModules: ['Math', 'JSON', 'Date'],
  blockedModules: ['fs', 'child_process', 'net', 'http'],
  maxExecutionMs: 5000,
  maxMemoryMb: 128,
});

console.log(`Sandbox policy: ${policy.name}`);
console.log(`  Allowed: ${policy.allowedModules.join(', ')}`);
console.log(`  Blocked: ${policy.blockedModules.join(', ')}`);
console.log(`  Limits: ${policy.maxExecutionMs}ms, ${policy.maxMemoryMb}MB`);

const sandbox = createSandbox(policy);

// Safe execution
const safeResult = sandbox.execute(() => {
  const data = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
  return {
    sum: data.reduce((a, b) => a + b, 0),
    mean: data.reduce((a, b) => a + b, 0) / data.length,
    max: Math.max(...data),
    sorted: [...data].sort((a, b) => a - b),
  };
});

console.log(`\nSafe execution: ${safeResult.success ? '✅' : '❌'}`);
if (safeResult.success) {
  console.log(`  Result: ${JSON.stringify(safeResult.result)}`);
}

// Resource limit enforcement
const limits = createDefaultLimits({ maxExecutionMs: 100, maxMemoryMb: 64 });
const enforced = enforceLimits(() => {
  // Simulate computation
  let result = 0;
  for (let i = 0; i < 1000; i++) {
    result += Math.sqrt(i);
  }
  return result;
}, limits);

console.log(`\nEnforced execution: ${enforced.success ? '✅' : '❌'}`);
if (enforced.success) {
  console.log(`  Result: ${enforced.result.toFixed(2)}`);
  console.log(`  Duration: ${enforced.durationMs}ms`);
}

/* ── 7. Idempotency ───────────────────────────────────── */

header('7. Idempotency Store');

const idempotency = createIdempotencyStore();

// First execution
const key1 = 'process-order-12345';
const result1 = idempotency.executeOnce(key1, () => {
  console.log('  ⚡ First execution: processing order 12345');
  return { orderId: '12345', status: 'processed', amount: 99.99 };
});

// Duplicate execution (should return cached result)
const result2 = idempotency.executeOnce(key1, () => {
  console.log('  ⚡ This should NOT print — duplicate execution');
  return { orderId: '12345', status: 'double-processed', amount: 199.98 };
});

console.log(`  Result 1: ${JSON.stringify(result1)}`);
console.log(`  Result 2: ${JSON.stringify(result2)}`);
console.log(`  Same result? ${JSON.stringify(result1) === JSON.stringify(result2) ? '✅ Yes' : '❌ No'}`);

/* ── 8. Retry Budget ──────────────────────────────────── */

header('8. Retry Budget');

const retryBudget = createRetryBudget({
  maxRetries: 3,
  windowMs: 60_000,
  backoffMs: 100,
  backoffMultiplier: 2,
});

console.log('Simulating flaky operation (fails twice, succeeds on third try):');
let attempt = 0;
const retryResult = await retryBudget.execute(async () => {
  attempt++;
  if (attempt < 3) {
    console.log(`  ❌ Attempt ${attempt}: simulated failure`);
    throw new Error(`Transient error on attempt ${attempt}`);
  }
  console.log(`  ✅ Attempt ${attempt}: success!`);
  return { data: 'operation completed', attempts: attempt };
});

console.log(`  Final result: ${JSON.stringify(retryResult)}`);
console.log(`  Budget remaining: ${retryBudget.remaining()} retries`);

/* ── 9. Dead Letter Queue ─────────────────────────────── */

header('9. Dead Letter Queue');

const dlq = createDeadLetterQueue<{ orderId: string; error: string }>();

// Simulate failed operations going to DLQ
dlq.enqueue({
  item: { orderId: 'order-001', error: 'Payment gateway timeout' },
  reason: 'Max retries exceeded after 3 attempts',
  failedAt: new Date().toISOString(),
  metadata: { originalQueue: 'order-processing', attempts: 3 },
});

dlq.enqueue({
  item: { orderId: 'order-002', error: 'Invalid shipping address' },
  reason: 'Validation error — not retryable',
  failedAt: new Date().toISOString(),
  metadata: { originalQueue: 'order-processing', attempts: 1 },
});

dlq.enqueue({
  item: { orderId: 'order-003', error: 'Inventory service unavailable' },
  reason: 'Circuit breaker open',
  failedAt: new Date().toISOString(),
  metadata: { originalQueue: 'inventory-check', attempts: 5 },
});

console.log(`Items in DLQ: ${dlq.size()}`);
for (const item of dlq.list()) {
  console.log(`  💀 ${item.item.orderId}: ${item.item.error}`);
  console.log(`     Reason: ${item.reason}`);
}

// Process DLQ items
console.log('\nProcessing DLQ:');
const reprocessed = dlq.drain((entry) => {
  console.log(`  🔄 Reprocessing ${entry.item.orderId}...`);
  return entry.item.orderId !== 'order-002'; // order-002 fails again
});
console.log(`  Reprocessed: ${reprocessed.succeeded} succeeded, ${reprocessed.failed} failed`);
console.log(`  Remaining in DLQ: ${dlq.size()}`);

/* ── 10. Health Checker ───────────────────────────────── */

header('10. Health Checker');

const health = createHealthChecker();

health.addCheck({
  name: 'database',
  check: async () => ({ healthy: true, latencyMs: 12, details: 'SQLite OK' }),
});

health.addCheck({
  name: 'model-api',
  check: async () => ({ healthy: true, latencyMs: 230, details: 'OpenAI reachable' }),
});

health.addCheck({
  name: 'vector-store',
  check: async () => ({ healthy: false, latencyMs: 5001, details: 'Connection timeout' }),
});

health.addCheck({
  name: 'cache',
  check: async () => ({ healthy: true, latencyMs: 3, details: 'Redis OK' }),
});

const report = await health.run();
console.log(`Overall: ${report.healthy ? '✅ Healthy' : '⚠️ Degraded'}`);
for (const check of report.checks) {
  const emoji = check.healthy ? '✅' : '❌';
  console.log(`  ${emoji} ${check.name}: ${check.details} (${check.latencyMs}ms)`);
}

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Data retention policies with age-based checks');
console.log('✅ Legal hold management (place, check, prevent deletion)');
console.log('✅ Consent tracking per user/purpose');
console.log('✅ GDPR deletion manager with hold enforcement');
console.log('✅ Audit export for compliance reporting');
console.log('✅ Sandboxed code execution with policy enforcement');
console.log('✅ Idempotency store for deduplication');
console.log('✅ Retry budget with exponential backoff');
console.log('✅ Dead-letter queue with reprocessing');
console.log('✅ Multi-service health checker');
