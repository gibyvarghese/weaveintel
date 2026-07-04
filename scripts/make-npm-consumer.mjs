#!/usr/bin/env node
// Materialise the geneWeave apps as a STANDALONE, npm-consuming workspace — the same shape an
// outside adopter (or the private commercial repo) uses: apps only, with every `@weaveintel/*`
// dependency resolved from the npm registry instead of the local `packages/` workspace.
//
// This is the single source of truth for "what the app looks like when it stands on its own",
// shared by:
//   • .github/workflows/integration-npm-consume.yml  (CI: does the PUBLISHED framework still
//     satisfy the app end to end?)
//   • the community-app-as-its-own-repo prototype (side-by-side comparison before any split)
//
// Usage:
//   node scripts/make-npm-consumer.mjs <targetDir> [--version <semver|dist-tag>] [--force]
//
//   <targetDir>        where to create the standalone workspace (must be empty unless --force)
//   --version <v>      pin every @weaveintel/* dep to this version/tag (e.g. 0.1.1, ^0.1.1, latest).
//                      Omit to keep whatever the app package.json already declares (^0.1.1).
//   --force            overwrite a non-empty target directory
//
// It does NOT run `npm install` — the caller does, so the same generator works locally and in CI.

import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['apps/geneweave', 'apps/geneweave-ui']; // the community edition = these two only
const ROOT_FILES = ['tsconfig.base.json', 'turbo.json']; // extended/needed by the app builds

// Never copy build output, installed deps, caches, or generated scratch into the standalone repo.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'test-results', 'playwright-report']);
const SKIP_SUFFIX = ['.tsbuildinfo'];
const SKIP_PATH_CONTAINS = [`docs-samples${sep}.generated`];

function parseArgs(argv) {
  const args = { version: null, force: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = argv[++i];
    else if (a === '--force') args.force = true;
    else if (!a.startsWith('--') && !args.target) args.target = a;
  }
  return args;
}

function copyFiltered(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = relative(src, from);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (parts.some((p) => SKIP_DIRS.has(p))) return false;
      if (SKIP_SUFFIX.some((s) => from.endsWith(s))) return false;
      if (SKIP_PATH_CONTAINS.some((s) => from.includes(s))) return false;
      return true;
    },
  });
}

// Strip project references that point at the monorepo's `packages/*` (they come from npm now);
// keep sibling-app references (e.g. geneweave-api → geneweave-ui) which still resolve locally.
function rewriteTsconfig(tsconfigPath) {
  if (!existsSync(tsconfigPath)) return;
  const tc = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  if (Array.isArray(tc.references)) {
    const kept = tc.references.filter((r) => !String(r.path).replace(/\\/g, '/').includes('../../packages/'));
    if (kept.length) tc.references = kept;
    else delete tc.references;
  }
  writeFileSync(tsconfigPath, JSON.stringify(tc, null, 2) + '\n');
}

// Point every @weaveintel/* dependency at the registry version; keep the sibling app as a
// workspace ('*'), since geneweave-ui is not published.
function rewriteAppPackageJson(pkgPath, version) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let changed = 0;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@weaveintel/')) continue;
      if (name === '@weaveintel/geneweave-ui' || name === '@weaveintel/geneweave-api') {
        deps[name] = '*'; // local workspace apps, never on npm
      } else if (version) {
        deps[name] = version;
        changed++;
      }
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return changed;
}

function main() {
  const { target, version, force } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error('usage: node scripts/make-npm-consumer.mjs <targetDir> [--version <v>] [--force]');
    process.exit(2);
  }
  const dest = resolve(target);
  if (dest === REPO) { console.error('refusing to target the repo itself'); process.exit(2); }
  if (existsSync(dest) && readdirSync(dest).length) {
    if (!force) { console.error(`target ${dest} is not empty (use --force)`); process.exit(2); }
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  // 1) apps (the community edition)
  for (const app of APPS) {
    const from = join(REPO, app);
    if (!existsSync(from)) { console.error(`missing ${app}`); process.exit(1); }
    copyFiltered(from, join(dest, app));
  }

  // 2) shared root config the app builds extend/need
  for (const f of ROOT_FILES) {
    const from = join(REPO, f);
    if (existsSync(from)) cpSync(from, join(dest, f));
  }

  // 3) a clean, apps-only root package.json (workspaces: apps/*), reusing the repo's dev toolchain
  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const consumerRoot = {
    name: 'geneweave-community',
    version: '0.0.0',
    private: true,
    type: rootPkg.type ?? 'module',
    description: 'geneWeave community edition — the geneWeave apps consuming @weaveintel/* from npm.',
    license: 'MIT',
    workspaces: ['apps/*'],
    scripts: {
      build: 'turbo build',
      typecheck: 'turbo typecheck',
      test: 'turbo test',
      dev: 'npm run dev --workspace @weaveintel/geneweave-api',
      start: 'npm run start --workspace @weaveintel/geneweave-api',
    },
    devDependencies: rootPkg.devDependencies ?? {},
    engines: rootPkg.engines ?? { node: '>=20.0.0' },
    packageManager: rootPkg.packageManager,
  };
  writeFileSync(join(dest, 'package.json'), JSON.stringify(consumerRoot, null, 2) + '\n');

  // 4) a clean root tsconfig that references only the apps (no dangling packages/* refs)
  writeFileSync(
    join(dest, 'tsconfig.json'),
    JSON.stringify({ files: [], references: APPS.map((p) => ({ path: p })) }, null, 2) + '\n',
  );

  // 5) reconcile the app tsconfigs + package.json deps to standalone/npm-consumption
  let totalRepinned = 0;
  for (const app of APPS) {
    rewriteTsconfig(join(dest, app, 'tsconfig.json'));
    totalRepinned += rewriteAppPackageJson(join(dest, app, 'package.json'), version);
  }

  // 6) a short README so the directory explains itself
  writeFileSync(
    join(dest, 'README.md'),
    [
      '# geneWeave community edition (npm-consuming)',
      '',
      'Generated by `scripts/make-npm-consumer.mjs` in the weaveIntel repo. This is the geneWeave',
      'apps (`geneweave`, `geneweave-ui`) standing on their own, consuming the framework as published',
      '`@weaveintel/*` npm packages — exactly how an outside adopter or the private commercial repo',
      'uses it. There is no `packages/` here.',
      '',
      '```bash',
      'npm install      # pulls @weaveintel/* from the registry',
      'npm run build',
      'npm run typecheck',
      'npm test         # unit tests (Playwright e2e need a running server)',
      '```',
      '',
      version ? `Framework pinned at: \`${version}\`` : 'Framework version: as declared by the apps (`^0.1.1`).',
    ].join('\n') + '\n',
  );

  console.log(`✓ standalone npm-consumer written → ${dest}`);
  console.log(`  apps: ${APPS.join(', ')}`);
  console.log(`  @weaveintel/* pinned to: ${version ?? '(unchanged — app default ^0.1.1)'}${version ? ` (${totalRepinned} deps repinned)` : ''}`);
  console.log(`  next: (cd ${dest} && npm install && npm run build && npm test)`);
}

main();
