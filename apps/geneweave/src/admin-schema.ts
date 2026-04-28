/**
 * @weaveintel/geneweave — Admin tab schema
 *
 * Data-driven configuration for all admin CRUD tabs.
 * Each tab defines its form fields, table columns, API paths, and
 * field-level transformations.  The UI, save, edit, and column logic
 * in ui.ts reference this schema instead of per-tab switch/if blocks.
 */

import {
  type AdminTabGroup,
  normalizeAdminTabsForModelDiscovery,
} from '@weaveintel/core';
import {
  PROMPT_CAPABILITY_ADMIN_TABS,
  CALLABLE_CAPABILITY_ADMIN_TABS,
  PLATFORM_CAPABILITY_ADMIN_TABS,
  ROUTING_ADMIN_TABS,
} from './admin/schema/index.js';

// ─── Tab groups (sidebar navigation) ─────────────────────────

export const ADMIN_TAB_GROUPS: AdminTabGroup[] = [
  { label: 'Prompt Studio', icon: '\uD83D\uDCDD', tabs: [
    { key: 'prompts', label: 'Prompts' },
    { key: 'prompt-versions', label: 'Prompt Versions' },
    { key: 'prompt-experiments', label: 'Prompt Experiments' },
    { key: 'prompt-frameworks', label: 'Frameworks' },
    { key: 'prompt-fragments', label: 'Fragments' },
    { key: 'prompt-contracts', label: 'Output Contracts' },
    { key: 'prompt-strategies', label: 'Strategies' },
    { key: 'prompt-optimizers', label: 'Prompt Optimizers' },
    { key: 'prompt-optimization-runs', label: 'Optimization Runs' },
    { key: 'prompt-eval-datasets', label: 'Eval Datasets' },
    { key: 'prompt-eval-runs', label: 'Eval Runs' },
    { key: 'model-pricing', label: 'Pricing' },
  ]},
  { label: 'Orchestration', icon: '\uD83E\uDD16', tabs: [
    { key: 'skills', label: 'Skills' },
    { key: 'agents', label: 'Supervisor Agents' },
    { key: 'worker-agents', label: 'Worker Agents' },
    { key: 'tool-catalog', label: 'Tool Catalog' },
    { key: 'tool-policies', label: 'Tool Policies' },
    { key: 'tool-audit', label: 'Tool Audit' },
    { key: 'tool-health', label: 'Tool Health' },
    { key: 'tool-credentials', label: 'Tool Credentials' },
    { key: 'tool-simulation', label: 'Tool Simulation' },
    { key: 'tool-approval-requests', label: 'Tool Approvals' },
    { key: 'mcp-gateway-clients', label: 'MCP Gateway Clients' },
    { key: 'mcp-gateway-activity', label: 'MCP Gateway Activity' },
    { key: 'workflows', label: 'Workflows' },
    { key: 'routing', label: 'Routing' },
    { key: 'task-policies', label: 'Task Policies' },
    { key: 'trigger-definitions', label: 'Triggers' },
    { key: 'replay-scenarios', label: 'Replay' },
  ]},
  { label: 'Routing', icon: '\uD83D\uDDFA\uFE0F', tabs: [
    { key: 'task-types', label: 'Task Types' },
    { key: 'capability-matrix', label: 'Capability Matrix' },
    { key: 'task-type-tenant-overrides', label: 'Tenant Overrides' },
    { key: 'provider-tool-adapters', label: 'Provider Adapters' },
    { key: 'routing-simulator', label: 'Routing Simulator' },
    { key: 'routing-decision-traces', label: 'Decision Traces' },
    { key: 'routing-capability-signals', label: 'Capability Signals' },
    { key: 'message-feedback', label: 'Message Feedback' },
    { key: 'routing-surface-items', label: 'Surface Items' },
    { key: 'routing-experiments', label: 'A/B Experiments' },
    { key: 'cost-by-task', label: 'Cost by Task' },
  ]},
  { label: 'Governance', icon: '\uD83D\uDEE1\uFE0F', tabs: [
    { key: 'guardrails', label: 'Guardrails' },
    { key: 'contracts', label: 'Contracts' },
    { key: 'identity-rules', label: 'Identity Rules' },
    { key: 'memory-governance', label: 'Memory Policy' },
    { key: 'memory-extraction-rules', label: 'Memory Rules' },
    { key: 'compliance-rules', label: 'Compliance' },
  ]},
  { label: 'Integrations', icon: '\uD83D\uDD0C', tabs: [
    { key: 'enterprise-connectors', label: 'Enterprise' },
    { key: 'social-accounts', label: 'Social' },
    { key: 'search-providers', label: 'Search' },
    { key: 'http-endpoints', label: 'HTTP' },
  ]},
  { label: 'Social Growth', icon: '\uD83D\uDE80', tabs: [
    { key: 'sg-brands', label: 'Brands' },
    { key: 'sg-channels', label: 'Channels' },
    { key: 'sg-platform-configs', label: 'Platform Configs' },
    { key: 'sg-campaigns', label: 'Campaigns' },
    { key: 'sg-content-pillars', label: 'Pillars' },
    { key: 'sg-content-queue', label: 'Content Queue' },
    { key: 'sg-growth-experiments', label: 'Experiments' },
    { key: 'sg-kpi-snapshots', label: 'KPI Snapshots' },
    { key: 'sg-workflow-templates', label: 'Workflow Templates' },
    { key: 'sgap-agents', label: 'Org Agents' },
    { key: 'sgap-workflow-runs', label: 'Org Workflow Runs' },
    { key: 'sgap-agent-threads', label: 'Agent Threads' },
    { key: 'sgap-agent-messages', label: 'Agent Messages' },
    { key: 'sgap-approvals', label: 'Approvals' },
    { key: 'sgap-audit-log', label: 'Audit Log' },
    { key: 'sgap-content-performance', label: 'Performance' },
    { key: 'sgap-phase2-configs', label: 'Phase 2 Configs' },
    { key: 'sgap-content-revisions', label: 'Content Revisions' },
    { key: 'sgap-phase3-configs', label: 'Phase 3 Configs' },
    { key: 'sgap-distribution-plans', label: 'Distribution Plans' },
    { key: 'sgap-phase4-configs', label: 'Phase 4 Configs' },
    { key: 'sgap-performance-insights', label: 'Performance Insights' },
  ]},
  { label: 'Knowledge', icon: '\uD83D\uDCC2', tabs: [
    { key: 'extraction-pipelines', label: 'Extraction' },
    { key: 'artifact-policies', label: 'Artifacts' },
    { key: 'graph-configs', label: 'Graph' },
    { key: 'plugin-configs', label: 'Plugins' },
    { key: 'collaboration-sessions', label: 'Collaboration' },
  ]},
  { label: 'Infrastructure', icon: '\u2699\uFE0F', tabs: [
    { key: 'tenant-configs', label: 'Tenants' },
    { key: 'cache-policies', label: 'Cache' },
    { key: 'reliability-policies', label: 'Reliability' },
    { key: 'sandbox-policies', label: 'Sandbox' },
  ]},
  { label: 'Monitoring', icon: '\uD83D\uDCCA', tabs: [
    { key: 'workflow-runs', label: 'Runs' },
    { key: 'guardrail-evals', label: 'Evals' },
    { key: 'memory-extraction-events', label: 'Memory Extraction' },
  ]},
  { label: 'Developer', icon: '\uD83D\uDEE0\uFE0F', tabs: [
    { key: 'scaffold-templates', label: 'Scaffolds' },
    { key: 'recipe-configs', label: 'Recipes' },
    { key: 'widget-configs', label: 'Widgets' },
    { key: 'validation-rules', label: 'Validation' },
  ]},
  { label: 'System', icon: '\u2139\uFE0F', tabs: [
    { key: 'users', label: 'Users' },
    { key: 'about', label: 'About' },
  ]},
];

// ─── Per-tab definitions ─────────────────────────────────────

export const ADMIN_TABS = normalizeAdminTabsForModelDiscovery({
  ...PROMPT_CAPABILITY_ADMIN_TABS,
  ...CALLABLE_CAPABILITY_ADMIN_TABS,
  ...PLATFORM_CAPABILITY_ADMIN_TABS,
  ...ROUTING_ADMIN_TABS,
});
