import type BetterSqlite3 from 'better-sqlite3';
import { applyM01_M10 } from './m01-m10.js';
import { applyM11_M18 } from './m11-m18.js';
import { applyM19_M22 } from './m19-m22.js';
import { applyM23 } from './m23.js';
import { applyM24WorkflowW3 } from './m24-workflow-w3.js';
import { applyM25WorkflowW4 } from './m25-workflow-w4.js';
import { applyM26WorkflowW5 } from './m26-workflow-w5.js';
import { applyM27WorkflowW6 } from './m27-workflow-w6.js';
import { applyM28ToolRequires } from './m28-tool-requires.js';
import { applyM29GuardrailRevisions } from './m29-guardrail-revisions.js';
import { applyM30GuardrailSecurity } from './m30-guardrail-security.js';
import { applyM31PiiGuardrails } from './m31-pii-guardrails.js';
import { applyM32GuardrailTimeouts } from './m32-guardrail-timeouts.js';
import { applyEncryption } from './encryption.js';
import { createMigrationRunner } from './helpers.js';

export { createMigrationRunner, type MigrationBatch } from './helpers.js';

const bootstrapRunner = createMigrationRunner([
  { id: 'm01-m10', description: 'Core tables M1–M10 (users, chats, prompts, routing)', run: applyM01_M10 },
  { id: 'm11-m18', description: 'Tools, workflows, agents, admin M11–M18', run: applyM11_M18 },
  { id: 'm19-m22', description: 'Cost governor, Kaggle, live-agents M19–M22', run: applyM19_M22 },
  { id: 'encryption', description: 'Encryption phases 1–10', run: applyEncryption },
  { id: 'm23', description: 'Fix stale Claude model IDs in model_pricing, capability scores, routing policies, tenant configs', run: applyM23 },
  { id: 'm24-workflow-w3', description: 'Workflow W3: trace_id/tenant_id on runs, workflow_payloads table', run: applyM24WorkflowW3 },
  { id: 'm25-workflow-w4', description: 'Workflow W4: parent/child runs, audit events, durable sleeps, step locks', run: applyM25WorkflowW4 },
  { id: 'm26-workflow-w5', description: 'Workflow W5: priority, cost_breakdown, run queue, rate limit tables', run: applyM26WorkflowW5 },
  { id: 'm27-workflow-w6', description: 'Workflow W6: workflow_spans table for structured observability', run: applyM27WorkflowW6 },
  { id: 'm28-tool-requires', description: 'Phase D: tool_catalog.requires column for capability requirements', run: applyM28ToolRequires },
  { id: 'm29-guardrail-revisions', description: 'Guardrail W7: append-only revision/audit table for rule changes', run: applyM29GuardrailRevisions },
  { id: 'm30-guardrail-security', description: 'Security: input credential detection + localhost SSRF deny guardrails (C2+H4)', run: applyM30GuardrailSecurity },
  { id: 'm31-pii-guardrails', description: 'Privacy: input PII deny guardrails for SSN + credit card (P4.1/C1.2)', run: applyM31PiiGuardrails },
  { id: 'm32-guardrail-timeouts', description: 'Guardrails: raise model-graded timeouts to 15s; injection-classifier on_error → warn', run: applyM32GuardrailTimeouts },
]);

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  bootstrapRunner.run(db);
}
