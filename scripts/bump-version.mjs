#!/usr/bin/env node

/**
 * bump-version.mjs — Bump the monorepo version with fabric codename awareness.
 *
 * Usage:
 *   npm run release:bump -- major    # 1.x.x → 2.0.0, advances fabric codename
 *   npm run release:bump -- minor    # 1.0.x → 1.1.0, same fabric
 *   npm run release:bump -- patch    # 1.0.0 → 1.0.1, same fabric
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const FABRIC_CODENAMES = [
  'Aertex',     // 1
  'Batiste',    // 2
  'Calico',     // 3
  'Damask',     // 4
  'Etamine',    // 5
  'Flannel',    // 6
  'Gauze',      // 7
  'Habutai',    // 8
  'Intarsia',   // 9
  'Jersey',     // 10
  'Knit',       // 11
  'Linen',      // 12
  'Muslin',     // 13
  'Nankeen',    // 14
  'Organza',    // 15
  'Percale',    // 16
  'Rinzu',      // 17
  'Satin',      // 18
  'Taffeta',    // 19
  'Ultrasuede', // 20
  'Velvet',     // 21
  'Wadmal',     // 22
  'Zephyr',     // 23
];

function getFabricName(major) {
  const idx = major - 1;
  if (idx < 0 || idx >= FABRIC_CODENAMES.length) {
    return `v${major}`;
  }
  return FABRIC_CODENAMES[idx];
}

const ROOT = new URL('..', import.meta.url).pathname;
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const [major, minor, patch] = pkg.version.split('.').map(Number);
const bump = process.argv[2];

if (!['major', 'minor', 'patch'].includes(bump)) {
  console.error('Usage: npm run release:bump -- <major|minor|patch>');
  process.exit(1);
}

let newMajor = major;
let newMinor = minor;
let newPatch = patch;

if (bump === 'major') {
  newMajor = major + 1;
  newMinor = 0;
  newPatch = 0;
} else if (bump === 'minor') {
  newMinor = minor + 1;
  newPatch = 0;
} else {
  newPatch = patch + 1;
}

const newVersion = `${newMajor}.${newMinor}.${newPatch}`;
const codename = getFabricName(newMajor);

// Update root package.json
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Update all workspace package versions
const workspaceDirs = execSync('ls -d packages/*/', { cwd: ROOT, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

for (const dir of workspaceDirs) {
  const wpkgPath = join(ROOT, dir, 'package.json');
  try {
    const wpkg = JSON.parse(readFileSync(wpkgPath, 'utf8'));
    wpkg.version = newVersion;
    writeFileSync(wpkgPath, JSON.stringify(wpkg, null, 2) + '\n');
  } catch {
    // Skip directories without package.json
  }
}

console.log(`\n  🧶 Version bumped: ${major}.${minor}.${patch} → ${newVersion}`);
console.log(`  🏷️  Codename: ${codename}`);
if (bump === 'major') {
  console.log(`  🎉 New major release! Fabric advanced to "${codename}"`);
}
console.log(`\n  Next steps:`);
console.log(`    1. Update CHANGELOG.md with release notes`);
console.log(`    2. Commit: git commit -am "release: v${newVersion} — ${codename}"`);
console.log(`    3. Tag:    npm run release:tag\n`);
