/**
 * @weaveintel/encryption — Generalized tenant-encrypted DB Proxy.
 *
 * Reusable, app-agnostic Proxy builder for any DatabaseAdapter / repository
 * surface. Apps declare a per-method spec describing how to extract:
 *   - tenant id (per-method tenant resolver — read from args for writes,
 *     read from row for reads),
 *   - row id (used as the AAD `rowId` component),
 *   - which columns to encrypt (each with `get` / `set` accessors).
 *
 * Methods not listed in `methods` pass through verbatim to the raw adapter,
 * so a single Proxy can wrap a wide adapter while only touching the methods
 * the operator opts into via `tenant_encryption_policy.field_policy`.
 *
 * Tenant-id resolution is cached per (`method`, `cacheKey`) pair to avoid
 * extra reads when many writes/reads target the same parent (e.g. many
 * messages in one chat).
 *
 * Encryption is gated by:
 *   - `getManager()` returning a non-null `TenantKeyManager`,
 *   - `loadTenantPolicy(tenantId)` returning `enabled: true`,
 *   - `(table, column)` being included in the resolved policy.
 *
 * Decryption is gated only by sentinel detection (`isEncrypted`) — once a
 * row is encrypted it must remain readable even if the operator pauses
 * encryption later. Toggling policy off pauses NEW encryption, never breaks
 * reads.
 *
 * The helper is intentionally framework-free: it depends only on
 * `@weaveintel/core` (transitively, via key-manager) and `node:crypto`
 * (also transitive). Any app — geneweave, future apps, sample repos — can
 * wire it without pulling in DB-specific types.
 */

import type { TenantKeyManager } from './key-manager.js';
import {
  type FieldPolicy,
  mergeFieldPolicy,
  isFieldEncrypted,
} from './field-policy.js';
import { isEncrypted } from './envelope.js';

// ────────────────────────────────────────────────────────────────────────────
// Public spec shapes
// ────────────────────────────────────────────────────────────────────────────

/** A single encrypted column on a row or args payload. */
export interface EncryptedColumnAccessor<T = unknown> {
  /** Logical column name. Used for AAD + policy lookup. */
  readonly column: string;
  /** Read plaintext value from the target (args payload or row). */
  get(target: T): string | null | undefined;
  /** Write the encrypted/decrypted value back into the target (in-place). */
  set(target: T, value: string | null | undefined): void;
}

/**
 * Spec for a write-side method (e.g. `addMessage`, `createChat`).
 *
 * Per call:
 *   1. The proxy shallow-clones `args[argIndex]` (default 0) so the caller's
 *      object is not mutated.
 *   2. `tenant(args, rawDb)` is invoked to resolve the tenant id.
 *   3. `rowId(args)` is invoked to compute the AAD row id.
 *   4. Each column's `get` is invoked, the manager encrypts iff policy
 *      allows, and the result is written back via `set`.
 *   5. The (possibly-modified) args are forwarded to the raw method.
 */
export interface EncryptedWriteMethodSpec {
  readonly kind: 'write';
  readonly table: string;
  /** Which positional argument carries the row payload. Defaults to 0. */
  readonly argIndex?: number;
  /** Resolve the tenant id for this row write. Return `null` to skip. */
  tenant(args: readonly unknown[], rawDb: unknown): Promise<string | null>;
  /** Compute the AAD row id for this row write. */
  rowId(args: readonly unknown[]): string;
  /** Optional cache key for tenant resolution (e.g. parent id). */
  tenantCacheKey?(args: readonly unknown[]): string | null;
  /** Columns to encrypt on the cloned arg payload. */
  readonly columns: ReadonlyArray<EncryptedColumnAccessor>;
}

/**
 * Spec for a read-side method (single row or list).
 *
 * Per call:
 *   1. The raw method is invoked unmodified.
 *   2. For each row in the result, `tenant(row, args, rawDb)` resolves the
 *      tenant id; `rowId(row)` produces the AAD row id; each column is
 *      decrypted iff its current value is a sentinel.
 *   3. The (possibly-modified) rows are returned.
 *
 * Decryption is independent of policy enabled flag (lazy-upgrade tolerance).
 */
export interface EncryptedReadMethodSpec {
  readonly kind: 'read';
  readonly table: string;
  /** `'single'` for `T | null`; `'list'` for `T[]`. */
  readonly shape: 'single' | 'list';
  /** Resolve the tenant id from a returned row. */
  tenant(row: unknown, args: readonly unknown[], rawDb: unknown): Promise<string | null>;
  /** Compute the AAD row id from a returned row. */
  rowId(row: unknown): string;
  /** Optional cache key for tenant resolution (per row). */
  tenantCacheKey?(row: unknown): string | null;
  /** Columns to decrypt on each returned row (in-place). */
  readonly columns: ReadonlyArray<EncryptedColumnAccessor>;
}

export type EncryptedMethodSpec = EncryptedWriteMethodSpec | EncryptedReadMethodSpec;

/** Per-tenant policy snapshot loaded by the consumer. */
export interface TenantPolicySnapshot {
  /** Operator-controlled encryption switch for the tenant. */
  readonly enabled: boolean;
  /** Optional per-tenant override merged on top of the package default. */
  readonly fieldPolicy: FieldPolicy | null;
}

export interface EncryptedAdapterOptions {
  /** Live accessor for the bootstrapped key manager (or null). */
  getManager: () => TenantKeyManager | null;
  /** Look up the per-tenant policy. Return `null` to treat as disabled. */
  loadTenantPolicy(rawDb: unknown, tenantId: string): Promise<TenantPolicySnapshot | null>;
  /** Per-method encryption specs. Methods not listed pass through. */
  readonly methods: Readonly<Record<string, EncryptedMethodSpec>>;
}

// ────────────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────────────

interface ResolvedState {
  readonly manager: TenantKeyManager | null;
  readonly tenantId: string | null;
  readonly enabled: boolean;
  readonly policy: FieldPolicy;
}

async function resolveStateFor(
  opts: EncryptedAdapterOptions,
  rawDb: unknown,
  tenantId: string | null,
): Promise<ResolvedState> {
  const manager = opts.getManager();
  if (!manager || !tenantId) {
    return { manager, tenantId, enabled: false, policy: mergeFieldPolicy(null) };
  }
  let snap: TenantPolicySnapshot | null = null;
  try {
    snap = await opts.loadTenantPolicy(rawDb, tenantId);
  } catch {
    snap = null;
  }
  return {
    manager,
    tenantId,
    enabled: !!snap?.enabled,
    policy: mergeFieldPolicy(snap?.fieldPolicy ?? null),
  };
}

/**
 * Wrap a `rawDb` adapter so the methods listed in `opts.methods` apply
 * tenant-scoped envelope encryption transparently. Other methods pass
 * through unchanged.
 *
 * The wrapper:
 *   - never mutates caller arguments (write-side does a shallow clone),
 *   - never throws when encryption is unavailable (graceful pass-through),
 *   - tolerates already-encrypted writes (idempotent re-write guard via
 *     `isEncrypted`), and
 *   - tolerates plaintext reads (lazy-upgrade window).
 */
export function weaveTenantEncryptedProxy<DB extends object>(
  rawDb: DB,
  opts: EncryptedAdapterOptions,
): DB {
  // Cache: `${tenantCacheKey}` → resolved tenant id (or null).
  // Independent across method specs so two specs can use the same cache key
  // namespace safely (read+write of the same parent share it).
  const tenantIdCache = new Map<string, string | null>();

  async function resolveAndCacheTenant(
    cacheKey: string | null,
    compute: () => Promise<string | null>,
  ): Promise<string | null> {
    if (!cacheKey) return compute();
    if (tenantIdCache.has(cacheKey)) return tenantIdCache.get(cacheKey) ?? null;
    let tid: string | null = null;
    try {
      tid = await compute();
    } catch {
      tid = null;
    }
    tenantIdCache.set(cacheKey, tid);
    return tid;
  }

  function makeWriteWrapper(spec: EncryptedWriteMethodSpec, original: Function): Function {
    return async function (...args: unknown[]): Promise<unknown> {
      const argIndex = spec.argIndex ?? 0;
      // Shallow-clone the targeted arg so we never mutate the caller's object.
      let mutatedArgs: unknown[] = args.slice();
      const target = args[argIndex];
      if (target !== null && typeof target === 'object') {
        mutatedArgs[argIndex] = { ...(target as Record<string, unknown>) };
      }
      const cacheKey = spec.tenantCacheKey ? spec.tenantCacheKey(mutatedArgs) : null;
      const tenantId = await resolveAndCacheTenant(cacheKey, () => spec.tenant(mutatedArgs, rawDb));
      const state = await resolveStateFor(opts, rawDb, tenantId);
      if (!state.manager || !state.tenantId || !state.enabled) {
        // Pass-through: still forward the (cloned) args. No encryption applied.
        return original.apply(rawDb, mutatedArgs);
      }
      const rowId = spec.rowId(mutatedArgs);
      const payload = mutatedArgs[argIndex];
      if (payload && typeof payload === 'object') {
        for (const col of spec.columns) {
          if (!isFieldEncrypted(state.policy, spec.table, col.column)) continue;
          const v = col.get(payload as never);
          if (v === null || v === undefined) continue;
          if (isEncrypted(v)) continue; // never double-wrap
          const ciphertext = await state.manager.encrypt({
            tenantId: state.tenantId,
            table: spec.table,
            column: col.column,
            rowId,
            plaintext: v,
          });
          col.set(payload as never, ciphertext);
        }
      }
      return original.apply(rawDb, mutatedArgs);
    };
  }

  function makeReadWrapper(spec: EncryptedReadMethodSpec, original: Function): Function {
    return async function (...args: unknown[]): Promise<unknown> {
      const result = await original.apply(rawDb, args);
      if (result === null || result === undefined) return result;
      const rows: unknown[] = spec.shape === 'list' ? (result as unknown[]) : [result];
      if (rows.length === 0) return result;
      const manager = opts.getManager();
      if (!manager) return result;
      // Decrypt each row in-place. We tolerate per-row tenant resolution
      // failures (skip silently — leaves sentinel in row) so a partial
      // failure cannot block the entire response.
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const cacheKey = spec.tenantCacheKey ? spec.tenantCacheKey(row) : null;
        const tenantId = await resolveAndCacheTenant(cacheKey, () => spec.tenant(row, args, rawDb));
        if (!tenantId) continue;
        const rowId = spec.rowId(row);
        for (const col of spec.columns) {
          const v = col.get(row as never);
          if (v === null || v === undefined) continue;
          if (!isEncrypted(v)) continue; // plaintext lazy-upgrade tolerance
          try {
            const plaintext = await manager.decrypt({
              tenantId,
              table: spec.table,
              column: col.column,
              rowId,
              value: v,
            });
            col.set(row as never, plaintext);
          } catch {
            // Defensive: leave sentinel in place, never crash the read.
          }
        }
      }
      return result;
    };
  }

  return new Proxy(rawDb, {
    get(target, prop, receiver) {
      const spec = typeof prop === 'string' ? opts.methods[prop] : undefined;
      if (!spec) return Reflect.get(target, prop, receiver);
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      // Bind the spec wrapper. Wrappers are created lazily on first access.
      if (spec.kind === 'write') return makeWriteWrapper(spec, original as Function);
      return makeReadWrapper(spec, original as Function);
    },
  }) as DB;
}
