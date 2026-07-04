import type { CapabilityPack, PackInstallationLedger, PackPreconditions } from './manifest.js';
import { validateManifest, PackValidationError } from './validator.js';

/**
 * Apps implement this. The installer is generic — it knows nothing about
 * SQLite, workflow_defs, tool_catalog, etc. The adapter is the boundary.
 *
 * Implementations SHOULD perform `upsertRows` for a single pack install
 * inside one DB transaction. The installer aggregates ledger entries across
 * kinds and hands them back so uninstall can reverse them precisely.
 */
export interface PackInstallAdapter {
  /**
   * Check that the target satisfies a pack's preconditions (handler kinds,
   * tool keys, MCP servers, trigger source kinds present). Return a list of
   * unmet preconditions; empty array means OK.
   */
  checkPreconditions(pre: PackPreconditions): Promise<string[]>;

  /**
   * Insert or update rows for a single content kind. Return the ids that were
   * actually written (so the ledger reflects exactly what install touched —
   * useful when the adapter chooses to skip already-present rows).
   */
  upsertRows(kind: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<string[]>;

  /**
   * Remove rows for a content kind by id. Best-effort; missing ids are not an
   * error. Apps SHOULD respect FK constraints by ordering kinds correctly via
   * the `uninstallOrder` option on `uninstallPack`.
   */
  deleteRows(kind: string, rowIds: ReadonlyArray<string>): Promise<void>;

  /**
   * Optional hook to wrap a single install in a transaction. If omitted the
   * installer runs without a tx and the adapter is responsible for its own
   * atomicity.
   */
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface InstallPackOptions {
  /**
   * Override the default content-kind installation order. Earlier kinds are
   * inserted first — useful when later kinds reference earlier ids by FK.
   * Defaults to the order of keys on `pack.contents`.
   */
  installOrder?: string[];
  /** Skip preconditions check entirely (for tests). Default: false. */
  skipPreconditions?: boolean;
}

export interface InstallPackResult {
  ledger: PackInstallationLedger;
  /** Unmet preconditions discovered during the run. Empty when ok. */
  unmetPreconditions: string[];
}

/**
 * Install a capability pack. Validates the manifest, checks preconditions,
 * applies all rows in dependency-friendly order, and returns a ledger that
 * can later be used by `uninstallPack`.
 */
export async function installPack(
  pack: CapabilityPack,
  adapter: PackInstallAdapter,
  options: InstallPackOptions = {},
): Promise<InstallPackResult> {
  const result = validateManifest(pack);
  if (!result.ok) {
    throw new PackValidationError(result.issues);
  }

  const unmet: string[] = [];
  if (!options.skipPreconditions && pack.preconditions) {
    const missing = await adapter.checkPreconditions(pack.preconditions);
    if (missing.length > 0) {
      unmet.push(...missing);
      throw new Error(`pack preconditions not met: ${missing.join(', ')}`);
    }
  }

  const order = options.installOrder ?? Object.keys(pack.contents);
  const rowsByKind: Record<string, string[]> = {};

  const apply = async () => {
    for (const kind of order) {
      const rows = pack.contents[kind];
      if (!rows || rows.length === 0) continue;
      const writtenIds = await adapter.upsertRows(kind, rows);
      rowsByKind[kind] = writtenIds;
    }
  };

  if (adapter.withTransaction) {
    await adapter.withTransaction(apply);
  } else {
    await apply();
  }

  const ledger: PackInstallationLedger = {
    packKey: pack.key,
    packVersion: pack.version,
    installedAt: new Date().toISOString(),
    rowsByKind,
  };
  return { ledger, unmetPreconditions: unmet };
}

export interface UninstallPackOptions {
  /**
   * Reverse-order list of content kinds to delete. If omitted, the ledger's
   * own kind order is reversed (so rows inserted last are deleted first).
   */
  uninstallOrder?: string[];
}

/**
 * Uninstall a previously-installed pack by replaying its ledger in reverse.
 * Best-effort: missing rows are not an error.
 */
export async function uninstallPack(
  ledger: PackInstallationLedger,
  adapter: PackInstallAdapter,
  options: UninstallPackOptions = {},
): Promise<void> {
  const kinds = options.uninstallOrder ?? Object.keys(ledger.rowsByKind).reverse();
  const run = async () => {
    for (const kind of kinds) {
      const rowIds = ledger.rowsByKind[kind];
      if (!rowIds || rowIds.length === 0) continue;
      await adapter.deleteRows(kind, rowIds);
    }
  };
  if (adapter.withTransaction) {
    await adapter.withTransaction(run);
  } else {
    await run();
  }
}
