/**
 * @weaveintel/encryption — Blind-index helpers.
 *
 * A blind index is a deterministic, tenant-keyed HMAC of an encrypted column
 * value, stored alongside the ciphertext as `<column>_bidx`. It enables exact
 * equality lookups (login, dedup) without exposing plaintext or breaking AEAD.
 *
 * `BlindIndexSpec` declares which (table, column) pairs participate. The
 * companion column name defaults to `${column}_bidx` and can be overridden.
 *
 * Hosts use `maybeBlindIndex` symmetrically with `maybeEncryptField`: compute
 * the bidx for every encrypted-equality column on write, store both fields,
 * then issue lookups against the bidx column.
 *
 * Reusability invariant: this module only depends on `TenantKeyManager` and
 * `FieldPolicy` — no app-specific code. A host application wires the user-table
 * bidx, but any app can add its own `BlindIndexSpec` list (e.g. orders.email,
 * customers.phone).
 */

import type { TenantKeyManager } from './key-manager.js';
import { isEncrypted } from './envelope.js';

export interface BlindIndexSpec {
  readonly table: string;
  readonly column: string;
  /** Defaults to `${column}_bidx`. */
  readonly bidxColumn?: string;
}

/** Convenience: return the resolved companion column name for a spec. */
export function bidxColumnName(spec: BlindIndexSpec): string {
  return spec.bidxColumn ?? `${spec.column}_bidx`;
}

/**
 * Default blind-index specs shipped with the package. Apps merge their own
 * specs on top via `mergeBlindIndexSpecs`. Mirrors `DEFAULT_FIELD_POLICY` —
 * every entry here MUST also be encrypted in the field policy.
 */
export const DEFAULT_BLIND_INDEX_SPECS: readonly BlindIndexSpec[] = Object.freeze([
  { table: 'users', column: 'email' },
]);

/** Merge app-supplied specs on top of defaults; later entries win on duplicates. */
export function mergeBlindIndexSpecs(
  ...lists: ReadonlyArray<readonly BlindIndexSpec[] | undefined>
): readonly BlindIndexSpec[] {
  const out = new Map<string, BlindIndexSpec>();
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) out.set(`${s.table}.${s.column}`, s);
  }
  return [...out.values()];
}

/** Find the spec for a (table, column) pair, or undefined. */
export function findBlindIndexSpec(
  specs: readonly BlindIndexSpec[],
  table: string,
  column: string,
): BlindIndexSpec | undefined {
  return specs.find((s) => s.table === table && s.column === column);
}

export interface BlindIndexState {
  readonly manager: TenantKeyManager | null;
  readonly tenantId: string | null;
  /** Tenant policy `blindIndexEnabled` — gates writes (not reads). */
  readonly enabled: boolean;
  readonly specs: readonly BlindIndexSpec[];
}

/**
 * Compute a blind index for a single (table, column, value) write — returns
 * `null` (skip column) when:
 *   - manager is null, no tenant, or `enabled=false`
 *   - the (table, column) pair is not in `specs`
 *   - value is null/undefined/empty/already a sentinel ciphertext
 *
 * Use the result to populate the companion `<column>_bidx` column. Pair with
 * `maybeEncryptField` so plaintext + bidx are written atomically.
 */
export async function maybeBlindIndex(
  state: BlindIndexState,
  table: string,
  column: string,
  value: string | null | undefined,
): Promise<string | null> {
  if (value === null || value === undefined || value === '') return null;
  if (!state.manager || !state.tenantId || !state.enabled) return null;
  if (isEncrypted(value)) return null; // can't bidx ciphertext — caller must pass plaintext
  const spec = findBlindIndexSpec(state.specs, table, column);
  if (!spec) return null;
  return state.manager.computeBlindIndex({
    tenantId: state.tenantId,
    table,
    column,
    value,
  });
}

/**
 * Compute every blind-index column for a row in one pass. Returns a map of
 * `bidxColumn → mac` ready for inclusion in INSERT/UPDATE statements. Skips
 * columns not present in `row`. Used by `createUser`/`updateUser` style
 * adapters AND by the rebuild job.
 */
export async function computeRowBlindIndices(
  state: BlindIndexState,
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!state.manager || !state.tenantId || !state.enabled) return out;
  for (const spec of state.specs) {
    if (spec.table !== table) continue;
    if (!(spec.column in row)) continue;
    const v = row[spec.column];
    if (typeof v !== 'string' || v.length === 0) {
      out[bidxColumnName(spec)] = null;
      continue;
    }
    if (isEncrypted(v)) {
      // Caller passed ciphertext (e.g. round-tripping a row). Skip — we can't
      // bidx without plaintext, and overwriting an existing bidx with null
      // would silently break lookups. Leave the column unset.
      continue;
    }
    out[bidxColumnName(spec)] = await state.manager.computeBlindIndex({
      tenantId: state.tenantId,
      table,
      column: spec.column,
      value: v,
    });
  }
  return out;
}
