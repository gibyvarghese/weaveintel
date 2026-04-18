# GeneWeave Admin Wiring Audit

Date: 2026-04-18
Scope: End-to-end admin wiring validation across UI schema, UI behavior, admin API, SQLite schema/adapter, and runtime consumption.

## Method

Checked and cross-referenced:

- Admin tab definitions: apps/geneweave/src/admin-schema.ts
- Admin UI generic loader/save/edit/delete paths: apps/geneweave/src/ui.ts and apps/geneweave/src/ui/api.ts
- Admin API endpoints: apps/geneweave/src/server-admin.ts
- Database schema and adapter methods: apps/geneweave/src/db-schema.ts and apps/geneweave/src/db-sqlite.ts
- Runtime consumption paths: primarily apps/geneweave/src/chat.ts (plus selected server/dashboard paths)

## Executive Summary

- Most admin tabs are CRUD-wired correctly (UI schema -> API route -> DB adapter/table).
- A smaller subset is actively consumed by runtime orchestration.
- Several tabs are configuration-only today (stored and editable, but not yet read by live runtime paths).
- Three high-priority wiring/UX issues were found:
  1. System/About tab is defined in sidebar groups but missing from ADMIN_TABS, so it never appears in UI.
  2. Read-only monitoring tabs still render Edit/Delete buttons, allowing invalid operations.
  3. Admin data loading silently swallows per-tab fetch failures and shows empty arrays, masking wiring/API failures.

## Tab-by-Tab Wiring Matrix

Legend:

- Fully wired + runtime used: End-to-end wired and used in live runtime behavior.
- Fully wired + admin only: End-to-end CRUD wired, but no current runtime consumer beyond admin/dashboard surfaces.
- Partially wired: UI/API behavior has a gap or inconsistency.

### Core AI

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| prompts | Yes | prompts table + CRUD | Yes (chat prompt resolution and policy loading) | Fully wired + runtime used | Used by chat pipeline. |
| guardrails | Yes | guardrails table + CRUD | Yes (guardrail execution path) | Fully wired + runtime used | Used by chat safety flow. |
| routing | Yes | routing_policies table + CRUD | Yes (routing policy loading) | Fully wired + runtime used | Schema key differs from physical table name by design. |
| model-pricing | Yes | model_pricing table + CRUD | Yes (cost/model logic, pricing sync) | Fully wired + runtime used | Also sync route exists. |
| workflows | Yes | workflow_defs table + CRUD | No runtime engine consumer detected | Fully wired + admin only | Workflow run API exists, but workflow defs are not consumed by chat runtime. |
| tools | Yes | tool_configs table + CRUD | No runtime consumer detected for tool_configs | Fully wired + admin only | Runtime toolset appears code/skill-driven, not tool_configs-driven. |
| skills | Yes | skills table + CRUD | Yes (enabled skills loaded by chat) | Fully wired + runtime used | Critical runtime config. |
| worker-agents | Yes | worker_agents table + CRUD | Yes (delegation pool) | Fully wired + runtime used | Critical runtime config. |

### Governance

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| task-policies | Yes | human_task_policies table + CRUD | Yes (chat policy loading) | Fully wired + runtime used | Name differs from tab key by design. |
| contracts | Yes | task_contracts table + CRUD | Yes (task contract lookup by worker) | Fully wired + runtime used | Used by worker contract logic. |
| identity-rules | Yes | identity_rules table + CRUD | No consumer detected | Fully wired + admin only | Appears configured but unenforced in runtime auth path. |
| memory-governance | Yes | memory_governance table + CRUD | No consumer detected | Fully wired + admin only | Governance configuration not enforced in current memory paths. |
| memory-extraction-rules | Yes | memory_extraction_rules table + CRUD | Yes (memory extraction logic) | Fully wired + runtime used | Active in chat extraction flow. |
| compliance-rules | Yes | compliance_rules table + CRUD | No consumer detected | Fully wired + admin only | Stored but not currently evaluated during runtime flow. |

### Integrations

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| search-providers | Yes | search_providers table + CRUD | No consumer detected | Fully wired + admin only | |
| http-endpoints | Yes | http_endpoints table + CRUD | No consumer detected | Fully wired + admin only | |
| social-accounts | Yes | social_accounts table + CRUD | No consumer detected | Fully wired + admin only | |
| enterprise-connectors | Yes | enterprise_connectors table + CRUD | Yes (connector discovery/update in chat) | Fully wired + runtime used | Runtime reads/updates available connectors. |
| tool-registry | Yes | tool_registry table + CRUD | No consumer detected | Fully wired + admin only | Distinct from tools/tool_configs. |

### Automation

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| trigger-definitions | Yes | trigger_definitions table + CRUD | No consumer detected | Fully wired + admin only | |
| replay-scenarios | Yes | replay_scenarios table + CRUD | No consumer detected | Fully wired + admin only | |
| cache-policies | Yes | cache_policies table + CRUD | Yes (chat cache policy loading) | Fully wired + runtime used | Runtime-consumed. |
| reliability-policies | Yes | reliability_policies table + CRUD | No consumer detected | Fully wired + admin only | |

### Infrastructure

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| sandbox-policies | Yes | sandbox_policies table + CRUD | No consumer detected | Fully wired + admin only | |
| extraction-pipelines | Yes | extraction_pipelines table + CRUD | No consumer detected | Fully wired + admin only | |
| artifact-policies | Yes | artifact_policies table + CRUD | No consumer detected | Fully wired + admin only | |
| tenant-configs | Yes | tenant_configs table + CRUD | No consumer detected | Fully wired + admin only | |

### Advanced

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| collaboration-sessions | Yes | collaboration_sessions table + CRUD | No consumer detected | Fully wired + admin only | |
| graph-configs | Yes | graph_configs table + CRUD | No consumer detected | Fully wired + admin only | |
| plugin-configs | Yes | plugin_configs table + CRUD | No consumer detected | Fully wired + admin only | |

### Developer

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| scaffold-templates | Yes | scaffold_templates table + CRUD | No consumer detected | Fully wired + admin only | |
| recipe-configs | Yes | recipe_configs table + CRUD | No consumer detected | Fully wired + admin only | |
| widget-configs | Yes | widget_configs table + CRUD | No consumer detected | Fully wired + admin only | |
| validation-rules | Yes | validation_rules table + CRUD | No consumer detected | Fully wired + admin only | |

### Monitoring

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| workflow-runs | Yes (list + detail + write routes exist) | workflow_runs table + CRUD | Operational/observability usage exists | Fully wired + admin only | Read-only in UI schema but UI still renders edit/delete actions. |
| guardrail-evals | List-only API by design | guardrail_evals table | Produced by runtime and shown in dashboards | Partially wired | Marked read-only, but UI still renders edit/delete actions; no detail/edit/delete endpoint exists. |
| memory-extraction-events | Yes (list + detail) | memory_extraction_events table | Produced by runtime and shown in dashboards | Partially wired | Marked read-only, but UI still renders edit/delete actions. |

### System

| Tab | API wiring | DB wiring | Runtime consumption | Status | Notes |
|---|---|---|---|---|---|
| about | Version API exists at /api/admin/version | N/A | Intended informational tab | Partially wired | Present in ADMIN_TAB_GROUPS, but missing in ADMIN_TABS so it is filtered out and never rendered. |

## Evidence Highlights (Code)

- About tab declared in groups but not in tab defs:
  - apps/geneweave/src/admin-schema.ts
- Admin UI filters visible tabs to Object.keys(ADMIN_TABS):
  - apps/geneweave/src/ui.ts
- Read-only tabs still show Edit/Delete actions (no readOnly guard on row actions):
  - apps/geneweave/src/ui.ts
- Per-tab admin load swallows request failures and substitutes empty lists:
  - apps/geneweave/src/ui/api.ts
- Version/About API exists:
  - apps/geneweave/src/server-admin.ts
- Runtime consumption for core policy/config tables (examples):
  - apps/geneweave/src/chat.ts

## Prioritized Fix Plan

### P0 (Fix immediately)

1. Enforce read-only behavior in admin table actions.
   - In admin view row rendering, hide Edit/Delete for schema.readOnly tabs.
   - In admin action handlers, add defensive early return when schema.readOnly is true.
   - Expected outcome: no invalid mutation calls for monitoring tabs.

2. Restore System/About tab visibility.
   - Add about tab definition into ADMIN_TABS or create a dedicated non-CRUD renderer path.
   - If using dedicated renderer, map tab key about to GET /api/admin/version payload and render version/codename/repo/update status.

### P1 (Correctness and debuggability)

3. Stop masking admin load failures.
   - In loadAdmin(), keep per-tab error state instead of silently returning empty arrays.
   - Surface failed tabs in UI with inline error chip and retry action.

4. Align monitoring tab schema with API capabilities.
   - For guardrail-evals, explicitly mark list-only behavior in schema metadata.
   - Disable any detail/edit/delete expectations for list-only tabs.

### P2 (Runtime wiring completeness)

5. Decide per configuration tab: runtime-consumed vs admin-only.
   - For each currently admin-only tab (identity-rules, memory-governance, compliance-rules, reliability-policies, etc.), choose one:
     - integrate into runtime enforcement/loading, or
     - mark as registry-only/experimental in UI copy.

6. Add wiring health tests.
   - Add a lightweight test that checks each ADMIN_TABS entry has:
     - matching list endpoint,
     - expected response key,
     - required CRUD endpoints unless readOnly/list-only.
   - Add runtime configuration smoke tests for tabs expected to affect chat behavior.

## Suggested Implementation Order

1. Read-only action guard fix in UI.
2. About tab rendering fix.
3. Admin load error visibility.
4. Add schema capability flags (readOnly/listOnly/noDetail).
5. Add wiring tests.
6. Runtime integration roadmap for admin-only tabs.

## Risk Notes

- Current UI behavior can produce misleading "empty" states and invalid edit/delete UX on monitoring tabs.
- Many tabs are functionally persistent but do not influence runtime yet; this can create operator expectation mismatch.

## Completion Criteria

- Every tab in sidebar either renders correctly or is intentionally hidden with rationale.
- Read-only tabs cannot trigger mutation requests.
- Admin load failures are visible per tab.
- Runtime-impacting tabs are explicitly documented and tested.
- Admin-only tabs are clearly labeled until runtime integration is implemented.
