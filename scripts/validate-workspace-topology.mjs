#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const rootTsconfigPath = path.join(rootDir, 'tsconfig.json');

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listProjectDirs(baseDir) {
  const absoluteBase = path.join(rootDir, baseDir);
  const entries = await readdir(absoluteBase, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relDir = path.join(baseDir, entry.name);
    const tsconfigPath = path.join(rootDir, relDir, 'tsconfig.json');
    if (await exists(tsconfigPath)) out.push(relDir);
  }
  return out.sort();
}

const rootTsconfigRaw = await readFile(rootTsconfigPath, 'utf8');
const rootTsconfig = JSON.parse(rootTsconfigRaw);
const refs = Array.isArray(rootTsconfig.references) ? rootTsconfig.references : [];
const refSet = new Set(refs.map((ref) => String(ref?.path ?? '')));

const expected = [
  ...(await listProjectDirs('packages')),
  ...(await listProjectDirs('apps')),
].sort();

const missingRefs = expected.filter((projectPath) => !refSet.has(projectPath));

if (missingRefs.length > 0) {
  console.error('\nWorkspace topology check failed: missing root tsconfig references\n');
  for (const projectPath of missingRefs) {
    console.error(`- ${projectPath}`);
  }
  process.exit(1);
}

console.log(`Workspace topology check passed (${expected.length} project references validated).`);
