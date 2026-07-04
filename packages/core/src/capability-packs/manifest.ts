/**
 * Capability pack manifest types.
 *
 * A pack is a versioned, exportable bundle of DB rows. The package holds the
 * manifest contract and the structural shape; the actual row schemas (which
 * tables those rows belong to) are the app's concern.
 */

export type PackStatus = 'draft' | 'published' | 'retired';

/**
 * A bucket of rows within a pack. Keys are app-defined content kinds
 * (e.g. `'workflows'`, `'workflowSteps'`, `'tools'`, `'triggers'`). Values
 * are opaque row payloads — the installer adapter knows how to upsert each.
 */
export type PackContents = Record<string, ReadonlyArray<Record<string, unknown>>>;

export interface PackDependency {
  /** Pack key the manifest depends on. */
  packKey: string;
  /** Semver-ish range. The validator does an exact-or-prefix match only. */
  versionRange: string;
}

export interface PackPreconditions {
  /** Workflow handler kinds that must already exist on the target. */
  requiredHandlerKinds?: string[];
  /** Tool keys that must already exist in the target's tool catalog. */
  requiredToolKeys?: string[];
  /** MCP server keys that must already be registered. */
  requiredMcpServers?: string[];
  /** Trigger source kinds that must be supported by the target dispatcher. */
  requiredTriggerSourceKinds?: string[];
}

export interface CapabilityPack {
  /** Pinned to '1' for now — bump when manifest shape changes. */
  manifestVersion: '1';
  /** Stable, dotted identifier (e.g. `'kaggle.pipeline'`). */
  key: string;
  /** Semver. The validator enforces `MAJOR.MINOR.PATCH`. */
  version: string;
  name: string;
  description: string;
  authoredBy?: string;
  dependencies?: PackDependency[];
  preconditions?: PackPreconditions;
  /** App-defined buckets of opaque rows. */
  contents: PackContents;
  /** Free-form, persisted alongside the manifest. */
  metadata?: Record<string, unknown>;
}

/** Result of `installPack` — a per-row ledger so uninstall can clean up exactly what install added. */
export interface PackInstallationLedger {
  packKey: string;
  packVersion: string;
  installedAt: string;
  /** For each content kind, the ids of rows the installer wrote. */
  rowsByKind: Record<string, string[]>;
}
