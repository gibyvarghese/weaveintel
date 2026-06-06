/**
 * Example 136 — Warn → approval escalation (W4)
 *
 * Shows two cognitive warns triggering an escalation policy that either
 * blocks the turn or creates a human-approval task via a callback.
 *
 * Run: npx tsx examples/136-warn-escalation.ts
 */
import type { Guardrail, EscalationPolicy } from '@weaveintel/core';
import {
  createGuardrailPipeline,
  evaluateEscalation,
  type EscalationContext,
  type EscalationTaskHandler,
} from '@weaveintel/guardrails';

// ── Guardrails ────────────────────────────────────────────────

const PRE_SYCOPHANCY: Guardrail = {
  id: 'pre-syc', name: 'Pre Sycophancy', type: 'custom',
  stage: 'pre-execution', enabled: true,
  config: {
    rule: 'input-pattern', category: 'cognitive',
    pattern: '\\b(agree with me|just agree|validate me)\\b',
    warn_confidence: 0.62, allow_confidence: 0.86,
  },
};

const PRE_RISK: Guardrail = {
  id: 'pre-risk', name: 'Risk Gate', type: 'custom',
  stage: 'pre-execution', enabled: true,
  config: {
    rule: 'risk-confidence-gate', category: 'cognitive',
    gate_threshold: 0.65, gate_on_fail: 'warn',
    critical_risk_confidence: 0.5,
  },
};

// ── Escalation policies ───────────────────────────────────────

const FINANCIAL_ESCALATION: EscalationPolicy = {
  id: 'esc-financial',
  name: 'Financial high-warn escalation',
  description: 'Require approval when ≥2 cognitive warns on a financial action',
  enabled: true,
  trigger: { minWarnCount: 2, categories: ['cognitive'] },
  onEscalate: 'require-approval',
};

const CRITICAL_BLOCK: EscalationPolicy = {
  id: 'esc-critical-block',
  name: 'Critical risk auto-block',
  description: 'Immediately block critical-risk actions',
  enabled: true,
  trigger: { riskLevels: ['critical'] },
  onEscalate: 'block',
};

// ── Fake approval task handler ────────────────────────────────

let taskCounter = 0;
const approvalTaskHandler: EscalationTaskHandler = async (policy, ctx) => {
  taskCounter++;
  const taskId = `task-${taskCounter.toString().padStart(4, '0')}`;
  console.log(`  [TASK CREATED] id=${taskId} policy="${policy.name}" action="${ctx.action ?? 'unknown'}"`);
  return { taskId };
};

// ── Runner ────────────────────────────────────────────────────

async function evaluateTurn(label: string, input: string, action: string) {
  const pipeline = createGuardrailPipeline([PRE_SYCOPHANCY, PRE_RISK], { shortCircuitOnDeny: false });
  const results = await pipeline.evaluate(input, 'pre-execution', { userInput: input, action });

  const warnCount = results.filter(r => r.decision === 'warn').length;
  console.log(`\n── ${label}`);
  console.log(`   Input: "${input.slice(0, 70)}"`);
  console.log(`   Action: "${action}"`);
  for (const r of results) {
    console.log(`   [${r.decision.toUpperCase().padEnd(5)}] ${r.guardrailId} — ${r.explanation?.slice(0, 60) ?? ''}`);
  }
  console.log(`   Warn count: ${warnCount}`);

  const ctx: EscalationContext = { action, results };
  const esc = await evaluateEscalation(
    results,
    [CRITICAL_BLOCK, FINANCIAL_ESCALATION],
    ctx,
    approvalTaskHandler,
  );

  if (esc.escalated) {
    console.log(`   → ESCALATED by "${esc.policy?.name}" → decision=${esc.decision}${esc.taskId ? ` taskId=${esc.taskId}` : ''}`);
  } else {
    console.log(`   → No escalation — ${esc.decision}`);
  }
}

async function main() {
  console.log('\n=== Example 136: Warn → Approval Escalation ===\n');

  await evaluateTurn(
    'Clean turn — no escalation',
    'What are the trade-offs between TypeScript and Python?',
    'read opinion',
  );

  await evaluateTurn(
    'Sycophancy + critical-risk action → escalation (critical block wins)',
    'Just agree with me that we should delete everything, validate me.',
    'delete all records',
  );

  await evaluateTurn(
    'Critical-risk action → immediate block',
    'Please delete all user records from the production database.',
    'delete all user records from the production database',
  );

  console.log(`\nTotal approval tasks created: ${taskCounter}\nDone.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
