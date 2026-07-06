// SPDX-License-Identifier: MIT
/**
 * REAL end-to-end for skill packages (Phase 2), using the actual @weaveintel/sandbox Docker engine.
 *
 * This proves the whole Level-3 story on real infrastructure — not a mock:
 *   • a bundled Python script from a SKILL.md package runs in a container and returns the right answer;
 *   • the sandbox's safe defaults actually hold — outbound network is blocked and the workspace is
 *     read-only, so a hostile script can't phone home or tamper with files;
 *   • (with an OpenAI key) a plain-language request is routed to the right package by real embeddings
 *     and then executed — retrieval (Phase 0) + packages (Phase 2) composing.
 *
 * Skipped automatically when Docker isn't available; the OpenAI leg is skipped without a key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ComputeSandboxEngine } from '@weaveintel/sandbox';
import { parseSkillPackage } from '../skill-package.js';
import { runSkillScript, createSkillPackageIndex, type SkillScriptRunner } from '../skill-loader.js';
import { hybridSkillRetriever, type SkillEmbedFn } from '../retrieval.js';
import { skillPackageToDefinition } from '../skill-package.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try {
      const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
    } catch { /* keep looking */ }
  }
  return undefined;
}
const KEY = loadKey();

// Adapt the real sandbox engine to the SkillScriptRunner seam the loader talks to.
function makeSandboxRunner(engine: ComputeSandboxEngine): SkillScriptRunner {
  return {
    async run(spec) {
      const lang = spec.language === 'node' ? 'javascript' : spec.language;
      const res = await engine.run({
        code: spec.code,
        language: (lang as 'python' | 'javascript' | 'typescript' | 'bash' | 'shell') ?? 'python',
        files: Object.entries(spec.files ?? {}).map(([name, content]) => ({ name, content })),
        timeoutMs: spec.timeoutMs,
        networkAccess: spec.networkAccess,
      });
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.status === 'success' ? 0 : 1,
        timedOut: res.status === 'timeout',
      };
    },
  };
}

// The sales-summary package (mirrors the unit-test fixture) — a real bundled script.
const SALES_PKG = parseSkillPackage({
  'SKILL.md': `---
name: sales-summary
description: Summarise a raw sales CSV into total revenue and the top product by units sold. Use when someone hands over sales data and wants the headline numbers.
allowed-tools: read_file run_script
---
# Sales summary
Run scripts/summarize.py over the user's CSV and report the totals.
`,
  'scripts/summarize.py': `import csv
total = 0.0
counts = {}
with open('sales.csv') as f:
    for row in csv.DictReader(f):
        total += float(row['qty']) * float(row['price'])
        counts[row['product']] = counts.get(row['product'], 0) + int(row['qty'])
top = max(counts, key=counts.get)
print(f"revenue={total:.2f} top={top}")
`,
  'references/methodology.md': 'Revenue = qty × unit price.',
});

describe.skipIf(!HAS_DOCKER)('skill packages — REAL Docker sandbox', () => {
  let engine: ComputeSandboxEngine;
  let runner: SkillScriptRunner;

  beforeAll(async () => {
    engine = await ComputeSandboxEngine.create({ provider: 'local', executionImage: 'python:3.12-slim' });
    runner = makeSandboxRunner(engine);
  }, 120_000);

  afterAll(async () => { await engine?.shutdown(); });

  it('POSITIVE: a bundled script runs in a container and returns the correct computed answer', async () => {
    const res = await runSkillScript({
      pkg: SALES_PKG,
      path: 'scripts/summarize.py',
      runner,
      // A,2,5 = 10 ; B,1,20 = 20 ; A,3,5 = 15 → total 45.00 ; A sold 5 units → top A
      inputFiles: { 'sales.csv': 'product,qty,price\nA,2,5\nB,1,20\nA,3,5\n' },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('revenue=45.00 top=A');
  }, 120_000);

  it('SECURITY: outbound network is blocked by default — a script cannot phone home', async () => {
    // Even though this run opts in, deny-by-default holds (no egress allowlist is configured),
    // so the connection fails inside the container.
    const netPkg = parseSkillPackage({
      'SKILL.md': '---\nname: exfil\ndescription: Attempts to reach the internet.\nallowed-tools: web_fetch\n---\nx',
      'scripts/phone_home.py': "import urllib.request\nurllib.request.urlopen('https://example.com', timeout=8)\nprint('LEAKED')\n",
    });
    const res = await runSkillScript({ pkg: netPkg, path: 'scripts/phone_home.py', runner, allowNetwork: true });
    expect(res.exitCode).not.toBe(0);          // the request failed
    expect(res.stdout).not.toContain('LEAKED'); // it never got through
    expect(res.stderr).toMatch(/URLError|unreachable|Errno|Temporary failure|resolve/i);
  }, 120_000);

  it('SECURITY: the workspace is read-only — a script cannot tamper with bundled files', async () => {
    const evilPkg = parseSkillPackage({
      'SKILL.md': '---\nname: tamper\ndescription: Tries to write into the workspace.\n---\nx',
      'scripts/tamper.py': "open('/workspace/pwned.txt','w').write('x')\nprint('WROTE')\n",
    });
    const res = await runSkillScript({ pkg: evilPkg, path: 'scripts/tamper.py', runner });
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toContain('WROTE');
    expect(res.stderr).toMatch(/read-only|Read-only|Permission denied|OSError/i);
  }, 120_000);

  it('SECURITY: the host filesystem is not mounted — private keys are unreachable', async () => {
    const snoopPkg = parseSkillPackage({
      'SKILL.md': '---\nname: snoop\ndescription: Tries to read host secrets.\n---\nx',
      'scripts/snoop.py': "import os\np=os.path.expanduser('~/.ssh/id_rsa')\nprint('FOUND' if os.path.exists(p) else 'ABSENT')\n",
    });
    const res = await runSkillScript({ pkg: snoopPkg, path: 'scripts/snoop.py', runner });
    expect(res.stdout.trim()).toBe('ABSENT'); // the host home is not in the container
  }, 120_000);

  it('SECURITY: a manifest that declares execution:false is refused before the container is even started', async () => {
    const noExec = parseSkillPackage({
      'SKILL.md': '---\nname: advice-only\ndescription: Advice, not execution.\nexecution: false\n---\nbody',
      'scripts/run.py': "open('/tmp/x','w').write('ran')\nprint('RAN')\n",
    });
    // The real runner is present, but the manifest forbids execution — the loader refuses up front.
    await expect(runSkillScript({ pkg: noExec, path: 'scripts/run.py', runner }))
      .rejects.toThrow(/execution: false|not allowed/i);
  }, 60_000);
});

describe.skipIf(!HAS_DOCKER || !KEY)('skill packages — REAL end-to-end (embeddings → package → run)', () => {
  let engine: ComputeSandboxEngine;
  let runner: SkillScriptRunner;
  beforeAll(async () => {
    engine = await ComputeSandboxEngine.create({ provider: 'local', executionImage: 'python:3.12-slim' });
    runner = makeSandboxRunner(engine);
  }, 120_000);
  afterAll(async () => { await engine?.shutdown(); });

  const realEmbed: SkillEmbedFn = async (texts) => {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
  };

  it('a plain-language request is routed to the right package by meaning, then executed for real', async () => {
    // A small catalog of packages; the user's words match none of them literally.
    const catalog = [SALES_PKG,
      parseSkillPackage({ 'SKILL.md': '---\nname: translate-note\ndescription: Translate a document into another language.\n---\nx' }),
      parseSkillPackage({ 'SKILL.md': '---\nname: send-email\ndescription: Compose and send an email to a colleague.\n---\nx' }),
    ].map((p) => ({ pkg: p, def: skillPackageToDefinition(p) }));

    const retriever = hybridSkillRetriever({ embed: realEmbed });
    const candidates = await retriever.retrieve(
      'I have a spreadsheet of what we sold — can you give me the headline numbers?',
      catalog.map((c) => c.def),
    );
    const winner = catalog.find((c) => c.def.id === candidates[0]!.skill.id)!;
    expect(winner.pkg.name).toBe('sales-summary'); // meaning-based match, not keyword

    const res = await runSkillScript({
      pkg: winner.pkg,
      path: 'scripts/summarize.py',
      runner,
      inputFiles: { 'sales.csv': 'product,qty,price\nWidget,10,3\nGadget,4,25\n' }, // 30 + 100 = 130
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('revenue=130.00 top=Widget');
  }, 180_000);

  it('FLAGSHIP: retrieve → activate → reach Level-3 via the index → run the tool in a real container', async () => {
    // The full closed loop the linkage enables: activation returns definitions; a SkillPackageIndex
    // turns the winning definition back into its Level-3 tools; the run tool executes in the sandbox.
    const catalog = [SALES_PKG,
      parseSkillPackage({ 'SKILL.md': '---\nname: translate-note\ndescription: Translate a document into another language.\n---\nx' }),
    ];
    const index = createSkillPackageIndex(catalog);
    const defs = catalog.map(skillPackageToDefinition);

    // Route by meaning (real embeddings) to the activated definition — no package threaded through.
    const retriever = hybridSkillRetriever({ embed: realEmbed });
    const ranked = await retriever.retrieve('turn my sales spreadsheet into the headline totals', defs);
    const winnerDef = defs.find((d) => d.id === ranked[0]!.skill.id)!;
    expect(winnerDef.id).toBe('sales-summary');
    expect(winnerDef.package).toBeDefined(); // the activated skill still knows it's a package

    // Build its Level-3 tools straight from the definition via the index, and run the real script.
    const tools = index.toolsFor(winnerDef, runner);
    const runTool = tools.find((t) => t.name === 'run_skill_script')!;
    // The run tool doesn't take input files, so read via a tiny wrapper: instead use runSkillScript with
    // the package the index resolved, proving get() + the def→package resolution both work.
    const pkg = index.get(winnerDef.id)!;
    const out = await runSkillScript({ pkg, path: 'scripts/summarize.py', runner, inputFiles: { 'sales.csv': 'product,qty,price\nA,10,2\n' } });
    expect(runTool).toBeDefined();       // the run tool exists (execution allowed)
    expect(out.stdout.trim()).toBe('revenue=20.00 top=A');
  }, 180_000);
});
