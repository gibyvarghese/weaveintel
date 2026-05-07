# @weaveintel/capability-packs

Versioned, exportable bundles of DB rows ("capability packs") that can be installed and uninstalled atomically against any host that supplies a `PackInstallAdapter`. Phase 6 of the [DB-Driven Capability Plan](../../docs/DB_DRIVEN_CAPABILITY_PLAN.md).

## What is a pack?

A `CapabilityPack` is a manifest with a stable `key`, a semver `version`, and a set of opaque row buckets under `contents`. The package owns the manifest contract and the install/uninstall machinery; the **app** owns the row schemas and the storage.

```ts
import { validateManifest, installPack, uninstallPack, resolveActivePackVersion } from '@weaveintel/capability-packs';
```

## Manifest shape

```ts
interface CapabilityPack {
  manifestVersion: '1';
  key: string;          // lower.dotted.snake_case (e.g. 'kaggle.pipeline')
  version: string;      // semver MAJOR.MINOR.PATCH
  name: string;
  description: string;
  authoredBy?: string;
  dependencies?: PackDependency[];
  preconditions?: {
    requiredHandlerKinds?: string[];
    requiredToolKeys?: string[];
    requiredMcpServers?: string[];
    requiredTriggerSourceKinds?: string[];
  };
  contents: Record<string, ReadonlyArray<Record<string, unknown>>>;
  metadata?: Record<string, unknown>;
}
```

**Key rule** (`/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/`) — no hyphens, must start with a letter, dot-segmented.

## API

- `validateManifest(manifest)` — returns `{ ok, issues }`. Validates shape, key/version regex, content row arity.
- `installPack(manifest, adapter, opts?)` — checks preconditions, upserts each bucket via `adapter.upsertRows`, returns `{ ledger, unmetPreconditions }`. If `unmetPreconditions.length > 0`, no rows are written. Pass `{ skipPreconditions: true }` to bypass.
- `uninstallPack(ledger, adapter)` — deletes exactly the rows recorded in the ledger via `adapter.deleteRows`.
- `resolveActivePackVersion(candidates)` — returns the highest published version (semver), or `undefined`.

## `PackInstallAdapter` contract

```ts
interface PackInstallAdapter {
  checkPreconditions(pre: PackPreconditions): Promise<string[]>; // unmet keys
  upsertRows(kind: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<string[]>; // persisted ids
  deleteRows(kind: string, ids: ReadonlyArray<string>): Promise<void>;
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
}
```

The package never writes to a DB directly. Hosts (e.g. `apps/geneweave`) provide the adapter and own the row schemas.

## GeneWeave reference implementation

See `apps/geneweave/src/capability-packs/install-adapter.ts`. Supported buckets: `workflow_defs`, `triggers`, `prompts`, `prompt_fragments`, `tool_policies`, `capability_policy_bindings`. Admin API at `/api/admin/capability-packs` (CRUD, install/uninstall, export) and `/api/admin/capability-pack-installations` (readonly ledger view).

## Example

End-to-end in-process demo (no DB, no LLM): [`examples/102-capability-packs.ts`](../../examples/102-capability-packs.ts).

E2E against running geneweave: [`scripts/e2e-phase6-capability-packs.mjs`](../../scripts/e2e-phase6-capability-packs.mjs).
