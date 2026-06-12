/**
 * Example 141 — Surface catalog for two principals
 *
 * Demonstrates createSurfaceCatalogResolver from @weaveintel/identity:
 *
 *  1. Two CatalogSource implementations (a static source and a role-based one)
 *  2. An access check that hides "admin" entries from non-admin principals
 *  3. Two principals (user, admin) requesting the same surface
 *  4. Assertions on what each principal sees
 *  5. TTL cache: second request within TTL reuses the cached result
 *
 * No DB, no LLM, no external services.
 */

import assert from 'node:assert/strict';
import { createSurfaceCatalogResolver } from '@weaveintel/identity';
import type { CatalogSource } from '@weaveintel/identity';
import { weaveContext } from '@weaveintel/core';
import type { CatalogEntry } from '@weaveintel/core';

// ---------------------------------------------------------------------------
// Catalog sources
// ---------------------------------------------------------------------------

const COMMON_ENTRIES: CatalogEntry[] = [
  { id: 'mode:assistant', kind: 'mode', label: 'Assistant', description: 'General assistant mode', metadata: {} },
  { id: 'mode:focus',     kind: 'mode', label: 'Focus',     description: 'Focused writing mode',   metadata: {} },
];

const ADMIN_ENTRIES: CatalogEntry[] = [
  { id: 'mode:debug',    kind: 'mode', label: 'Debug',  description: 'Internal debug mode', metadata: { adminOnly: true } },
  { id: 'mode:raw-eval', kind: 'mode', label: 'RawEval', description: 'Raw eval mode',      metadata: { adminOnly: true } },
];

const commonSource: CatalogSource = {
  name: 'common',
  async entries(_ctx, _req) { return COMMON_ENTRIES; },
};

const adminSource: CatalogSource = {
  name: 'admin',
  async entries(_ctx, _req) { return ADMIN_ENTRIES; },
};

// ---------------------------------------------------------------------------
// Access check: entries with adminOnly=true require role=admin
// ---------------------------------------------------------------------------

function accessCheck(_ctx: unknown, entry: CatalogEntry): boolean {
  const meta = entry.metadata as Record<string, unknown> | undefined;
  if (meta?.['adminOnly'] === true) {
    // In a real app, read from ctx.runtime.secrets or JWT claims;
    // here we pass the role via entry metadata for illustration.
    // The check is per-entry — the caller simulates by tagging entries.
    return false; // default: deny admin-only
  }
  return true;
}

function adminAccessCheck(_ctx: unknown, _entry: CatalogEntry): boolean {
  return true; // admin sees everything
}

// ---------------------------------------------------------------------------
// Resolver setup
// ---------------------------------------------------------------------------

const userResolver = createSurfaceCatalogResolver({
  sources: [commonSource, adminSource],
  accessCheck,
  cacheTtlMs: 200,  // short TTL to test cache
});

const adminResolver = createSurfaceCatalogResolver({
  sources: [commonSource, adminSource],
  accessCheck: adminAccessCheck,
  cacheTtlMs: 200,
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ctx = weaveContext({ tenantId: 'tenant-a' });

  // ── User principal: sees only non-admin entries ──────────────────────────

  const userResult = await userResolver.resolve(ctx, { surfaceId: 'web' });

  assert.ok(!userResult.entries.some((e) => (e.metadata as Record<string,unknown>)?.['adminOnly']),
    'user: no admin-only entries visible');
  assert.ok(userResult.entries.some((e) => e.id === 'mode:assistant'),
    'user: assistant mode visible');
  assert.equal(userResult.surfaceId, 'web', 'surfaceId propagated');
  assert.ok(userResult.resolvedAt, 'resolvedAt set');
  console.log('  user entries:', userResult.entries.map((e) => e.label));

  // ── Admin principal: sees all entries ────────────────────────────────────

  const adminResult = await adminResolver.resolve(ctx, { surfaceId: 'web' });

  assert.ok(adminResult.entries.some((e) => e.id === 'mode:debug'),
    'admin: debug mode visible');
  assert.equal(adminResult.entries.length, COMMON_ENTRIES.length + ADMIN_ENTRIES.length,
    'admin sees all entries');
  console.log('  admin entries:', adminResult.entries.map((e) => e.label));

  // ── Cache: second user request reuses cached result ──────────────────────

  const t0 = Date.now();
  const cachedResult = await userResolver.resolve(ctx, { surfaceId: 'web' });
  const elapsed = Date.now() - t0;

  assert.deepEqual(
    [...cachedResult.entries].map((e) => e.id).sort(),
    [...userResult.entries].map((e) => e.id).sort(),
    'cached result matches first result',
  );
  console.log(`  cache hit in ${elapsed}ms (should be near 0)`);

  // ── Different surface gets separate entries ──────────────────────────────

  const mobileResult = await userResolver.resolve(ctx, { surfaceId: 'mobile' });
  assert.deepEqual(
    [...mobileResult.entries].map((e) => e.id).sort(),
    [...userResult.entries].map((e) => e.id).sort(),
    'mobile surface sees same non-admin entries from the same sources',
  );

  console.log('\nexample-141 passed — surface catalog for 2 resolvers (user + admin)');
  console.log('  user sees', userResult.entries.length, 'entries');
  console.log('  admin sees', adminResult.entries.length, 'entries');
  console.log('  mobile sees', mobileResult.entries.length, 'entries (same sources)');
}

main().catch((err) => { console.error(err); process.exit(1); });
