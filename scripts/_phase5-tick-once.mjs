#!/usr/bin/env node
// scripts/_phase5-tick-once.mjs
//
// Phase 5 helper — boots the rotation scheduler once with a long interval,
// invokes tickNow() against the live geneweave.db, prints the tick result as
// JSON to stdout, and exits.
//
// Requires WEAVE_ENCRYPTION_MASTER_KEY in env (so the encryption manager can
// bootstrap and unwrap DEKs).
//
// Usage (from repo root):
//   node scripts/_phase5-tick-once.mjs
//
// Output: a single line of JSON `{"checked":N,"rotated":N,"errors":N}` on
// stdout, plus log lines on stderr.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.WEAVE_ENCRYPTION_MASTER_KEY) {
  console.error('[helper] WEAVE_ENCRYPTION_MASTER_KEY missing — cannot tick scheduler');
  process.exit(2);
}

// Ensure DATABASE_PATH points at the canonical local DB used by examples/12.
process.env.DATABASE_PATH ??= path.resolve('./geneweave.db');

const distDir = path.resolve('./apps/geneweave/dist');
const dbModule = await import(pathToFileURL(path.join(distDir, 'db-sqlite.js')).href);
const schedulerModule = await import(pathToFileURL(path.join(distDir, 'encryption/rotation-scheduler.js')).href);
const bootstrapModule = await import(pathToFileURL(path.join(distDir, 'encryption/bootstrap.js')).href);

const { createDatabaseAdapter } = dbModule;
const { startEncryptionRotationScheduler } = schedulerModule;
const { bootstrapEncryption } = bootstrapModule;

const db = await createDatabaseAdapter({ type: 'sqlite', path: process.env.DATABASE_PATH });
const bootstrapResult = await bootstrapEncryption(db);
if (!bootstrapResult || !bootstrapResult.manager) {
  console.error('[helper] bootstrapEncryption returned null — manager unavailable');
  process.exit(3);
}
const manager = bootstrapResult.manager;

const handle = startEncryptionRotationScheduler({
  db,
  getManager: () => manager,
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
