// SPDX-License-Identifier: MIT
/**
 * Phase-2 completion: the package↔definition link + the SkillPackageIndex.
 *
 * A skill package compiles to a `SkillDefinition` so it flows through retrieval/activation — but until
 * now that bridge was one-way and lossy: the definition lost its least-privilege manifest and there
 * was no way back to the package's bundled files. These tests prove the loop is now closed —
 * an activated skill carries its manifest, and a `SkillPackageIndex` turns it back into Level-3 tools.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSkillPackage,
  skillPackageToDefinition,
  skillPackageRef,
  createSkillPackageIndex,
  defineSkill,
  type SkillScriptRunner,
} from '../index.js';

const makeRunner = (): SkillScriptRunner & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return { calls, async run(spec) { calls.push(spec); return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
};

const PKG_FILES = {
  'SKILL.md': [
    '---',
    'name: revenue-report',
    'description: Compute monthly revenue from a sales CSV and write a short report. Use for finance summaries.',
    'version: 1.2.0',
    'network: [api.rates.example.com]',
    'allowed-tools: read_file run_script',
    '---',
    'Load the CSV, sum the `amount` column, and write a two-line report.',
  ].join('\n'),
  'references/schema.md': '# Columns\n- date\n- amount',
  'scripts/report.py': 'print("revenue=130.00")',
};

describe('Phase 2 — package↔definition linkage', () => {
  // ── Positive ────────────────────────────────────────────────────────────────
  it('a bridged definition carries its package pointer (manifest + file names, not contents)', () => {
    const pkg = parseSkillPackage(PKG_FILES);
    const def = skillPackageToDefinition(pkg);
    expect(def.id).toBe('revenue-report');
    expect(def.package).toBeDefined();
    expect(def.package!.name).toBe('revenue-report');
    expect(def.package!.manifest.network).toEqual(['api.rates.example.com']); // least-privilege travels with the skill
    expect(def.package!.scripts).toEqual(['scripts/report.py']);
    expect(def.package!.resources).toEqual(['references/schema.md']);
    // The heavy file *contents* are NOT copied onto the definition — only names.
    expect(JSON.stringify(def.package)).not.toContain('revenue=130.00');
  });

  it('skillPackageRef sorts file names deterministically', () => {
    const pkg = parseSkillPackage({
      'SKILL.md': '---\nname: multi\ndescription: many files here for ordering.\n---\nx',
      'scripts/z.py': '1', 'scripts/a.py': '1', 'references/m.md': 'x', 'assets/b.txt': 'x',
    });
    const ref = skillPackageRef(pkg);
    expect(ref.scripts).toEqual(['scripts/a.py', 'scripts/z.py']);
    expect(ref.resources).toEqual(['assets/b.txt', 'references/m.md']);
  });

  it('the index reaches Level-3 tools from a skill id, an activated definition, or the package', async () => {
    const pkg = parseSkillPackage(PKG_FILES);
    const def = skillPackageToDefinition(pkg);
    const runner = makeRunner();
    const index = createSkillPackageIndex([pkg]);

    for (const key of ['revenue-report', def, pkg] as const) {
      const tools = index.toolsFor(key, runner);
      expect(tools.map((t) => t.name).sort()).toEqual(['read_skill_file', 'run_skill_script']);
      // The read tool actually resolves the package's file.
      const read = tools.find((t) => t.name === 'read_skill_file')!;
      expect(await read.execute({ path: 'references/schema.md' })).toContain('amount');
    }
    expect(index.get('revenue-report')).toBe(pkg);
    expect(index.all()).toHaveLength(1);
  });

  it('read-only tools when no runner is supplied', () => {
    const pkg = parseSkillPackage(PKG_FILES);
    const index = createSkillPackageIndex([pkg]);
    const tools = index.toolsFor('revenue-report'); // no runner
    expect(tools.map((t) => t.name)).toEqual(['read_skill_file']);
  });

  // ── Negative ────────────────────────────────────────────────────────────────
  it('a plain (non-package) skill yields no Level-3 tools — safe to call over every activated skill', () => {
    const plain = defineSkill({ id: 'plain', name: 'plain', summary: 'just advice' });
    expect(plain.package).toBeUndefined();
    const index = createSkillPackageIndex([parseSkillPackage(PKG_FILES)]);
    expect(index.toolsFor(plain, makeRunner())).toEqual([]); // no package → no tools, no throw
    expect(index.toolsFor('does-not-exist')).toEqual([]);
    expect(index.get('does-not-exist')).toBeUndefined();
  });

  // ── Security ────────────────────────────────────────────────────────────────
  it('an execution:false package exposes read but NOT run — even through the index', () => {
    const pkg = parseSkillPackage({
      'SKILL.md': '---\nname: no-exec\ndescription: advice only, no scripts.\nexecution: false\n---\nbody',
      'scripts/x.py': 'print(1)',
      'references/r.md': 'ref',
    });
    const def = skillPackageToDefinition(pkg);
    expect(def.package!.manifest.execution).toBe(false); // the posture is visible on the activated skill
    const tools = createSkillPackageIndex([pkg]).toolsFor(def, makeRunner());
    expect(tools.map((t) => t.name)).toEqual(['read_skill_file']); // run tool withheld
  });

  it('the manifest on the definition is exactly the declared least-privilege — a caller can inspect before granting', () => {
    const pkg = parseSkillPackage({
      'SKILL.md': '---\nname: scoped\ndescription: scoped skill.\nnetwork: [a.example.com, b.example.com]\nsecrets: [OPENAI_API_KEY]\n---\nx',
      'scripts/s.py': '1',
    });
    const def = skillPackageToDefinition(pkg);
    expect(def.package!.manifest.network).toEqual(['a.example.com', 'b.example.com']);
    expect(def.package!.manifest.secrets).toEqual(['OPENAI_API_KEY']);
    expect(def.package!.manifest.execution).toBe(true);
  });

  // ── Stress ──────────────────────────────────────────────────────────────────
  it('index build + lookup stays fast for a large catalog (5,000 packages)', () => {
    const pkgs = Array.from({ length: 5000 }, (_, i) =>
      parseSkillPackage({ 'SKILL.md': `---\nname: skill-${i}\ndescription: skill number ${i} does a thing.\n---\nbody`, 'scripts/x.py': 'print(1)' }));
    const t0 = performance.now();
    const index = createSkillPackageIndex(pkgs);
    const built = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 5000; i++) expect(index.get(`skill-${i}`)).toBeDefined();
    const looked = performance.now() - t1;
    expect(index.all()).toHaveLength(5000);
    expect(built).toBeLessThan(1000);
    expect(looked).toBeLessThan(200);
  });
});
