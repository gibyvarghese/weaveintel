/**
 * @weaveintel/encryption — default field policy.
 *
 * Lists the high-priority PII columns documented in
 * docs/TENANT_ENCRYPTION_DESIGN.md §12. Operators override per-tenant via
 * `tenant_encryption_policy.field_policy_json`.
 */

export interface FieldPolicyEntry {
  readonly columns: readonly string[];
}

export type FieldPolicy = Record<string, FieldPolicyEntry>;

export const DEFAULT_FIELD_POLICY: FieldPolicy = Object.freeze({
  messages: { columns: ['content', 'metadata'] },
  chats: { columns: ['title', 'system_prompt'] },
  semantic_memory: { columns: ['content'] },
  entity_memory: { columns: ['properties'] },
  memory_extraction_events: { columns: ['extracted_text'] },
  mesh_contracts: { columns: ['body_json', 'evidence_json'] },
  sv_hypothesis: { columns: ['title', 'statement'] },
  sv_evidence_event: { columns: ['summary'] },
  sv_agent_turn: { columns: ['body'] },
  live_run_events: { columns: ['payload'] },
  tool_audit_events: { columns: ['input_preview', 'output_preview'] },
  tool_approval_requests: { columns: ['input_preview'] },
  users: { columns: ['email', 'phone'] },
});

/** Tables that MUST NOT be encrypted (referential / structural). */
export const NEVER_ENCRYPT_TABLES = Object.freeze(
  new Set<string>([
    'tool_catalog',
    'tool_policies',
    'capability_policy_bindings',
    'cost_policies',
    'prompt_versions',
    'prompt_fragments',
    'prompt_frameworks',
    'prompt_strategies',
    'prompt_experiments',
    'tenant_encryption_policy',
    'tenant_kek',
    'tenant_dek',
    'tenant_bik',
    'encryption_audit',
    'tenant_rewrite_jobs',
  ]),
);

/** Merge an operator override on top of the package default. Overrides win. */
export function mergeFieldPolicy(override: FieldPolicy | null | undefined): FieldPolicy {
  if (!override || Object.keys(override).length === 0) return { ...DEFAULT_FIELD_POLICY };
  const out: FieldPolicy = { ...DEFAULT_FIELD_POLICY };
  for (const [table, entry] of Object.entries(override)) {
    out[table] = { columns: [...entry.columns] };
  }
  return out;
}

/** Returns true iff (table, column) is encrypted under the resolved policy. */
export function isFieldEncrypted(policy: FieldPolicy, table: string, column: string): boolean {
  if (NEVER_ENCRYPT_TABLES.has(table)) return false;
  const entry = policy[table];
  if (!entry) return false;
  return entry.columns.includes(column);
}
