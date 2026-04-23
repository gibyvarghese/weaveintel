#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const packagesDir = path.join(rootDir, 'packages');
const scanDirs = [path.join(rootDir, 'packages'), path.join(rootDir, 'apps')];

/** @param {string} p */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir */
async function getWorkspacePackageManifestPaths(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgPath = path.join(dir, e.name, 'package.json');
    if (await exists(pkgPath)) out.push(pkgPath);
  }
  return out.sort();
}

/** @param {string} dir */
async function listSourceFiles(dir) {
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.turbo') continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** @param {unknown} exportsField */
function collectExportTargets(exportsField) {
  /** @type {string[]} */
  const targets = [];

  function walk(node) {
    if (!node) return;
    if (typeof node === 'string') {
      targets.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(exportsField);
  return targets;
}

const violations = [];

const packageManifests = await getWorkspacePackageManifestPaths(packagesDir);

for (const manifestPath of packageManifests) {
  const raw = await readFile(manifestPath, 'utf8');
  const pkg = JSON.parse(raw);
  const relPath = path.relative(rootDir, manifestPath);

  if (!pkg.exports || typeof pkg.exports !== 'object') {
    violations.push(`${relPath}: missing exports map`);
    continue;
  }

  const dotExport = pkg.exports['.'];
  if (!dotExport) {
    violations.push(`${relPath}: exports map must include "."`);
  }

  const targets = collectExportTargets(pkg.exports);
  if (targets.length === 0) {
    violations.push(`${relPath}: exports map does not contain concrete targets`);
    continue;
  }

  for (const target of targets) {
    if (!target.startsWith('./dist/')) {
      violations.push(`${relPath}: export target must live under ./dist (found ${target})`);
    }
    if (target.includes('/src/')) {
      violations.push(`${relPath}: export target must not expose src internals (found ${target})`);
    }
  }

  if (pkg.name === '@weaveintel/core') {
    const dependencyBuckets = [
      pkg.dependencies ?? {},
      pkg.peerDependencies ?? {},
      pkg.optionalDependencies ?? {},
    ];

    for (const deps of dependencyBuckets) {
      for (const depName of Object.keys(deps)) {
        if (depName.startsWith('@weaveintel/')) {
          violations.push(`${relPath}: @weaveintel/core must not depend on other @weaveintel/* packages (${depName})`);
        }
      }
    }
  }
}

const deepImportRe = /from\s+['\"](@weaveintel\/[\w-]+\/(src|dist)\/[^'\"]+)['\"]/g;

for (const dir of scanDirs) {
  const sourceFiles = await listSourceFiles(dir);
  for (const filePath of sourceFiles) {
    const content = await readFile(filePath, 'utf8');
    for (const match of content.matchAll(deepImportRe)) {
      const relFile = path.relative(rootDir, filePath);
      violations.push(`${relFile}: deep import into package internals is not allowed (${match[1]})`);
    }
  }
}

if (violations.length > 0) {
  console.error('\nPhase 3H public API boundary check failed:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Phase 3H public API boundary check passed.');
