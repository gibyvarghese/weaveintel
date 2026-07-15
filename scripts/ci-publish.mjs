#!/usr/bin/env node
// ci-publish.mjs — guarded wrapper around `changeset publish`.
//
// WHY THIS EXISTS
//   The Release workflow (.github/workflows/release.yml) runs the Changesets action on every
//   push to `main`. When there are no pending changesets the action calls the publish command —
//   which is correct after a "Version Packages" PR merges, but on an ORDINARY push (a normal
//   feature/fix merge with no changeset) there is nothing new to release. Bare `changeset publish`
//   nonetheless attempts to publish the already-on-npm versions and fails with
//   "You cannot publish over the previously published versions: X.Y.Z", turning `main` red.
//
//   This wrapper first asks npm which of our publishable packages have a version that is NOT yet
//   on the registry. If none, it exits 0 (clean no-op). If some, it delegates to `changeset
//   publish`, which publishes exactly those newly-bumped packages (via Trusted Publishing / OIDC).
//
// It parses no error output and hides no real failure: a genuine release still runs the real
// `changeset publish`, and any auth/tarball/network error there propagates as a non-zero exit.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Packages the Changesets config never versions/publishes (demo/reference apps).
const ignore = new Set(
  JSON.parse(readFileSync(join(repoRoot, '.changeset', 'config.json'), 'utf8')).ignore ?? [],
);

// Enumerate every workspace package.json under the standard roots.
const workspaceGlobs = ['packages', 'apps', 'clients'];
const candidates = [];
for (const root of workspaceGlobs) {
  const dir = join(repoRoot, root);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, 'package.json');
    if (existsSync(pkgPath)) candidates.push(pkgPath);
  }
}

// A package is publishable if it isn't private and isn't on the ignore list.
const publishable = [];
for (const pkgPath of candidates) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.name || pkg.private === true || ignore.has(pkg.name)) continue;
  publishable.push({ name: pkg.name, version: pkg.version });
}

// Ask npm which local versions are missing from the registry.
const needsPublish = [];
for (const { name, version } of publishable) {
  let published = [];
  try {
    // `npm view <name> versions --json` is a public read; no auth required.
    const out = execFileSync('npm', ['view', `${name}`, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = out ? JSON.parse(out) : [];
    published = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // A 404 (package never published) or empty response ⇒ this version is unpublished.
    published = [];
  }
  if (!published.includes(version)) needsPublish.push(`${name}@${version}`);
}

if (needsPublish.length === 0) {
  console.log('ci-publish: all publishable package versions are already on npm — nothing to publish.');
  process.exit(0);
}

console.log(`ci-publish: ${needsPublish.length} unpublished version(s) — running changeset publish:`);
for (const p of needsPublish) console.log(`  • ${p}`);

// Delegate to the real publisher. Inherit stdio so provenance/OIDC output is visible; propagate
// its exit code so genuine publish failures still fail the workflow.
const result = spawnSync('npx', ['changeset', 'publish'], { cwd: repoRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
