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
import { applyM46AgendaNotes } from './m46-agenda-notes.js';
import { applyM47VoiceAgents } from './m47-voice-agents.js';
import { applyM48VoicePipelineMode } from './m48-voice-pipeline-mode.js';
import { applyM49EncryptExternalCredentials } from './m49-encrypt-external-credentials.js';
import { applyM50CriticalIndexes } from './m50-critical-indexes.js';
import { applyM51EvalSchemaFixes } from './m51-eval-schema-fixes.js';
import { applyM52VaultV1Migration } from './m52-vault-v1-migration.js';
import { applyM53McpGatewayTenantRateLimit } from './m53-mcp-gateway-tenant-rate-limit.js';
import { applyM54AuditRetentionTiers } from './m54-audit-retention-tiers.js';
import { applyM55StepUpMfa } from './m55-step-up-mfa.js';
import { applyM56PasskeyCredentials } from './m56-passkey-credentials.js';
import { applyM57RedactionDefaultOn } from './m57-redaction-default-on.js';
import { applyM58BackfillCredentialEncryption } from './m58-backfill-credential-encryption.js';
import { applyM59LiveRunsStopRequested } from './m59-live-runs-stop-requested.js';
import { applyM60A2ASkills } from './m60-a2a-skills.js';
import { applyM61A2ASkillsAgentConfig } from './m61-a2a-skills-agent-config.js';
import { applyM62A2ATasks } from './m62-a2a-tasks.js';
import { applyM63AgentPhase2 } from './m63-agent-phase2.js';
import { applyM64AgentPhase3 } from './m64-agent-phase3.js';
import { applyM65AgentPhase4 } from './m65-agent-phase4.js';
import { applyM66AgentPhase5 } from './m66-agent-phase5.js';
import { applyM67AgentPhase6 } from './m67-agent-phase6.js';
import { applyM68ModelRegistryRefresh } from './m68-model-registry-refresh.js';
import { applyM69A2ASkillsV2 } from './m69-a2a-skills-v2.js';
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
  { id: 'm46-agenda-notes', description: 'WC1-WC9: agenda_categories, agenda_items, notes, note_links, note_databases, note_db_rows; persona-seeded categories + note templates', run: applyM46AgendaNotes },
  { id: 'm47-voice-agents', description: 'Voice agents: voice_configs, voice_sessions, voice_session_events; text_to_speech + voice_agent task types', run: applyM47VoiceAgents },
  { id: 'm48-voice-pipeline-mode', description: 'Voice pipeline mode: pipeline_mode + realtime_model columns on voice_configs', run: applyM48VoicePipelineMode },
  { id: 'm49-encrypt-external-credentials', description: 'H-2: Add credentials_encrypted flag + *_enc shadow columns to search_providers, social_accounts, enterprise_connectors for vault encryption at rest', run: applyM49EncryptExternalCredentials },
  { id: 'm50-critical-indexes', description: 'H-3: Critical composite indexes on messages, chats, sessions, traces, metrics, eval_results, tool_rate_limit_buckets', run: applyM50CriticalIndexes },
  { id: 'm51-eval-schema-fixes', description: 'L-15 + M-19: prompt_eval_runs status index + eval_results.settings_snapshot_at column', run: applyM51EvalSchemaFixes },
  { id: 'm52-vault-v1-migration', description: 'H-5: Re-encrypt legacy website_credentials rows to per-record-salt v1 vault format (AES-256-GCM + HKDF)', run: applyM52VaultV1Migration },
  { id: 'm53-mcp-gateway-tenant-rate-limit', description: 'A-9: Add tenant_id to mcp_gateway_clients + recreate mcp_gateway_rate_buckets with (tenant_id, client_id, window_start) composite unique key', run: applyM53McpGatewayTenantRateLimit },
  { id: 'm54-audit-retention-tiers', description: 'EU AI Act Art 12: add retention_tier to tool_audit_events + mcp_gateway_request_log; seed audit_log_retention_tiers table (90-day operational / 7-year compliance)', run: applyM54AuditRetentionTiers },
  { id: 'm55-step-up-mfa', description: '4.17: Add mfa_enabled + mfa_totp_secret to users; mfa_verified_at to sessions for TOTP step-up MFA on admin routes', run: applyM55StepUpMfa },
  { id: 'm56-passkey-credentials', description: '4.1: FIDO2/WebAuthn passkey_credentials + webauthn_challenges tables', run: applyM56PasskeyCredentials },
  { id: 'm57-redaction-default-on', description: 'M4-5: Backfill chat_settings.redaction_enabled=1; clear guardrail_evals.input_preview to remove stored PII', run: applyM57RedactionDefaultOn },
  { id: 'm58-backfill-credential-encryption', description: 'H-2 Phase 2: Encrypt existing plaintext credentials in search_providers, social_accounts, enterprise_connectors using vault AES-256-GCM', run: applyM58BackfillCredentialEncryption },
  { id: 'm59-live-runs-stop-requested', description: 'M6-2: Add stop_requested column to live_runs; create api_live_runs table for durable, cross-process live-agent stop signals', run: applyM59LiveRunsStopRequested },
  { id: 'm60-a2a-skills', description: 'A2A Skills: a2a_skills table seeded with the 3 default capability skills (general-chat, supervisor-orchestration, ensemble-reasoning); replaces hardcoded constant in routes/a2a.ts', run: applyM60A2ASkills },
  { id: 'm61-a2a-skills-agent-config', description: 'A2A Skills agent config: agent_tools + agent_workers columns on a2a_skills; seeds code_executor+analyst workers for supervisor-orchestration', run: applyM61A2ASkillsAgentConfig },
  { id: 'm62-a2a-tasks', description: 'A2A Tasks: persistent SQLite-backed a2a_tasks table; replaces in-memory store so task state survives server restarts', run: applyM62A2ATasks },
  { id: 'm63-agent-phase2', description: 'Agent Phase 2: parallel_tool_calls, context management (strategy/max_tokens/window_size), tool retry columns on chat_settings + agent_strategy_settings; agent_output_schemas + agent_structured_outputs tables', run: applyM63AgentPhase2 },
  { id: 'm64-agent-phase3', description: 'Agent Phase 3: HITL interrupt (hitl_interrupt_requests table, chat_settings HITL/handoff toggles) + agent handoff audit log (agent_handoff_log table)', run: applyM64AgentPhase3 },
  { id: 'm65-agent-phase4', description: 'Agent Phase 4: portable memory tools, proactive context injection (chat_settings columns), knowledge graph (agent_graph_nodes + agent_graph_edges tables), graph tool catalog seeds', run: applyM65AgentPhase4 },
  { id: 'm66-agent-phase5', description: 'Agent Phase 5: checkpoint/resume (agent_checkpoints table, chat_settings columns) + dynamic worker registry (chat_settings columns)', run: applyM66AgentPhase5 },
  { id: 'm67-agent-phase6', description: 'Agent Phase 6: eval pipeline, cost governor, compliance, vision loop (chat_settings columns + agent_eval_pipeline_runs, agent_cost_ledger, agent_compliance_audit tables)', run: applyM67AgentPhase6 },
  { id: 'm68-model-registry-refresh', description: 'Model Registry Refresh (mid-2026): context_window_k + max_output_tokens_k on model_pricing; supports_computer_use + supports_long_context + supports_realtime_audio on model_capability_scores; disable Gemini 1.5 / llama3 / phi3 / gemma2; quality-score corrections', run: applyM68ModelRegistryRefresh },
  { id: 'm69-a2a-skills-v2', description: 'A2A Skills Taxonomy Expansion (mid-2026): 12 new a2a_skills (computer-use, browser-automation, code-execution, document-intelligence, image-analysis, image-generation, voice-interaction, data-pipeline, memory-retrieval, workflow-orchestration, research-synthesis, hypothesis-validation); update supervisor-orchestration workers; add video/*/html/openxmlformats MIME types to existing skills', run: applyM69A2ASkillsV2 },
]);

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  bootstrapRunner.run(db);
}
