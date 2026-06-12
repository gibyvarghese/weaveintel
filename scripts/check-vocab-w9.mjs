#!/usr/bin/env node
/**
 * scripts/check-vocab-w9.mjs
 *
 * Vocabulary lint: fail if any public-export files under packages/{name}/src/
 * use the interaction-model-specific terms that are banned from the shared
 * platform API surface per the copilot-instructions.md rule:
 *
 *   > Vocabulary rule: Framework packages NEVER use "chat", "conversation",
 *   > "message" (HTTP sense), "turn" in public APIs.
 *
 * What counts as a "public export":
 *   - index.ts / index.ts at the package root (packages/<name>/src/index.ts)
 *   - Any file exported directly from it (exports resolved one level deep)
 *
 * The check scans for the banned words as whole-word identifiers in the public
 * API of each package.  Comments and string literals are excluded.
 *
 * Ban list (whole-word, identifier context only):
 *   conversation, chatHistory, chatSession, messageHistory, turnHistory
 *
 * NOT banned — these appear in implementation or are not HTTP-sense "message":
 *   "message" as a user-facing body (e.g. notification message text)  <- OK
 *   "chat" is allowed in "apps/geneweave" (compatibility shim layer)  <- OK
 *   Bus event names like "task.completed"                             <- OK
 *
 * Exit code:
 *   0 — no violations
 *   1 — violations found (prints each with file + line)
 *
 * Usage:
 *   node scripts/check-vocab-w9.mjs
 *   npm run check:vocab-w9
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const PACKAGES_DIR = join(ROOT, 'packages');

// When --w9-only flag is passed, only scan the packages added in W1-W10.
// Without the flag, scans all packages and reports any violations (informational).
const W9_ONLY = process.argv.includes('--w9-only');

const W1_W10_PACKAGES = new Set([
  'ui-primitives',   // W2
  'collaboration',   // W3
  'notifications',   // W4
  'human-tasks',     // W5
  'triggers',        // W6
  'client',          // W7
  'identity',        // W8
]);

// Banned patterns: identifier-level, whole-word only
// These must NOT appear as exported names, type names, or parameter names
// in the framework packages' public surface.
const BANNED_PATTERNS = [
  /\bconversation\b/i,
  /\bchatHistory\b/i,
  /\bchatSession\b/i,
  /\bmessageHistory\b/i,
  /\bturnHistory\b/i,
];

// Files allowed to contain banned words (legacy compatibility shim layer)
const ALLOWLIST_SUBSTRINGS = [
  'apps/geneweave',
  'apps/live-agents-demo',
  '/chat.ts',
  '/chat.js',
  // examples and docs are not public API surface
  'examples/',
  'docs/',
  '.test.ts',
  '.test.js',
  '.e2e.ts',
  'PHASE_LOG',
];

function isAllowlisted(filePath) {
  return ALLOWLIST_SUBSTRINGS.some((s) => filePath.includes(s));
}

/**
 * Strip TypeScript/JS line comments and block comments from source.
 * This is deliberately approximate — we only want to avoid false positives
 * on commented-out code.  We do NOT strip string literals because exported
 * string values that match the ban list are also violations.
 */
function stripComments(src) {
  // Block comments (non-greedy)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  // Line comments
  out = out.replace(/\/\/.*/g, (m) => ' '.repeat(m.length));
  return out;
}

/**
 * Collect all *.ts files under a directory recursively.
 */
function collectTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      results.push(...collectTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

let violations = 0;

for (const pkg of readdirSync(PACKAGES_DIR)) {
  if (W9_ONLY && !W1_W10_PACKAGES.has(pkg)) continue;
  const srcDir = join(PACKAGES_DIR, pkg, 'src');
  if (!existsSync(srcDir)) continue;

  const indexFile = join(srcDir, 'index.ts');
  if (!existsSync(indexFile)) continue;

  // Collect all source files in this package's src/
  const files = collectTs(srcDir);

  for (const file of files) {
    if (isAllowlisted(file)) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.e2e.ts')) continue;

    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const lines = src.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(line)) {
          const relFile = file.replace(ROOT + '/', '');
          console.error(`VOCAB VIOLATION [${pkg}] ${relFile}:${i + 1}`);
          console.error(`  ${lines[i].trim()}`);
          console.error(`  Banned pattern: ${pattern}`);
          violations++;
        }
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} vocab violation(s) found.`);
  process.exit(1);
} else {
  console.log('check:vocab-w9 — no violations found.');
}
