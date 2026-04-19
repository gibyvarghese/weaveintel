import type { AdminTabDef } from '@weaveintel/core';

/**
 * Shared callable capability tabs (tools/skills/worker-agents) are isolated so
 * multiple app surfaces can reuse consistent LLM-facing metadata fields.
 */
export const CALLABLE_CAPABILITY_ADMIN_TABS: Record<string, AdminTabDef> = {
  'tools': {
    singular: 'Tool', apiPath: 'admin/tools', listKey: 'tools',
    cols: ['name', 'category', 'risk_level', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Detailed Description (model-facing)' },
      { key: 'category', label: 'Category' },
      { key: 'risk_level', label: 'Risk Level', options: ['low', 'medium', 'high', 'critical'], default: 'low' },
      { key: 'requires_approval', label: 'Requires Approval', type: 'checkbox', save: 'bool' },
      { key: 'max_execution_ms', label: 'Max Execution (ms)', type: 'number', save: 'int' },
      { key: 'rate_limit_per_min', label: 'Rate Limit/min', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'skills': {
    singular: 'Skill', apiPath: 'admin/skills', listKey: 'skills',
    cols: ['name', 'category', 'priority', 'version', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Purpose & Summary (model-facing)', textarea: true, rows: 4 },
      { key: 'category', label: 'Category', options: ['retrieval', 'computation', 'communication', 'data-processing', 'planning', 'analysis', 'code', 'web', 'general'], default: 'general' },
      { key: 'instructions', label: 'Skill Playbook (when to use, when not to use, reasoning, execution, completion)', textarea: true, rows: 10 },
      { key: 'examples', label: 'Examples (JSON array, optional)', textarea: true, rows: 4, save: 'json' },
      { key: 'tool_names', label: 'Allowed Tool Guidance (JSON array, optional)', textarea: true, rows: 3, save: 'json' },
      { key: 'tags', label: 'Semantic Hints (JSON array, optional)', textarea: true, rows: 2, save: 'json' },
      { key: 'trigger_patterns', label: 'Legacy Trigger Hints (optional, semantic activation is primary)', textarea: true, rows: 2, save: 'json' },
      { key: 'priority', label: 'Priority', type: 'number', save: 'int', default: 0 },
      { key: 'version', label: 'Version', default: '1.0' },
      { key: 'prompt_id', label: 'Prompt ID (optional)' },
      { key: 'prompt_version', label: 'Prompt Version (optional)' },
      { key: 'prompt_strategy', label: 'Prompt Strategy (optional)' },
      { key: 'prompt_variables', label: 'Prompt Variables (JSON object)', textarea: true, rows: 3, save: 'json' },
      { key: 'contract_key', label: 'Contract Key (optional)' },
      { key: 'eval_policy_key', label: 'Eval Policy Key (optional)' },
      { key: 'tool_policy_key', label: 'Tool Policy Key (optional)' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'worker-agents': {
    singular: 'Worker Agent', apiPath: 'admin/worker-agents', listKey: 'workerAgents',
    cols: ['name', 'persona', 'priority', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Detailed Description (model-facing)' },
      { key: 'system_prompt', label: 'System Prompt', textarea: true, rows: 6 },
      { key: 'tool_names', label: 'Tool Names (JSON array)', textarea: true, rows: 3, save: 'json' },
      { key: 'persona', label: 'Persona', options: ['agent_worker', 'agent_researcher', 'agent_supervisor'], default: 'agent_worker' },
      { key: 'trigger_patterns', label: 'Trigger Patterns (JSON array)', textarea: true, rows: 3, save: 'json' },
      { key: 'task_contract_id', label: 'Task Contract ID (optional)' },
      { key: 'max_retries', label: 'Max Retries', type: 'number', save: 'int', default: 0 },
      { key: 'priority', label: 'Priority', type: 'number', save: 'int', default: 0 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
};
