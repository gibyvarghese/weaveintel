#!/usr/bin/env node

/**
 * tag-release.mjs — Create a git tag for the current version.
 *
 * Reads version from package.json, resolves the fabric codename,
 * creates an annotated git tag, and prints push instructions.
 *
 * Usage:
 *   npm run release:tag
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const FABRIC_CODENAMES = [
  'Aertex', 'Batiste', 'Calico', 'Damask', 'Etamine', 'Flannel',
  'Gauze', 'Habutai', 'Intarsia', 'Jersey', 'Knit', 'Linen',
  'Muslin', 'Nankeen', 'Organza', 'Percale', 'Rinzu', 'Satin',
  'Taffeta', 'Ultrasuede', 'Velvet', 'Wadmal', 'Zephyr',
];

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const [major] = version.split('.').map(Number);
const codename = FABRIC_CODENAMES[major - 1] || `v${major}`;

const tag = `v${version}`;
const message = `v${version} — ${codename}`;

try {
  // Check if tag already exists
  try {
    execSync(`git rev-parse ${tag}`, { cwd: ROOT, stdio: 'pipe' });
    console.error(`  ❌ Tag ${tag} already exists. Delete it first or bump the version.`);
    process.exit(1);
  } catch {
    // Tag doesn't exist — good
  }

  execSync(`git tag -a "${tag}" -m "${message}"`, { cwd: ROOT, stdio: 'inherit' });
  console.log(`\n  🏷️  Created tag: ${tag}`);
  console.log(`  📝 Message: ${message}`);
  console.log(`\n  Push to GitHub to trigger the release workflow:`);
  console.log(`    git push origin main --tags\n`);
} catch (err) {
  console.error('  ❌ Failed to create tag:', err.message);
  process.exit(1);
}
