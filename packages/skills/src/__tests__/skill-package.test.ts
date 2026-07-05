// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  parseSkillPackage,
  skillPackageToDefinition,
  SkillPackageError,
} from '../skill-package.js';
import {
  skillCardL1,
  skillBodyL2,
  listSkillFiles,
  readSkillFile,
  runSkillScript,
  inferSkillScriptLanguage,
  limitScriptConcurrency,
  skillFileTools,
  SkillResourceError,
  type SkillScriptRunner,
  type SkillScriptRunSpec,
  type SkillScriptResult,
} from '../skill-loader.js';

// ── A realistic skill package: turn a raw sales CSV into a summary. ─────────────────────────────
// This is the shape a real adopter ships: a SKILL.md header + instructions, a reference file that
// documents the method, an asset, and a Python script that does the deterministic number-crunching.
const SALES_FILES: Record<string, string> = {
  'SKILL.md': `---
name: sales-summary
description: Summarise a raw sales CSV into total revenue and the top products. Use when someone hands over sales data and wants the headline numbers without doing the maths by hand.
version: 1.2.0
author: acme-data
license: MIT
tags: [analytics, csv, reporting]
agents: [claude-code, cursor]
allowed-tools: read_file run_script
internal-ref: JIRA-4821
---

# Sales summary

1. Read \`references/methodology.md\` so you use the same definition of "revenue" every time.
2. Run \`scripts/summarize.py\` over the user's CSV.
3. Report the totals in plain language.
`,
  'scripts/summarize.py': `import csv, sys
total = 0.0
counts = {}
with open('sales.csv') as f:
    for row in csv.DictReader(f):
        rev = float(row['qty']) * float(row['price'])
        total += rev
        counts[row['product']] = counts.get(row['product'], 0) + int(row['qty'])
top = max(counts, key=counts.get)
print(f"revenue={total:.2f} top={top}")
`,
  'references/methodology.md': 'Revenue = qty × unit price. Refunds (negative qty) are subtracted.',
  'assets/logo.txt': 'ACME',
};

// ── A minimal fake sandbox that records what it was asked to run. ───────────────────────────────
function makeFakeRunner(
  impl?: (spec: SkillScriptRunSpec) => SkillScriptResult,
): SkillScriptRunner & { calls: SkillScriptRunSpec[]; peakConcurrency: number } {
  const calls: SkillScriptRunSpec[] = [];
  let inFlight = 0;
  const state = { calls, peakConcurrency: 0 };
  return {
    ...state,
    async run(spec) {
      calls.push(spec);
      inFlight++;
      state.peakConcurrency = Math.max(state.peakConcurrency, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return impl ? impl(spec) : { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
}

describe('skill packages — POSITIVE', () => {
  it('parses a full SKILL.md folder: header fields, body, and file classification', () => {
    const pkg = parseSkillPackage(SALES_FILES);
    expect(pkg.name).toBe('sales-summary');
    expect(pkg.description).toMatch(/summarise a raw sales csv/i);
    expect(pkg.version).toBe('1.2.0');
    expect(pkg.license).toBe('MIT');
    expect(pkg.tags).toEqual(['analytics', 'csv', 'reporting']);
    expect(pkg.agents).toEqual(['claude-code', 'cursor']);
    expect(pkg.allowedTools).toEqual(['read_file', 'run_script']); // space-delimited → array
    expect(pkg.body).toMatch(/^# Sales summary/);
    expect(Object.keys(pkg.scripts)).toEqual(['scripts/summarize.py']);
    expect(Object.keys(pkg.resources).sort()).toEqual(['assets/logo.txt', 'references/methodology.md']);
    // Unknown-but-harmless keys are kept as metadata, not rejected (forward-compatible).
    expect(pkg.metadata?.['internal-ref']).toBe('JIRA-4821');
  });

  it('level 1 / level 2 / file list disclose the right amount at each step', () => {
    const pkg = parseSkillPackage(SALES_FILES);
    // L1 is tiny — just enough to decide relevance.
    expect(skillCardL1(pkg)).toBe(`sales-summary: ${pkg.description}`);
    expect(skillCardL1(pkg)).not.toContain('summarize.py'); // no body/scripts leak into the card
    // L2 is the full instructions.
    expect(skillBodyL2(pkg)).toContain('Run `scripts/summarize.py`');
    // L3 inventory.
    expect(listSkillFiles(pkg)).toEqual({
      resources: ['assets/logo.txt', 'references/methodology.md'],
      scripts: ['scripts/summarize.py'],
    });
  });

  it('level 3 read returns a bundled reference file verbatim', () => {
    const pkg = parseSkillPackage(SALES_FILES);
    expect(readSkillFile(pkg, 'references/methodology.md')).toMatch(/Revenue = qty/);
  });

  it('level 3 run hands the script + resources to the sandbox with safe defaults', async () => {
    const pkg = parseSkillPackage(SALES_FILES);
    const runner = makeFakeRunner((spec) => ({ stdout: `ran ${spec.language}`, stderr: '', exitCode: 0 }));
    const res = await runSkillScript({
      pkg,
      path: 'scripts/summarize.py',
      runner,
      inputFiles: { 'sales.csv': 'product,qty,price\nA,2,5\n' },
    });
    expect(res.stdout).toBe('ran python');
    const spec = runner.calls[0]!;
    expect(spec.language).toBe('python');            // inferred from .py
    expect(spec.networkAccess).toBe(false);          // deny egress by default
    expect(spec.timeoutMs).toBeGreaterThan(0);       // always time-bounded
    expect(spec.files!['references/methodology.md']).toBeDefined(); // resources travel with it
    expect(spec.files!['sales.csv']).toBeDefined();  // caller input travels with it
    expect(spec.files!['scripts/summarize.py']).toBeUndefined();    // the script itself is not duplicated as data
  });

  it('bridges a package into a SkillDefinition so it flows through the normal pipeline', () => {
    const def = skillPackageToDefinition(parseSkillPackage(SALES_FILES));
    expect(def.id).toBe('sales-summary');
    expect(def.summary).toMatch(/summarise a raw sales csv/i);        // first sentence → summary
    expect(def.whenToUse).toMatch(/headline numbers/i);              // full description → when-to-use
    expect(def.executionGuidance).toContain('scripts/summarize.py'); // body → guidance
    expect(def.toolNames).toEqual(['read_file', 'run_script']);
  });

  it('exposes read_skill_file + run_skill_script as registerable agent tools', async () => {
    const pkg = parseSkillPackage(SALES_FILES);
    const runner = makeFakeRunner((s) => ({ stdout: 'revenue=10.00 top=A', stderr: '', exitCode: 0, timedOut: false }));
    const tools = skillFileTools(pkg, runner);
    expect(tools.map((t) => t.name)).toEqual(['read_skill_file', 'run_skill_script']);
    const read = await tools[0]!.execute({ path: 'references/methodology.md' });
    expect(read).toMatch(/Revenue = qty/);
    const run = JSON.parse(await tools[1]!.execute({ path: 'scripts/summarize.py' }));
    expect(run).toMatchObject({ exitCode: 0, stdout: 'revenue=10.00 top=A' });
  });

  it('read-only mode: with no runner, only the read tool is exposed', () => {
    const tools = skillFileTools(parseSkillPackage(SALES_FILES));
    expect(tools.map((t) => t.name)).toEqual(['read_skill_file']);
  });

  it('infers the sandbox language from the script extension', () => {
    expect(inferSkillScriptLanguage('scripts/x.py')).toBe('python');
    expect(inferSkillScriptLanguage('scripts/x.sh')).toBe('bash');
    expect(inferSkillScriptLanguage('scripts/x.js')).toBe('node');
    expect(inferSkillScriptLanguage('scripts/x.unknown')).toBe('bash'); // safe fallback
  });
});

describe('skill packages — NEGATIVE', () => {
  it('missing SKILL.md → clear error', () => {
    expect(() => parseSkillPackage({ 'scripts/x.py': 'print(1)' })).toThrow(/missing a SKILL.md/i);
  });

  it('rejects an invalid name (uppercase / spaces)', () => {
    expect(() => parseSkillPackage({ 'SKILL.md': '---\nname: Sales Summary\ndescription: d\n---\n' }))
      .toThrow(SkillPackageError);
  });

  it('enforces name === folder name when a folder is given', () => {
    expect(() => parseSkillPackage(SALES_FILES, { folderName: 'wrong-folder' }))
      .toThrow(/must match its folder name/i);
  });

  it('requires a description, and caps it at 1024 chars', () => {
    expect(() => parseSkillPackage({ 'SKILL.md': '---\nname: x\n---\n' })).toThrow(/description/i);
    const huge = 'a'.repeat(1100);
    expect(() => parseSkillPackage({ 'SKILL.md': `---\nname: x\ndescription: ${huge}\n---\n` }))
      .toThrow(/exceeds 1024/i);
  });

  it('reading a non-existent file → "resource not found", not a crash', () => {
    const pkg = parseSkillPackage(SALES_FILES);
    expect(() => readSkillFile(pkg, 'references/missing.md')).toThrow(/resource not found/i);
  });

  it('running a reference file (not a script) → a clear, specific error', async () => {
    const pkg = parseSkillPackage(SALES_FILES);
    await expect(runSkillScript({ pkg, path: 'references/methodology.md', runner: makeFakeRunner() }))
      .rejects.toThrow(/reference file, not a runnable script/i);
  });

  it('running a non-existent script → "script not found"', async () => {
    const pkg = parseSkillPackage(SALES_FILES);
    await expect(runSkillScript({ pkg, path: 'scripts/ghost.py', runner: makeFakeRunner() }))
      .rejects.toThrow(/script not found/i);
  });
});

describe('skill packages — SECURITY', () => {
  const pkg = parseSkillPackage(SALES_FILES);

  it('blocks path traversal on read (../../etc/passwd)', () => {
    expect(() => readSkillFile(pkg, '../../etc/passwd')).toThrow(/traversal/i);
    expect(() => readSkillFile(pkg, 'references/../../secrets')).toThrow(/traversal/i);
  });

  it('blocks absolute paths on read', () => {
    expect(() => readSkillFile(pkg, '/etc/passwd')).toThrow(/absolute/i);
  });

  it('blocks path traversal / absolute paths on run too', async () => {
    await expect(runSkillScript({ pkg, path: '../evil.py', runner: makeFakeRunner() })).rejects.toThrow(/traversal/i);
    await expect(runSkillScript({ pkg, path: '/tmp/evil.py', runner: makeFakeRunner() })).rejects.toThrow(/absolute/i);
  });

  it('refuses to run a script with no sandbox (never falls back to host execution)', async () => {
    await expect(runSkillScript({ pkg, path: 'scripts/summarize.py', runner: undefined as never }))
      .rejects.toThrow(/without a sandbox|host execution/i);
  });

  it('denies network egress by default even when the caller asks — unless the package declared it', async () => {
    const runner = makeFakeRunner();
    // Caller opts in, but this package's allowed-tools has no network tool → still denied.
    await runSkillScript({ pkg, path: 'scripts/summarize.py', runner, allowNetwork: true });
    expect(runner.calls[0]!.networkAccess).toBe(false);
  });

  it('grants network ONLY when the caller opts in AND the package declared a network tool', async () => {
    const netPkg = parseSkillPackage({
      'SKILL.md': '---\nname: fetch-fx\ndescription: Fetch FX rates from a web API.\nallowed-tools: web_fetch\n---\nbody',
      'scripts/fetch.py': 'import urllib.request as u; print(u.urlopen("https://example.com").status)',
    });
    const runner = makeFakeRunner();
    await runSkillScript({ pkg: netPkg, path: 'scripts/fetch.py', runner, allowNetwork: true });
    expect(runner.calls[0]!.networkAccess).toBe(true);   // opted in + declared
    const runner2 = makeFakeRunner();
    await runSkillScript({ pkg: netPkg, path: 'scripts/fetch.py', runner: runner2 }); // did NOT opt in
    expect(runner2.calls[0]!.networkAccess).toBe(false);
  });
});

describe('skill packages — STRESS', () => {
  it('caps concurrent script runs — 100 requests, at most N containers in flight, all complete', async () => {
    const pkg = parseSkillPackage(SALES_FILES);
    const base = makeFakeRunner();
    const limited = limitScriptConcurrency(base, 4);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => runSkillScript({ pkg, path: 'scripts/summarize.py', runner: limited })),
    );
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
    expect(base.calls).toHaveLength(100);           // every request ran
    expect(base.peakConcurrency).toBeLessThanOrEqual(4); // but never more than 4 at once
  });

  it('parses a large package (200 bundled files) quickly', () => {
    const files: Record<string, string> = {
      'SKILL.md': '---\nname: big\ndescription: A package with many bundled references.\n---\nbody',
    };
    for (let i = 0; i < 200; i++) files[`references/r${i}.md`] = `ref ${i}`.repeat(50);
    const t0 = performance.now();
    const pkg = parseSkillPackage(files);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(Object.keys(pkg.resources)).toHaveLength(200);
  });
});
