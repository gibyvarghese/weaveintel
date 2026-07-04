#!/usr/bin/env node
/**
 * De-branding guard — fail CI if a consuming app's brand name leaks into the
 * MIT-licensed framework surface. An outsider who installs `@weaveintel/*`
 * should never find another product's name (geneWeave, weaveNotes, …) staring
 * back at them from the source or its doc comments.
 *
 * WHAT it scans: every `packages/<name>/src` tree plus `clients/tokens/src`
 * (the published framework source), excluding tests, type decls, and build
 * output — those don't ship to adopters.
 *
 * WHAT it bans (case-insensitive, anywhere — code, strings, or comments):
 *   geneweave / geneWeave, weaveNotes, rentWeave, weaveStrike.
 *
 * ESCAPE HATCHES (scripts/no-app-brand-allowlist.json):
 *   - deferredPaths: a whole package/dir whose de-brand is scheduled for a
 *     later restructure phase. Temporary; each names the phase that empties it.
 *   - allowedExamples: the rare comment that cites an app as an EXAMPLE
 *     consumer (never as the assumed reader). Permanent, kept rare.
 *
 * Exit 0 = clean; exit 1 = leaks found (printed with file:line + the term).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Scan roots per the restructure plan.
const SCAN_ROOTS = ['packages', 'clients/tokens'];

const EXEMPT_PATTERNS = [
  /\/node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.spec\.ts$/,
  /\.e2e\.ts$/,
  /\.d\.ts$/,
];

// Only these extensions carry shippable source.
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;

// Banned app-brand terms (case-insensitive). geneweave/geneWeave collapse when
// lowercased, so one pattern each.
const BANNED = [
  { name: 'geneWeave', re: /geneweave/i },
  { name: 'weaveNotes', re: /weavenotes/i },
  { name: 'rentWeave', re: /rentweave/i },
  { name: 'weaveStrike', re: /weavestrike/i },
];

const allowlist = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'no-app-brand-allowlist.json'), 'utf8'),
);
const deferredPaths = allowlist.deferredPaths ?? [];
const allowedExamples = allowlist.allowedExamples ?? [];

/** Recursively collect shippable source files under a root. */
function collect(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(ROOT, abs);
    if (EXEMPT_PATTERNS.some((p) => p.test('/' + rel.replace(/\\/g, '/')))) continue;
    const st = statSync(abs);
    if (st.isDirectory()) collect(abs, out);
    else if (SOURCE_EXT.test(entry)) out.push(rel);
  }
}

// For a package root like `packages`, only descend into each package's `src/`.
function collectFrameworkSources() {
  const files = [];
  // packages/*/src
  const pkgsDir = join(ROOT, 'packages');
  if (existsSync(pkgsDir)) {
    for (const pkg of readdirSync(pkgsDir)) {
      collect(join(pkgsDir, pkg, 'src'), files);
    }
  }
  // clients/tokens/src
  collect(join(ROOT, 'clients', 'tokens', 'src'), files);
  return files;
}

const isDeferred = (rel) =>
  deferredPaths.find((d) => rel.replace(/\\/g, '/').startsWith(d.prefix));
const isAllowedExample = (rel, line) =>
  allowedExamples.some(
    (a) => a.file === rel.replace(/\\/g, '/') && (a.match ? line.includes(a.match) : true),
  );

const files = collectFrameworkSources();
const violations = [];
const deferredHits = new Map(); // phase -> count

for (const rel of files) {
  const relNorm = rel.replace(/\\/g, '/');
  const deferred = isDeferred(relNorm);
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const b of BANNED) {
      if (!b.re.test(line)) continue;
      if (deferred) {
        deferredHits.set(deferred.phase, (deferredHits.get(deferred.phase) ?? 0) + 1);
        continue;
      }
      if (isAllowedExample(relNorm, line)) continue;
      violations.push({ file: relNorm, line: i + 1, term: b.name, text: line.trim().slice(0, 120) });
    }
  }
}

// ── Report ──
if (deferredHits.size) {
  console.log('Deferred (scheduled for a later phase; not a failure):');
  for (const [phase, count] of deferredHits) console.log(`  • ${count} hit(s) — ${phase}`);
  console.log('');
}

if (violations.length === 0) {
  console.log(`check-no-app-brand: PASS — no app-brand leaks in ${files.length} framework source files.`);
  process.exit(0);
}

console.error(`check-no-app-brand: ${violations.length} app-brand leak(s) in the framework:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.term}]`);
  console.error(`    ${v.text}`);
}
console.error(
  '\nFix: reword to neutral phrasing ("a consuming application", "the reference app"),' +
    '\nor — if a comment genuinely needs to cite one app as an EXAMPLE consumer — add it to' +
    '\nscripts/no-app-brand-allowlist.json (allowedExamples). Keep those rare.',
);
process.exit(1);
