/**
 * Example 19 — Compliance, Sandbox & Reliability
 *
 * Demonstrates:
 *  • Data retention rules and evaluation
 *  • Deletion requests (right-to-be-forgotten)
 *  • Legal holds that block deletion
 *  • Consent management (GDPR-style)
 *  • Data residency constraints
 *  • Audit export generation
 *  • Code sandbox with execution policies/limits
 *  • Retry budgets with exponential backoff
 *  • Dead-letter queues for failed operations
 *  • Health checks for service monitoring
 *  • Idempotency store for deduplication
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
  createResidencyEngine,
  createAuditExportManager,
} from '@weaveintel/compliance';

import {
  createSandbox,
  createSandboxPolicy,
  createDefaultLimits,
  enforceLimits,
  aggregateResults,
  isSuccessful,
  validatePolicy,
} from '@weaveintel/sandbox';

import {
  createRetryBudget,
  createDeadLetterQueue,
  createHealthChecker,
  createIdempotencyStore,
} from '@weaveintel/reliability';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Data Retention ────────────────────────────────── */

header('1. Data Retention Rules');

const retention = createRetentionEngine();

retention.addRule({
  id: 'ret-logs', name: 'Log Retention', description: 'Delete logs after 90 days',
  dataCategory: 'logs', retentionDays: 90, action: 'delete', enabled: true,
});
retention.addRule({
  id: 'ret-analytics', name: 'Analytics Retention', description: 'Archive analytics after 1 year',
  dataCategory: 'analytics', retentionDays: 365, action: 'archive', enabled: true,
});
retention.addRule({
  id: 'ret-pii', name: 'PII Retention', description: 'Anonymize PII after 180 days',
  dataCategory: 'pii', retentionDays: 180, action: 'anonymize', enabled: true,
});

console.log(`  Rules: ${retention.listRules().length}`);

// Evaluate data items
const scenarios = [
  { category: 'logs', daysOld: 100, label: '100-day-old logs' },
  { category: 'logs', daysOld: 30, label: '30-day-old logs' },
  { category: 'analytics', daysOld: 400, label: '400-day-old analytics' },
  { category: 'pii', daysOld: 200, label: '200-day-old PII' },
  { category: 'chat', daysOld: 500, label: '500-day-old chat (no rule)' },
];

for (const s of scenarios) {
  const createdAt = Date.now() - s.daysOld * 24 * 60 * 60 * 1000;
  const action = retention.evaluate(s.category, createdAt);
  console.log(`  ${s.label}: ${action ?? 'no action'}`);
}

/* ── 2. Deletion Requests ─────────────────────────────── */

header('2. Deletion Requests (Right to be Forgotten)');

const deletion = createDeletionManager();

const req1 = deletion.create('user-123', 'admin@company.com', 'GDPR erasure request', ['pii', 'logs', 'analytics']);
console.log(`  Created: ${req1.id} (status: ${req1.status})`);

const req2 = deletion.create('user-456', 'user-456@email.com', 'Account deletion', ['pii', 'chat']);
console.log(`  Created: ${req2.id} (status: ${req2.status})`);

// Process and complete 
const processed = deletion.process(req1.id);
console.log(`  After process: ${processed?.status}`);

const completed = deletion.complete(req1.id);
console.log(`  After complete: ${completed?.status}`);

console.log(`  All requests: ${deletion.list().length}`);

/* ── 3. Legal Holds ───────────────────────────────────── */

header('3. Legal Holds');

const holds = createLegalHoldManager();

const hold1 = holds.create({
  id: 'hold-litigation', name: 'Ongoing Litigation', description: 'Discovery hold for case #2025-001',
  subjectIds: ['user-123', 'user-789'],
  dataCategories: ['pii', 'chat', 'logs'],
  issuedBy: 'legal@company.com',
  expiresAt: null,
});
console.log(`  Created: "${hold1.name}" (status: ${hold1.status})`);

// Check if data is held
const checks = [
  { subject: 'user-123', category: 'pii' },
  { subject: 'user-123', category: 'analytics' },
  { subject: 'user-456', category: 'pii' },
];

for (const c of checks) {
  const held = holds.isHeld(c.subject, c.category);
  console.log(`  ${c.subject}/${c.category}: ${held ? '🔒 HELD' : '✅ not held'}`);
}

// Release hold
holds.release('hold-litigation');
console.log(`  After release: ${holds.get('hold-litigation')?.status}`);

/* ── 4. Consent Management ────────────────────────────── */

header('4. Consent Management (GDPR)');

const consent = createConsentManager();

consent.grant('user-123', 'analytics', 'cookie-banner');
consent.grant('user-123', 'personalization', 'settings-page');
consent.grant('user-456', 'analytics', 'cookie-banner');
consent.grant('user-456', 'marketing', 'email-opt-in', Date.now() + 30 * 24 * 60 * 60 * 1000);

console.log(`  user-123 analytics: ${consent.isGranted('user-123', 'analytics')}`);
console.log(`  user-123 marketing: ${consent.isGranted('user-123', 'marketing')}`);
console.log(`  user-456 marketing: ${consent.isGranted('user-456', 'marketing')}`);

const user123Consents = consent.listBySubject('user-123');
console.log(`  user-123 consents: ${user123Consents.map(c => c.purpose).join(', ')}`);

consent.revoke('user-123', 'analytics');
console.log(`  After revoke — user-123 analytics: ${consent.isGranted('user-123', 'analytics')}`);

/* ── 5. Data Residency ────────────────────────────────── */

header('5. Data Residency Constraints');

const residency = createResidencyEngine();

residency.addConstraint({
  id: 'eu-pii', name: 'EU PII Residency', description: 'PII must stay in EU',
  region: 'eu', dataCategories: ['pii'],
  allowedRegions: ['eu-west-1', 'eu-central-1'], deniedRegions: ['us-east-1', 'ap-southeast-1'],
  enabled: true,
});

residency.addConstraint({
  id: 'us-analytics', name: 'US Analytics', description: 'Analytics can be US or EU',
  region: 'us', dataCategories: ['analytics'],
  allowedRegions: ['us-east-1', 'us-west-2', 'eu-west-1'], deniedRegions: [],
  enabled: true,
});

const residencyChecks = [
  { category: 'pii', region: 'eu-west-1' },
  { category: 'pii', region: 'us-east-1' },
  { category: 'analytics', region: 'us-east-1' },
  { category: 'analytics', region: 'ap-southeast-1' },
];

for (const c of residencyChecks) {
  const allowed = residency.isAllowed(c.category, c.region);
  console.log(`  ${c.category} → ${c.region}: ${allowed ? '✅ allowed' : '🚫 denied'}`);
}

const piiRegions = residency.getAllowedRegions('pii');
console.log(`\n  Allowed regions for PII: ${piiRegions.join(', ')}`);

/* ── 6. Audit Export ──────────────────────────────────── */

header('6. Audit Export');

const audits = createAuditExportManager();

const exportReq = audits.create(
  'tenant-001', 'compliance@company.com', 'json',
  ['pii', 'logs'], Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now(),
);
console.log(`  Export created: ${exportReq.id} (status: ${exportReq.status})`);

const ready = audits.markReady(exportReq.id, 1500, 2048000);
console.log(`  Marked ready: ${ready?.records} records, ${(ready?.sizeBytes ?? 0) / 1024}KB`);

/* ── 7. Code Sandbox ──────────────────────────────────── */

header('7. Code Sandbox — Safe Execution');

const sandbox = createSandbox();
const policy = createSandboxPolicy({
  name: 'restricted',
  networkAccess: false,
  fileSystemAccess: 'none',
  allowedModules: ['Math', 'JSON'],
});

// Validate the policy
const validation = validatePolicy(policy);
console.log(`  Policy valid: ${validation.valid}${validation.errors.length ? ' — ' + validation.errors.join(', ') : ''}`);

// Execute safe code
const result1 = await sandbox.execute('return 2 + 2;', policy);
console.log(`  "2 + 2" → ${result1.output} (status: ${result1.status})`);

const result2 = await sandbox.execute('return JSON.stringify({hello: "world"});', policy);
console.log(`  JSON.stringify → ${result2.output} (status: ${result2.status})`);

const result3 = await sandbox.execute('throw new Error("oops");', policy);
console.log(`  throw Error → status: ${result3.status}, error: ${result3.error}`);

// Check execution limits
const limits = createDefaultLimits();
console.log(`\n  Default limits: ${JSON.stringify(limits)}`);

const enforcement = enforceLimits(limits, { cpuMs: 50, memoryMb: 128, durationMs: 5000 });
console.log(`  Normal usage: exceeded=${enforcement.exceeded}`);

const overLimit = enforceLimits(limits, { cpuMs: 200000, memoryMb: 512, durationMs: 60000 });
console.log(`  Over limit: exceeded=${overLimit.exceeded}, violations: ${overLimit.violations.join(', ')}`);

// Aggregate results
const stats = aggregateResults([result1, result2, result3]);
console.log(`\n  Aggregate: ${stats.total} runs, ${stats.succeeded} success, ${stats.failed} failed`);

/* ── 8. Retry Budget ──────────────────────────────────── */

header('8. Retry Budget — Exponential Backoff');

const retry = createRetryBudget({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 2000 });

// Show backoff delays
for (let attempt = 0; attempt <= 3; attempt++) {
  const delay = retry.getDelay(attempt);
  const shouldRetry = retry.shouldRetry('connection_error', attempt);
  console.log(`  Attempt ${attempt}: delay=${delay}ms, shouldRetry=${shouldRetry}`);
}

// Execute with retries
let calls = 0;
try {
  const result = await retry.execute(async () => {
    calls++;
    if (calls < 3) throw new Error('transient failure');
    return 'success!';
  });
  console.log(`  Retry result: "${result}" after ${calls} calls`);
} catch (e: any) {
  console.log(`  Retry failed after ${calls} calls: ${e.message}`);
}

/* ── 9. Dead-Letter Queue ─────────────────────────────── */

header('9. Dead-Letter Queue');

const dlq = createDeadLetterQueue();

const dl1 = dlq.enqueue({ type: 'email', payload: { to: 'user@example.com', subject: 'Welcome' }, error: 'SMTP timeout', retryCount: 3 });
const dl2 = dlq.enqueue({ type: 'webhook', payload: { url: 'https://api.example.com/hook', body: {} }, error: 'HTTP 503', retryCount: 2 });
const dl3 = dlq.enqueue({ type: 'email', payload: { to: 'admin@example.com', subject: 'Alert' }, error: 'Invalid address', retryCount: 1 });

console.log(`  Enqueued: ${dlq.list().length} records`);
console.log(`  Email failures: ${dlq.list({ type: 'email' }).length}`);
console.log(`  Unresolved: ${dlq.list({ resolved: false }).length}`);

// Retry one
const retried = await dlq.retry(dl1.id, async (payload) => {
  console.log(`    Retrying email to ${(payload as any).to}...`);
});
console.log(`  Retry success: ${retried}`);
console.log(`  Remaining unresolved: ${dlq.list({ resolved: false }).length}`);

/* ── 10. Health Checks ────────────────────────────────── */

header('10. Health Checks');

const health = createHealthChecker('example-service');

health.addCheck('database', async () => ({ ok: true, message: 'Connected to primary' }));
health.addCheck('cache', async () => ({ ok: true, message: 'Redis responding' }));
health.addCheck('external-api', async () => ({ ok: false, message: 'Timeout after 5000ms' }));

const status = await health.run();
console.log(`  Service: ${status.service}`);
console.log(`  Healthy: ${status.healthy}`);
for (const check of status.checks) {
  console.log(`    ${check.ok ? '✅' : '❌'} ${check.name}: ${check.message ?? 'ok'} (${check.durationMs}ms)`);
}

const isHealthy = await health.isHealthy();
console.log(`  Overall healthy: ${isHealthy}`);

/* ── 11. Idempotency Store ────────────────────────────── */

header('11. Idempotency Store');

const idempotency = createIdempotencyStore({ ttlMs: 60000 });

// First call — not a duplicate
const check1 = idempotency.check('payment-abc-123');
console.log(`  First check "payment-abc-123": isDuplicate=${check1.isDuplicate}`);

// Record the result
idempotency.record('payment-abc-123', { transactionId: 'tx-001', amount: 99.99 });

// Second call — duplicate
const check2 = idempotency.check('payment-abc-123');
console.log(`  Second check "payment-abc-123": isDuplicate=${check2.isDuplicate}, previousResult=${JSON.stringify(check2.previousResult)}`);

// Different key — not a duplicate
const check3 = idempotency.check('payment-def-456');
console.log(`  Check "payment-def-456": isDuplicate=${check3.isDuplicate}`);

console.log(`  Policy: TTL=${idempotency.getPolicy().ttlMs}ms`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Data retention rules with evaluate/delete/archive/anonymize');
console.log('✅ Deletion requests with process/complete workflow');
console.log('✅ Legal holds that block data deletion');
console.log('✅ GDPR consent management with grant/revoke');
console.log('✅ Data residency constraints by region');
console.log('✅ Audit export generation');
console.log('✅ Code sandbox with policy-based execution');
console.log('✅ Retry budgets with exponential backoff');
console.log('✅ Dead-letter queue for failed operations');
console.log('✅ Health checks for service monitoring');
console.log('✅ Idempotency store for deduplication');
}

main().catch(console.error);
