import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTemplates, scaffold, type TemplateType } from './scaffold.js';

// packages/devtools/src -> repo root is three levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every package name declared anywhere in this monorepo (packages/clients/apps). */
function workspacePackageNames(): Set<string> {
  const names = new Set<string>();
  for (const group of ['packages', 'clients', 'apps']) {
    const dir = join(REPO_ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const pkgJson = join(dir, entry, 'package.json');
      if (!existsSync(pkgJson)) continue;
      try {
        const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name;
        if (name) names.add(name);
      } catch {
        /* ignore unreadable manifests */
      }
    }
  }
  return names;
}

// Real, universally-available npm packages the templates legitimately reference
// (build tooling etc.). Add to this set when a template gains a genuine external dep.
const KNOWN_EXTERNAL = new Set(['typescript']);

describe('scaffold templates — every declared dependency resolves', () => {
  const workspace = workspacePackageNames();
  const templates = listTemplates();

  it('exposes all built-in templates', () => {
    expect(templates.length).toBeGreaterThanOrEqual(7);
  });

  // The regression this guards against: a template that ships a dependency on a
  // package that does not exist (e.g. the old phantom `@weaveintel/geneweave`),
  // which makes `npm install` fail the moment an adopter runs the scaffold.
  for (const { type } of templates) {
    it(`"${type}" names only dependencies that resolve (in-workspace or known npm)`, () => {
      const tpl = scaffold({ projectName: 'demo-app', template: type as TemplateType });
      const declared = [...tpl.dependencies, ...tpl.devDependencies];
      const unresolved = declared.filter(
        (dep) => !workspace.has(dep) && !KNOWN_EXTERNAL.has(dep),
      );
      expect(
        unresolved,
        `template "${type}" declares dependencies that resolve to nothing: ${unresolved.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('no template references a non-existent @weaveintel/* package', () => {
    for (const { type } of templates) {
      const tpl = scaffold({ projectName: 'demo-app', template: type as TemplateType });
      for (const dep of [...tpl.dependencies, ...tpl.devDependencies]) {
        if (dep.startsWith('@weaveintel/')) {
          expect(
            workspace.has(dep),
            `template "${type}" depends on ${dep}, which is not a real workspace package`,
          ).toBe(true);
        }
      }
    }
  });

  it('every template ships at least one dependency and a runnable entry file', () => {
    for (const { type } of templates) {
      const tpl = scaffold({ projectName: 'demo-app', template: type as TemplateType });
      expect(tpl.dependencies.length, `"${type}" has no dependencies`).toBeGreaterThan(0);
      expect(tpl.files.some((f) => f.path.endsWith('.ts')), `"${type}" has no .ts file`).toBe(true);
    }
  });
});
