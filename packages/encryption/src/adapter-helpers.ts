/**
 * @weaveintel/encryption — Adapter integration helpers.
 *
 * Reusable, app-agnostic glue for wiring `TenantKeyManager` into any
 * database adapter / ORM / repository layer. The helpers are intentionally
 * thin: they encode the "skip null / already-encrypted / disabled" pass-through
 * rules so consumers (geneweave, future apps) don't reinvent them.
 *
 * AAD ownership stays inside `TenantKeyManager.encrypt/decrypt`. Consumers
 * supply `tenantId`, `table`, `column`, and `rowId` only.
 */

import type { TenantKeyManager } from './key-manager.js';
import { isEncrypted } from './envelope.js';
import { isFieldEncrypted, type FieldPolicy } from './field-policy.js';

export interface FieldContext {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

/**
 * Resolved tenant encryption state for a single row write/read. Consumers
 * (apps wiring the wrapper) compute this once per call and pass it into
 * `maybeEncryptField` / `maybeDecryptField`.
 */
export interface TenantEncryptionState {
  /** Manager handle, or null when encryption is bootstrap-disabled (no master key). */
  readonly manager: TenantKeyManager | null;
  /** Tenant id resolved from the row context, or null when not encryptable. */
  readonly tenantId: string | null;
  /** Per-tenant policy enabled flag (operator toggle). */
  readonly enabled: boolean;
  /** Resolved field policy (default ∪ tenant override). */
  readonly policy: FieldPolicy;
}

/**
 * Encrypt a string column value before write. Returns the input unchanged
 * when any of the following hold:
 *   - manager is null (no master key configured)
 *   - tenant has no resolved id
 *   - tenant policy is disabled
 *   - (table, column) is not in the resolved field policy
 *   - value is null / undefined
 *   - value is already a sentinel (`enc:v1:...`) — idempotent re-write guard
 *
 * On encrypt success returns the sentinel string. AAD is composed inside
 * the manager from `(tenantId, table, column, rowId, epoch)`.
 */
export async function maybeEncryptField(
  state: TenantEncryptionState,
  ctx: Omit<FieldContext, 'tenantId'>,
  value: string | null | undefined,
): Promise<string | null | undefined> {
  if (value === null || value === undefined) return value;
  if (!state.manager || !state.tenantId || !state.enabled) return value;
  if (!isFieldEncrypted(state.policy, ctx.table, ctx.column)) return value;
  if (isEncrypted(value)) return value; // already encrypted — never double-wrap
  return state.manager.encrypt({
    tenantId: state.tenantId,
    table: ctx.table,
    column: ctx.column,
    rowId: ctx.rowId,
    plaintext: value,
  });
}

/**
 * Decrypt a string column value on read. Returns the input unchanged when:
 *   - manager is null
 *   - tenant has no resolved id
 *   - value is null / undefined
 *   - value is not a sentinel (`isEncrypted(value)` is false) — lazy-upgrade
 *     window where some rows are still plaintext.
 *
 * Note: we intentionally do NOT gate decrypt on `policy.enabled` — once a
 * row is encrypted it must stay readable even if the operator toggles the
 * policy off (turning policy off pauses NEW encryption, never breaks reads).
 */
export async function maybeDecryptField(
  state: TenantEncryptionState,
  ctx: Omit<FieldContext, 'tenantId'>,
  value: string | null | undefined,
): Promise<string | null | undefined> {
  if (value === null || value === undefined) return value;
  if (!state.manager || !state.tenantId) return value;
  if (!isEncrypted(value)) return value;
  return state.manager.decrypt({
    tenantId: state.tenantId,
    table: ctx.table,
    column: ctx.column,
    rowId: ctx.rowId,
    value,
  });
}
