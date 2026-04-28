import type { AdminTabDef } from '@weaveintel/core';

/**
 * anyWeave Phase 4 (M15/M16) — Task-aware routing admin tabs.
 *
 * Six tabs grouped under "Routing" in the admin sidebar:
 *   - task-types               — full CRUD on task type definitions
 *   - capability-matrix        — read-only heatmap (custom view)
 *   - provider-tool-adapters   — full CRUD
 *   - task-type-tenant-overrides — full CRUD
 *   - routing-simulator        — interactive preview (custom view)
 *   - routing-decision-traces  — read-only audit log
 */
export const ROUTING_ADMIN_TABS: Record<string, AdminTabDef> = {
  'task-types': {
    singular: 'Task Type', apiPath: 'admin/task-types', listKey: 'taskTypes',
    cols: ['task_key', 'display_name', 'category', 'output_modality', 'default_strategy', 'enabled'],
    fields: [
      { key: 'task_key', label: 'Task Key (unique)' },
      { key: 'display_name', label: 'Display Name' },
      { key: 'category', label: 'Category', default: 'general' },
      { key: 'description', label: 'Description', textarea: true },
      { key: 'output_modality', label: 'Output Modality', options: ['text', 'code', 'image', 'audio', 'video', 'embedding', 'multimodal'], default: 'text' },
      { key: 'default_strategy', label: 'Default Strategy', options: ['cost', 'speed', 'quality', 'capability', 'balanced'], default: 'balanced' },
      { key: 'default_weights', label: 'Default Weights (JSON {cost,speed,quality,capability})', textarea: true, save: 'json', default: '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}' },
      { key: 'inference_hints', label: 'Inference Hints (JSON)', textarea: true, save: 'json', default: '{}' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'capability-matrix': {
    singular: 'Capability Score', apiPath: 'admin/capability-scores', listKey: 'capabilityScores',
    cols: ['model_id', 'provider', 'task_key', 'tenant_id', 'quality_score', 'is_active'],
    fields: [],
    readOnly: true,
    customView: 'capability-matrix',
  },
  'provider-tool-adapters': {
    singular: 'Provider Tool Adapter', apiPath: 'admin/provider-tool-adapters', listKey: 'adapters',
    cols: ['provider', 'display_name', 'tool_format', 'max_tool_count', 'enabled'],
    fields: [
      { key: 'provider', label: 'Provider Key (e.g. openai, anthropic)' },
      { key: 'display_name', label: 'Display Name' },
      { key: 'adapter_module', label: 'Adapter Module Path' },
      { key: 'tool_format', label: 'Tool Format', options: ['anthropic_xml', 'openai_json', 'google_function', 'mistral_function', 'custom'] },
      { key: 'tool_call_response_format', label: 'Tool Call Response Format', options: ['tool_use_block', 'function_call', 'tool_calls_array'], default: 'function_call' },
      { key: 'tool_result_format', label: 'Tool Result Format', options: ['tool_result_block', 'tool_message', 'function_response'], default: 'tool_message' },
      { key: 'system_prompt_location', label: 'System Prompt Location', options: ['system_message', 'first_user_message', 'separate_field'], default: 'system_message' },
      { key: 'name_validation_regex', label: 'Tool Name Regex', default: '^[a-zA-Z0-9_-]{1,64}$' },
      { key: 'max_tool_count', label: 'Max Tools', type: 'number', save: 'int', default: 128 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'task-type-tenant-overrides': {
    singular: 'Tenant Routing Override', apiPath: 'admin/task-type-tenant-overrides', listKey: 'overrides',
    cols: ['tenant_id', 'task_key', 'preferred_model_id', 'preferred_provider', 'preferred_boost_pct', 'enabled'],
    fields: [
      { key: 'tenant_id', label: 'Tenant ID' },
      { key: 'task_key', label: 'Task Key' },
      { key: 'weights', label: 'Weights Override (JSON, optional)', textarea: true, save: 'json' },
      { key: 'preferred_model_id', label: 'Preferred Model ID' },
      { key: 'preferred_provider', label: 'Preferred Provider' },
      { key: 'preferred_boost_pct', label: 'Preferred Boost %', type: 'number', save: 'float', default: 20 },
      { key: 'cost_ceiling_per_call', label: 'Cost Ceiling per Call (USD)', type: 'number', save: 'float' },
      { key: 'optimisation_strategy', label: 'Optimisation Strategy', options: ['cost', 'speed', 'quality', 'capability', 'balanced'] },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'routing-simulator': {
    singular: 'Routing Simulator', apiPath: 'admin/routing-simulator', listKey: 'tasks',
    cols: [],
    fields: [],
    readOnly: true,
    customView: 'routing-simulator',
  },
  'routing-decision-traces': {
    singular: 'Routing Decision Trace', apiPath: 'admin/routing-decision-traces', listKey: 'traces',
    cols: ['task_key', 'selected_provider', 'selected_model_id', 'inference_source', 'tenant_id', 'decided_at'],
    fields: [
      { key: 'id', label: 'ID', readonly: true },
      { key: 'task_key', label: 'Task Key', readonly: true },
      { key: 'selected_model_id', label: 'Selected Model', readonly: true },
      { key: 'selected_provider', label: 'Selected Provider', readonly: true },
      { key: 'tenant_id', label: 'Tenant', readonly: true },
      { key: 'agent_id', label: 'Agent', readonly: true },
      { key: 'workflow_step_id', label: 'Workflow Step', readonly: true },
      { key: 'inference_source', label: 'Inference Source', readonly: true },
      { key: 'selected_capability_score', label: 'Capability Score', readonly: true },
      { key: 'weights_used', label: 'Weights Used (JSON)', readonly: true, textarea: true },
      { key: 'candidate_breakdown', label: 'Candidate Breakdown (JSON)', readonly: true, textarea: true, rows: 8 },
      { key: 'tool_translation_applied', label: 'Tool Translation Applied', readonly: true },
      { key: 'source_provider', label: 'Source Provider (translation)', readonly: true },
      { key: 'estimated_cost_usd', label: 'Estimated Cost (USD)', readonly: true },
      { key: 'decided_at', label: 'Decided At', readonly: true },
    ],
    readOnly: true,
  },
};
