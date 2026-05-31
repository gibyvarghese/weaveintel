#!/usr/bin/env node
/**
 * Phase 1 hardening guard — fail CI if any server-side .ts file calls the
 * global `fetch(...)` directly instead of going through the per-package
 * `_fetch.ts` wrapper (which in turn delegates to `createHardenedFetch` /
 * `hardenedFetch` from `@weaveintel/core`).
 *
 * The hardened fetch pipeline applies five outbound-safety primitives every
 * package needs: SSRF guard, redirect re-validation, HTTPS floor, outer
 * timeout, and a streaming response-size cap. Bypassing it leaves a hole.
 *
 * Per-file escape: add `// no-raw-fetch: allow (reason: ...)` within the
 * first 20 lines of the file. Use sparingly and explain the reason.
 *
 * Browser-side code, tests, e2e scripts, and the wrappers themselves are
 * exempt — see EXEMPT_PATTERNS below.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const SCAN_ROOTS = ['packages', 'apps'];

const EXEMPT_PATTERNS = [
  /\/node_modules\//,
  /\/dist\//,
  /\/build\//,
  // Wrapper / chokepoint files
  /\/_fetch\.ts$/,
  /\/hardened-fetch\.ts$/,
  /\/hardened-fetch\.test\.ts$/,
  /\/net-guard\.ts$/,
  /\/net-guard\.test\.ts$/,
  // Tests and e2e
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.e2e\.ts$/,
  /\/__tests__\//,
  // Browser-side code (runs in the user's browser, not in our server)
  /\/ui-client\.ts$/,
  /\/ui\/api\.ts$/,
  /-view\.ts$/,
  /\/views\//,
  // Legacy snapshots (archived, not built)
  /(^|\/)legacy\//,
  // Demo / example apps that aren't server entrypoints
  /(^|\/)apps\/live-agents-demo\//,
];

const ALLOW_COMMENT = /\/\/\s*no-raw-fetch:\s*allow/i;

// Match `fetch(` as a call. Reject:
//   fetch(...)
//   await fetch(...)
//   = fetch(...)
// Allow (not matched):
//   .fetch(...)            (method on an object — these are the package wrappers)
//   #fetch(...)            (private class field call — e.g. vault-transit `this.#fetch`)
//   foo_fetch(...)         (named wrappers)
//   weaveFetch(...)
//   import { fetch }
//   // fetch(            (comment lines are skipped)
//   * fetch(             (block comment lines)
const FETCH_CALL_RE = /(^|[^A-Za-z0-9_.#])fetch\s*\(/;

function isInsideString(line, idx) {
  // Count unescaped ", ', ` quotes before idx. Odd → inside a string literal.
  let s = 0, d = 0, b = 0;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    const prev = i > 0 ? line[i - 1] : '';
    if (prev === '\\') continue;
    if (c === "'") s++;
    else if (c === '"') d++;
    else if (c === '`') b++;
  }
  return (s % 2 === 1) || (d % 2 === 1) || (b % 2 === 1);
}

function shouldExempt(file) {
  return EXEMPT_PATTERNS.some((re) => re.test(file));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'build' || name === '.turbo') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      out.push(full);
    }
  }
}

function scanFile(file) {
  const rel = relative(ROOT, file);
  if (shouldExempt(rel)) return [];
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return []; }

  // Per-file opt-out: comment within first 20 lines
  const head = src.split('\n', 20).join('\n');
  if (ALLOW_COMMENT.test(head)) return [];

  const findings = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines (single-line // and JSDoc *)
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (!FETCH_CALL_RE.test(line)) continue;
    // Skip import / export specifiers like `import { fetch }`
    if (/^\s*(import|export)\b/.test(line) && /\{[^}]*\bfetch\b[^}]*\}/.test(line)) continue;
    // Skip matches that fall inside a string literal
    const m = FETCH_CALL_RE.exec(line);
    if (m && isInsideString(line, m.index + m[0].indexOf('fetch'))) continue;
    findings.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 200) });
  }
  return findings;
}

const files = [];
for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);

const findings = files.flatMap(scanFile);

if (findings.length === 0) {
  console.log(`check-no-raw-fetch: OK (scanned ${files.length} files)`);
  process.exit(0);
}

console.error(`check-no-raw-fetch: ${findings.length} raw fetch call(s) found:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.snippet}`);
}
console.error(`\nServer-side code MUST go through the per-package _fetch.ts wrapper`);
console.error(`(which delegates to @weaveintel/core's hardenedFetch). To opt out a single`);
console.error(`file, add a comment near the top: // no-raw-fetch: allow (reason: ...)`);
process.exit(1);
