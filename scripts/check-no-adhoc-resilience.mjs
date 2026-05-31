#!/usr/bin/env node
/**
 * Phase 2 hardening guard — fail CI if any package reimplements
 * cross-cutting reliability/resilience primitives instead of consuming
 * `@weaveintel/resilience` and `@weaveintel/reliability` (the single
 * implementations of token-bucket / circuit-breaker / retry / idempotency
 * / dead-letter / health, etc.).
 *
 * The point is "one implementation per concern": every adopter pulls
 * resilience from the shared package, so per-package patches don't drift
 * apart and every call site shares the same observability shape.
 *
 * This guard scans for *file names* that indicate a local re-implementation
 * (retry.ts, backoff.ts, circuit-breaker.ts, token-bucket.ts, resilience.ts,
 * dead-letter.ts, idempotency.ts) anywhere under `packages/*` /src outside
 * the packages that legitimately own those concepts.
 *
 * Per-file escape: add
 *   // no-adhoc-resilience: allow (reason: ...)
 * within the first 20 lines. Use sparingly with a clear reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// File-name patterns that suggest a local re-implementation of a
// cross-cutting concern. Matched against the bare basename.
const SUSPECT_BASENAMES = [
  'retry.ts',
  'retry-policy.ts',
  'backoff.ts',
  'circuit-breaker.ts',
  'circuitbreaker.ts',
  'token-bucket.ts',
  'tokenbucket.ts',
  'concurrency-limiter.ts',
  'dead-letter.ts',
  'deadletter.ts',
  'idempotency.ts',
  'idempotency-key.ts',
  'resilience.ts',
];

// Packages that legitimately OWN one of these concerns. Files inside these
// roots are exempt — they are the single source of truth.
const OWNER_PACKAGE_ROOTS = [
  'packages/resilience/',
  'packages/reliability/',
];

const EXEMPT_PATTERNS = [
  /\/node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\.test\.ts$/,
  /\.e2e\.ts$/,
];

const ESCAPE_RE = /\/\/\s*no-adhoc-resilience:\s*allow/;

function isExempt(rel) {
  if (EXEMPT_PATTERNS.some((re) => re.test(rel))) return true;
  if (OWNER_PACKAGE_ROOTS.some((root) => rel.startsWith(root))) return true;
  return false;
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
      walk(full, out);
    } else if (s.isFile() && entry.endsWith('.ts')) {
      out.push(full);
    }
  }
}

const allTs = [];
walk(join(ROOT, 'packages'), allTs);

const violations = [];
for (const abs of allTs) {
  const rel = relative(ROOT, abs).replaceAll('\\', '/');
  if (isExempt(rel)) continue;
  const base = basename(abs);
  if (!SUSPECT_BASENAMES.includes(base)) continue;
  // Per-file escape hatch in the first 20 lines.
  const head = readFileSync(abs, 'utf8').split('\n', 20).join('\n');
  if (ESCAPE_RE.test(head)) continue;
  violations.push(rel);
}

if (violations.length > 0) {
  console.error('check-no-adhoc-resilience: found local re-implementations of cross-cutting concerns.');
  console.error('Consume @weaveintel/resilience / @weaveintel/reliability instead, or add a');
  console.error('per-file `// no-adhoc-resilience: allow (reason: ...)` comment with justification.\n');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}

console.log(`check-no-adhoc-resilience: OK (scanned ${allTs.length} files).`);
