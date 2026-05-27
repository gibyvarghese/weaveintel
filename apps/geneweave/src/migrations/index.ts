import type BetterSqlite3 from 'better-sqlite3';
import { applyM01_M10 } from './m01-m10.js';
import { applyM11_M18 } from './m11-m18.js';
import { applyM19_M22 } from './m19-m22.js';
import { applyM23 } from './m23.js';
import { applyM24WorkflowW3 } from './m24-workflow-w3.js';
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
]);

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  bootstrapRunner.run(db);
}
