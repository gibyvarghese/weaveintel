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
import { applyM33PlatformLimits } from './m33-platform-limits.js';
import { applyM34GuardrailConditions } from './m34-guardrail-conditions.js';
import { applyM35MemoryVectors } from './m35-memory-vectors.js';
import { applyM36MemoryComplete } from './m36-memory-complete.js';
import { applyM37MemoryGuardrails } from './m37-memory-guardrails.js';
import { applyM38ExtendedPiiPatterns } from './m38-extended-pii-patterns.js';
import { applyM39MemoryToolsExtended } from './m39-memory-tools-extended.js';
import { applyM40AgentStrategies } from './m40-agent-strategies.js';
import { applyM41PlatformFoundation } from './m41-platform-foundation.js';
import { applyM42UserMemoryAndTz } from './m42-user-memory-and-tz.js';
import { applyM43ConversationFlags } from './m43-conversation-flags.js';
import { applyM44AuthHardening } from './m44-auth-hardening.js';
import { applyM45KaggleRoleCapabilities } from './m45-kaggle-role-capabilities.js';
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
  { id: 'm33-platform-limits', description: 'Platform limits: initialise config_overrides.limits on global tenant_configs row', run: applyM33PlatformLimits },
  { id: 'm34-guardrail-conditions', description: 'Guardrail conditional triggers: trigger_conditions + trigger_description columns, seed default conditions for model-graded and context-sensitive guardrails', run: applyM34GuardrailConditions },
  { id: 'm35-memory-vectors', description: 'Memory: embedding column on semantic_memory, memory tool catalog seeds, governance rule seeds, additional extraction rules', run: applyM35MemoryVectors },
  { id: 'm36-memory-complete', description: 'Memory: episodic_memory, procedural_memory, working_memory_snapshots, memory_settings tables; seed memory_list_episodes and memory_get_profile tool catalog entries', run: applyM36MemoryComplete },
  { id: 'm37-memory-guardrails', description: 'Memory guardrails: episodic PII redaction rule (SSN/card/JWT/email/phone/credential) + entity PII block rule (SSN/card in entity facts)', run: applyM37MemoryGuardrails },
  { id: 'm38-extended-pii-patterns', description: 'Extended PII patterns: DB URI credentials, JWT signing key values, broad SSN fallback (catches 9xx numbers)', run: applyM38ExtendedPiiPatterns },
  { id: 'm39-memory-tools-extended', description: 'Memory tools: seed memory_snapshot, memory_load_state, memory_propose_instruction in tool catalog', run: applyM39MemoryToolsExtended },
  { id: 'm40-agent-strategies', description: 'Agent Reasoning Strategies W1–W5: reflection, verify, supervisor re-plan, parallel delegation, ensemble mode columns on chat_settings; agent_strategy_settings table for global/tenant defaults', run: applyM40AgentStrategies },
  { id: 'm41-platform-foundation', description: 'Platform Foundation W9: user_runs, user_run_events, user_devices, notification_preferences, mode_labels, starter_prompts tables', run: applyM41PlatformFoundation },
  { id: 'm42-user-memory-and-tz', description: 'W9b: semantic_memory.metadata (correction trail) + notification_preferences.timezone (quiet-hours tz)', run: applyM42UserMemoryAndTz },
  { id: 'm43-conversation-flags', description: 'SP2 (mobile): chats.pinned + chats.archived for the user-scoped conversation list', run: applyM43ConversationFlags },
  { id: 'm44-auth-hardening', description: 'Auth hardening: users.email_verified, email_verifications table, user_invitations table', run: applyM44AuthHardening },
  { id: 'm45-kaggle-role-capabilities', description: 'Kaggle role capability matrix: DB-configurable defaults table seeded from KAGGLE_CAPABILITY_MATRIX', run: applyM45KaggleRoleCapabilities },
]);

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  bootstrapRunner.run(db);
}
