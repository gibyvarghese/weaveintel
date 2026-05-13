#!/usr/bin/env node
// scripts/_phase6-tick-once.mjs
//
// Phase 6 helper — boots the GDPR purge scheduler once with a long interval,
// invokes tickNow() against the live geneweave.db, prints the tick result as
// JSON to stdout, and exits.
//
// Mirrors scripts/_phase5-tick-once.mjs. Requires WEAVE_ENCRYPTION_MASTER_KEY
// in env (so the encryption manager can bootstrap, unwrap DEKs, and call
// hardShred → store.deleteAllWrappedMaterial).
//
// Usage (from repo root):
//   node scripts/_phase6-tick-once.mjs
//
// Output: a single line of JSON `{"checked":N,"purged":N,"errors":N}` on
// stdout, plus log lines on stderr.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.WEAVE_ENCRYPTION_MASTER_KEY) {
  console.error('[helper] WEAVE_ENCRYPTION_MASTER_KEY missing — cannot tick scheduler');
  process.exit(2);
}

process.env.DATABASE_PATH ??= path.resolve('./geneweave.db');

const distDir = path.resolve('./apps/geneweave/dist');
const dbModule = await import(pathToFileURL(path.join(distDir, 'db-sqlite.js')).href);
const bootstrapModule = await import(pathToFileURL(path.join(distDir, 'encryption/bootstrap.js')).href);
const pkgModule = await import('@weaveintel/encryption');

const { createDatabaseAdapter } = dbModule;
const { bootstrapEncryption } = bootstrapModule;
const { weavePurgeScheduler } = pkgModule;

const db = await createDatabaseAdapter({ type: 'sqlite', path: process.env.DATABASE_PATH });
const bootstrapResult = await bootstrapEncryption(db);
if (!bootstrapResult || !bootstrapResult.manager) {
  console.error('[helper] bootstrapEncryption returned null — manager unavailable');
  process.exit(3);
}
const manager = bootstrapResult.manager;

const handle = weavePurgeScheduler({
  getManager: () => manager,
  listDuePurges: async (nowMs) => {
    const rows = await db.listDueTenantPurges(nowMs);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      requestedAt: r.requested_at,
      retentionUntil: r.retention_until,
    }));
  },
  markPurged: async (requestId, nowMs) => {
    await db.markTenantPurged(requestId, nowMs);
  },
  intervalMs: 999_999_999,
  log: (msg, meta) => console.error(msg, meta ?? {}),
});

try {
  const result = await handle.tickNow();
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  handle.stop();
}
process.exit(0);
