/**
 * Example 102 — Capability Packs (Phase 6 of DB-Driven Capability Plan)
 *
 * Demonstrates `@weaveintel/capability-packs` end-to-end with no DB and no LLM.
 *
 * Flow:
 *   1. Construct a `CapabilityPack` manifest (workflows + triggers buckets).
 *   2. Validate it (`validateManifest`).
 *   3. Build an in-memory `PackInstallAdapter` and install the pack
 *      (`installPack`) — yields a `PackInstallationLedger`.
 *   4. Inspect the ledger and the in-memory store.
 *   5. Uninstall using only the ledger (`uninstallPack`) — verify rows gone.
 *   6. Resolve active version from a small list (`resolveActivePackVersion`).
 *
 * Run: `npx tsx examples/102-capability-packs.ts`
 */

import {
  validateManifest,
  installPack,
  uninstallPack,
  resolveActivePackVersion,
  type CapabilityPack,
  type PackInstallAdapter,
} from '@weaveintel/capability-packs';

// ─── 1. Manifest ────────────────────────────────────────────────────
const manifest: CapabilityPack = {
  manifestVersion: '1',
  key: 'demo.support_pack',
  version: '1.2.0',
  name: 'Support Pack',
  description: 'A tiny demo pack with one workflow and one trigger.',
  authoredBy: 'demo@weaveintel.dev',
  preconditions: {
    requiredHandlerKinds: ['noop'],
  },
  contents: {
    workflows: [
      { id: 'wf-greet', name: 'Greet', steps: [{ id: 's1', kind: 'noop' }], entry_step_id: 's1' },
    ],
    triggers: [
      { id: 'trg-manual', key: 'manual.greet', source_kind: 'manual', target_kind: 'workflow', target_config: { workflow_id: 'wf-greet' } },
    ],
  },
  metadata: { tier: 'starter' },
};

// ─── 2. Validate ────────────────────────────────────────────────────
const validation = validateManifest(manifest);
if (!validation.ok) {
  console.error('Manifest invalid:', validation.issues);
  process.exit(1);
}
console.log('✓ Manifest validated');

// ─── 3. Install (in-memory adapter) ─────────────────────────────────
const store = new Map<string, Map<string, Record<string, unknown>>>();
const ensureBucket = (kind: string) => {
  let b = store.get(kind);
  if (!b) { b = new Map(); store.set(kind, b); }
  return b;
};

const adapter: PackInstallAdapter = {
  async checkPreconditions(pre) {
    const unmet: string[] = [];
    const known = new Set(['noop', 'tool', 'script']);
    for (const k of pre.requiredHandlerKinds ?? []) {
      if (!known.has(k)) unmet.push(`handler:${k}`);
    }
    return unmet;
  },
  async upsertRows(kind, rows) {
    const bucket = ensureBucket(kind);
    const ids: string[] = [];
    for (const r of rows) {
      const id = String(r['id']);
      bucket.set(id, r);
      ids.push(id);
    }
    return ids;
  },
  async deleteRows(kind, ids) {
    const bucket = ensureBucket(kind);
    for (const id of ids) bucket.delete(id);
  },
};

const installResult = await installPack(manifest, adapter);
if (installResult.unmetPreconditions.length > 0) {
  console.error('Unmet preconditions:', installResult.unmetPreconditions);
  process.exit(1);
}
console.log('✓ Installed pack — ledger:', JSON.stringify(installResult.ledger, null, 2));
console.log('  store now has:');
for (const [kind, bucket] of store) console.log(`    ${kind}: ${[...bucket.keys()].join(', ')}`);

// ─── 4. Uninstall via ledger ────────────────────────────────────────
await uninstallPack(installResult.ledger, adapter);
console.log('✓ Uninstalled');
for (const [kind, bucket] of store) console.log(`    ${kind}: ${bucket.size === 0 ? '(empty)' : [...bucket.keys()].join(', ')}`);

// ─── 5. Version resolution ──────────────────────────────────────────
const candidates = [
  { version: '1.0.0', status: 'published' as const },
  { version: '1.2.0', status: 'published' as const },
  { version: '2.0.0', status: 'draft' as const },
  { version: '1.1.0', status: 'retired' as const },
];
const active = resolveActivePackVersion(candidates);
console.log('✓ Active version (highest published):', active?.version);
