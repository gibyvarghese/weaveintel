/**
 * Shared admin-schema primitives for DB-driven capability management UIs.
 *
 * Apps (including GeneWeave) can compose their admin tabs from these
 * types/helpers so prompt/skill/tool/agent records stay model-discoverable
 * and consistently labeled across apps.
 */

export type AdminFieldSaveTransform =
  | 'json'
  | 'jsonStr'
  | 'int'
  | 'float'
  | 'csvArr'
  | 'bool'
  | 'intBool';

export interface AdminFieldDef {
  key: string;
  label: string;
  textarea?: boolean;
  rows?: number;
  options?: string[];
  type?: 'checkbox' | 'number';
  save?: AdminFieldSaveTransform;
  default?: unknown;
  /** When true the field is displayed read-only in the admin form (no editable input). */
  readonly?: boolean;
}

export interface AdminTabDef {
  singular: string;
  apiPath: string;
  listKey: string;
  cols: string[];
  fields: AdminFieldDef[];
  readOnly?: boolean;
}

export interface AdminTabGroup {
  label: string;
  icon: string;
  tabs: Array<{ key: string; label: string }>;
}

export type AdminTabMap = Record<string, AdminTabDef>;

/**
 * Normalizes description labels for tabs that represent LLM-callable assets.
 *
 * Grounding rule: description fields for callables should be explicit and
 * model-facing so model routing/selection can rely on them in admin UX.
 */
export function normalizeAdminTabsForModelDiscovery(
  tabs: AdminTabMap,
  callableTabKeys: string[] = ['prompts', 'skills', 'tools', 'worker-agents'],
): AdminTabMap {
  const callableSet = new Set(callableTabKeys);
  const normalized: AdminTabMap = {};

  for (const [tabKey, tab] of Object.entries(tabs)) {
    const fields = tab.fields.map((field) => {
      if (!callableSet.has(tabKey)) return field;
      if (field.key !== 'description') return field;
      if (field.label.toLowerCase().includes('model-facing')) return field;
      return { ...field, label: `${field.label} (model-facing)` };
    });
    normalized[tabKey] = { ...tab, fields };
  }

  return normalized;
}
