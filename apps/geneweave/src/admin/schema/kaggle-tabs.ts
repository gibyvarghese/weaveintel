import type { AdminTabDef } from '@weaveintel/core';

/**
 * Phase K3 — Kaggle projection admin tabs.
 *
 * These three tabs surface the GeneWeave-side projection of Kaggle agent work.
 * Source of truth for evidence + decisions remains @weaveintel/contracts and
 * the live-agents StateStore. Operators use these tabs to:
 *   - curate the watchlist of competitions (kaggle-competitions)
 *   - review candidate approaches the ideator drafted (kaggle-approaches)
 *   - track kernel-push + submission lifecycles (kaggle-runs)
 */
export const KAGGLE_ADMIN_TABS: Record<string, AdminTabDef> = {
  'kaggle-competitions': {
    singular: 'Tracked Competition',
    apiPath: 'admin/kaggle-competitions',
    listKey: 'kaggle-competitions',
    cols: ['competition_ref', 'title', 'category', 'deadline', 'status', 'last_synced_at'],
    fields: [
      { key: 'competition_ref', label: 'Competition Ref (kaggle slug)' },
      { key: 'title', label: 'Title' },
      { key: 'category', label: 'Category' },
      { key: 'deadline', label: 'Deadline (ISO)' },
      { key: 'reward', label: 'Reward' },
      { key: 'url', label: 'URL' },
      { key: 'status', label: 'Status', options: ['watching', 'active', 'paused', 'archived'], default: 'watching' },
      { key: 'notes', label: 'Notes', textarea: true },
      { key: 'tenant_id', label: 'Tenant ID (optional)' },
      { key: 'last_synced_at', label: 'Last Synced At', readonly: true },
    ],
  },
  'kaggle-approaches': {
    singular: 'Approach',
    apiPath: 'admin/kaggle-approaches',
    listKey: 'kaggle-approaches',
    cols: ['competition_ref', 'summary', 'expected_metric', 'model', 'status'],
    fields: [
      { key: 'competition_ref', label: 'Competition Ref' },
      { key: 'summary', label: 'Summary (short, model-facing)', textarea: true },
      { key: 'expected_metric', label: 'Expected Metric (e.g. AUC=0.83)' },
      { key: 'model', label: 'Model Family (e.g. lightgbm, transformer)' },
      { key: 'source_kernel_refs', label: 'Source Kernel Refs (JSON array)', textarea: true, save: 'json' },
      { key: 'status', label: 'Status', options: ['draft', 'approved', 'rejected', 'implemented'], default: 'draft' },
      { key: 'created_by', label: 'Created By (agent or user)' },
      { key: 'tenant_id', label: 'Tenant ID (optional)' },
    ],
  },
  'kaggle-runs': {
    singular: 'Kaggle Run',
    apiPath: 'admin/kaggle-runs',
    listKey: 'kaggle-runs',
    cols: ['competition_ref', 'status', 'kernel_ref', 'submission_id', 'public_score', 'private_score', 'cv_lb_gap', 'is_final_pick', 'finalized_at', 'started_at'],
    fields: [
      { key: 'competition_ref', label: 'Competition Ref' },
      { key: 'approach_id', label: 'Approach ID' },
      { key: 'contract_id', label: 'Contract ID (links to @weaveintel/contracts)' },
      { key: 'replay_trace_id', label: 'Replay Trace ID (links to @weaveintel/replay)' },
      { key: 'mesh_id', label: 'Mesh ID (live-agents)' },
      { key: 'agent_id', label: 'Agent ID (live-agents)' },
      { key: 'kernel_ref', label: 'Kaggle Kernel Ref' },
      { key: 'submission_id', label: 'Kaggle Submission ID' },
      { key: 'public_score', label: 'Public Score', type: 'number', save: 'float' },
      { key: 'private_score', label: 'Private Score', type: 'number', save: 'float' },
      { key: 'cv_lb_gap', label: 'CV/LB Gap', type: 'number', save: 'float' },
      { key: 'is_final_pick', label: 'Is Final Pick', type: 'checkbox', save: 'int' },
      { key: 'finalized_at', label: 'Finalized At' },
      { key: 'validator_report', label: 'Validator Report (JSON)', textarea: true, save: 'json' },
      { key: 'status', label: 'Status', options: ['queued', 'running', 'validated', 'submitted', 'completed', 'failed'], default: 'queued' },
      { key: 'started_at', label: 'Started At' },
      { key: 'completed_at', label: 'Completed At' },
      { key: 'tenant_id', label: 'Tenant ID (optional)' },
    ],
  },
  'kaggle-run-artifacts': {
    singular: 'Kaggle Run Artifact',
    apiPath: 'admin/kaggle-run-artifacts',
    listKey: 'kaggle-run-artifacts',
    readOnly: true,
    cols: ['run_id', 'contract_id', 'replay_trace_id', 'created_at'],
    fields: [
      { key: 'run_id', label: 'Run ID', readonly: true },
      { key: 'contract_id', label: 'Contract ID (@weaveintel/contracts)', readonly: true },
      { key: 'replay_trace_id', label: 'Replay Trace ID (@weaveintel/replay)', readonly: true },
      { key: 'contract_report_size', label: 'Contract Report Size (bytes)', readonly: true },
      { key: 'replay_run_log_size', label: 'Replay RunLog Size (bytes)', readonly: true },
      { key: 'created_at', label: 'Created At', readonly: true },
    ],
  },

  // ─── Phase K5 — Live-agents Kaggle mesh views ────────────────────────
  // Read-only operator surface over the live-agents StateStore. Source of
  // truth lives in la_entities (separate SQLite file). Provisioning happens
  // via POST /api/admin/kaggle-mesh-provision; revocation via
  // POST /api/admin/kaggle-mesh-bindings/:id/revoke.
  'kaggle-meshes': {
    singular: 'Kaggle Live Mesh',
    apiPath: 'admin/kaggle-meshes',
    listKey: 'kaggle-meshes',
    readOnly: true,
    cols: ['id', 'tenantId', 'name', 'status', 'createdAt'],
    fields: [
      { key: 'id', label: 'Mesh ID', readonly: true },
      { key: 'tenantId', label: 'Tenant ID', readonly: true },
      { key: 'name', label: 'Name', readonly: true },
      { key: 'charter', label: 'Charter', textarea: true, readonly: true },
      { key: 'status', label: 'Status', readonly: true },
      { key: 'dualControlRequiredFor', label: 'Dual-control Tools (JSON array)', readonly: true, save: 'json' },
      { key: 'createdAt', label: 'Created At', readonly: true },
    ],
  },
  'kaggle-mesh-agents': {
    singular: 'Kaggle Live Agent',
    apiPath: 'admin/kaggle-mesh-agents',
    listKey: 'kaggle-mesh-agents',
    readOnly: true,
    cols: ['id', 'meshId', 'role', 'status', 'createdAt'],
    fields: [
      { key: 'id', label: 'Agent ID', readonly: true },
      { key: 'meshId', label: 'Mesh ID', readonly: true },
      { key: 'name', label: 'Name', readonly: true },
      { key: 'role', label: 'Role (model-facing description)', textarea: true, readonly: true },
      { key: 'status', label: 'Status', readonly: true },
      { key: 'contractVersionId', label: 'Contract Version ID', readonly: true },
      { key: 'createdAt', label: 'Created At', readonly: true },
    ],
  },
  'kaggle-mesh-bindings': {
    singular: 'Kaggle Account Binding',
    apiPath: 'admin/kaggle-mesh-bindings',
    listKey: 'kaggle-mesh-bindings',
    readOnly: true,
    cols: ['id', 'agentId', 'accountId', 'purpose', 'grantedAt', 'revokedAt'],
    fields: [
      { key: 'id', label: 'Binding ID', readonly: true },
      { key: 'agentId', label: 'Agent ID', readonly: true },
      { key: 'accountId', label: 'Account ID', readonly: true },
      { key: 'purpose', label: 'Purpose (human-authored)', readonly: true },
      { key: 'constraints', label: 'Constraints (capability matrix prose)', textarea: true, readonly: true },
      { key: 'grantedByHumanId', label: 'Granted By Human', readonly: true },
      { key: 'grantedAt', label: 'Granted At', readonly: true },
      { key: 'expiresAt', label: 'Expires At', readonly: true },
      { key: 'revokedAt', label: 'Revoked At', readonly: true },
      { key: 'revokedByHumanId', label: 'Revoked By Human', readonly: true },
      { key: 'revocationReason', label: 'Revocation Reason', textarea: true, readonly: true },
    ],
  },
  'kaggle-mesh-bridges': {
    singular: 'Kaggle Cross-Mesh Bridge',
    apiPath: 'admin/kaggle-mesh-bridges',
    listKey: 'kaggle-mesh-bridges',
    readOnly: true,
    cols: ['id', 'fromMeshId', 'toMeshId', 'rateLimitPerHour', 'effectiveFrom', 'revokedAt'],
    fields: [
      { key: 'id', label: 'Bridge ID', readonly: true },
      { key: 'fromMeshId', label: 'From Mesh', readonly: true },
      { key: 'toMeshId', label: 'To Mesh', readonly: true },
      { key: 'allowedTopics', label: 'Allowed Topics (JSON array)', readonly: true, save: 'json' },
      { key: 'rateLimitPerHour', label: 'Rate Limit / Hour', readonly: true },
      { key: 'authorisedByType', label: 'Authorised By Type', readonly: true },
      { key: 'authorisedById', label: 'Authorised By ID', readonly: true },
      { key: 'purposeProse', label: 'Purpose', textarea: true, readonly: true },
      { key: 'constraintsProse', label: 'Constraints', textarea: true, readonly: true },
      { key: 'effectiveFrom', label: 'Effective From', readonly: true },
      { key: 'effectiveTo', label: 'Effective To', readonly: true },
      { key: 'revokedAt', label: 'Revoked At', readonly: true },
    ],
  },

  // ─── Phase K6 — Kaggle discussion bot (kill switch + post log) ─────
  // Per-tenant kill switch. Even when the tool, policy, and skill are all
  // enabled, the runtime silently no-ops if discussion_enabled=0 here for
  // the requester's tenant.
  'kaggle-discussion-settings': {
    singular: 'Kaggle Discussion Setting',
    apiPath: 'admin/kaggle-discussion-settings',
    listKey: 'kaggle-discussion-settings',
    cols: ['tenant_id', 'discussion_enabled', 'updated_at'],
    fields: [
      { key: 'tenant_id', label: 'Tenant ID' },
      { key: 'discussion_enabled', label: 'Discussion Enabled (0/1)', type: 'number', save: 'int', default: 0 },
      { key: 'notes', label: 'Notes (operator memo)', textarea: true },
      { key: 'updated_at', label: 'Updated At', readonly: true },
    ],
  },
  'kaggle-discussion-posts': {
    singular: 'Kaggle Discussion Post',
    apiPath: 'admin/kaggle-discussion-posts',
    listKey: 'kaggle-discussion-posts',
    readOnly: true,
    cols: ['competition_ref', 'topic_id', 'tenant_id', 'status', 'posted_at'],
    fields: [
      { key: 'id', label: 'Post ID', readonly: true },
      { key: 'tenant_id', label: 'Tenant ID', readonly: true },
      { key: 'competition_ref', label: 'Competition Ref', readonly: true },
      { key: 'topic_id', label: 'Topic ID', readonly: true },
      { key: 'parent_topic_id', label: 'Parent Topic ID (reply only)', readonly: true },
      { key: 'title', label: 'Title', readonly: true },
      { key: 'body_preview', label: 'Body Preview', textarea: true, readonly: true },
      { key: 'url', label: 'URL', readonly: true },
      { key: 'status', label: 'Status', readonly: true },
      { key: 'contract_id', label: 'Contract ID (@weaveintel/contracts)', readonly: true },
      { key: 'replay_trace_id', label: 'Replay Trace ID (@weaveintel/replay)', readonly: true },
      { key: 'posted_at', label: 'Posted At', readonly: true },
    ],
  },
};
