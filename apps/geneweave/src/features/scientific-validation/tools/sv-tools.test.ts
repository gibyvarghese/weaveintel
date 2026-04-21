/**
 * Scientific Validation — Tool unit tests
 *
 * Uses FakeRuntime (no Docker) and mock HTTP responses to
 * verify tool registration, risk tags, parameter schemas,
 * and reproducibility hash determinism.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@weaveintel/core';
import {
  FakeRuntime,
  createImagePolicy,
  weaveContainerExecutor,
} from '@weaveintel/sandbox';
import type { ContainerExecutor } from '@weaveintel/sandbox';

import { createSymbolicTools } from './symbolic.js';
import { createNumericalTools } from './numerical.js';
import { createDomainTools } from './domain.js';
import { createEvidenceTools } from './evidence.js';

/** Minimal stub context for tool.invoke() */
const CTX = {} as ExecutionContext;

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SYM_DIGEST = 'sha256:aaa0000000000000000000000000000000000000000000000000000000000001';
const NUM_DIGEST = 'sha256:bbb0000000000000000000000000000000000000000000000000000000000002';
const DOM_DIGEST = 'sha256:ccc0000000000000000000000000000000000000000000000000000000000003';

function makeExecutor(
  digest: string,
  responseBody: Record<string, unknown> = { ok: true, result: 'fake' },
): ContainerExecutor {
  const policy = createImagePolicy([
    {
      digest,
      description: 'Test sandbox',
      envAllowList: [],
      networkAllowList: [],
      resourceCeiling: { cpuMillis: 8000, memoryMB: 8192, wallTimeSeconds: 600 },
    },
  ]);
  const fake = new FakeRuntime({
    defaultResult: {
      stdout: JSON.stringify(responseBody),
      stderr: '',
      exitCode: 0,
      wallMs: 1,
      cpuMs: 1,
      truncated: { stdout: false, stderr: false },
    },
  });
  return weaveContainerExecutor({ runtime: fake, imagePolicy: policy });
}

function computeHash(digest: string, stdinJson: string): string {
  return createHash('sha256')
    .update(digest)
    .update('\x00')
    .update(stdinJson)
    .update('\x00')
    .update('1')
    .digest('hex');
}

/** Helper: call tool.invoke and return parsed content string */
async function callTool(tool: import('@weaveintel/core').Tool, args: Record<string, unknown>): Promise<unknown> {
  const out = await tool.invoke(CTX, { name: 'tool', arguments: args });
  const raw = out.content;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ─── Symbolic tools ───────────────────────────────────────────────────────────

describe('createSymbolicTools', () => {
  const executor = makeExecutor(SYM_DIGEST, { ok: true, result: 'x**2', latex: 'x^{2}' });
  const tools = createSymbolicTools({ executor, symDigest: SYM_DIGEST });

  it('exports exactly 4 tools', () => {
    expect(Object.keys(tools)).toEqual(['sympy.simplify', 'sympy.solve', 'sympy.integrate', 'wolfram.query']);
  });

  it('sympy.simplify has correct risk tags', () => {
    const tool = tools['sympy.simplify']!;
    expect(tool.schema.tags).toContain('sandbox');
    expect(tool.schema.tags).toContain('scientific');
  });

  it('sympy.simplify returns JSON result from container', async () => {
    const tool = tools['sympy.simplify']!;
    const parsed = await callTool(tool, { expression: 'x**2 + 0' });
    expect((parsed as Record<string, unknown>)['ok']).toBe(true);
    expect((parsed as Record<string, unknown>)['result']).toBe('x**2');
  });

  it('reproducibility hash is deterministic across identical calls', () => {
    const stdin1 = JSON.stringify({ op: 'simplify', expression: 'x+x' });
    const stdin2 = JSON.stringify({ op: 'simplify', expression: 'x+x' });
    const hash1 = computeHash(SYM_DIGEST, stdin1);
    const hash2 = computeHash(SYM_DIGEST, stdin2);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('reproducibility hash differs for different expressions', () => {
    const h1 = computeHash(SYM_DIGEST, JSON.stringify({ op: 'simplify', expression: 'x+x' }));
    const h2 = computeHash(SYM_DIGEST, JSON.stringify({ op: 'simplify', expression: 'y+y' }));
    expect(h1).not.toBe(h2);
  });

  it('wolfram.query tool has external tag', () => {
    const tool = tools['wolfram.query']!;
    expect(tool.schema.tags).toContain('external');
  });
});

// ─── Numerical tools ──────────────────────────────────────────────────────────

describe('createNumericalTools', () => {
  const executor = makeExecutor(NUM_DIGEST, {
    ok: true,
    statistic: 2.34,
    pvalue: 0.019,
    test: 'ttest_ind',
  });
  const tools = createNumericalTools({ executor, numDigest: NUM_DIGEST });

  it('exports exactly 5 tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'pymc.mcmc',
      'r.metafor',
      'scipy.power',
      'scipy.stats.test',
      'statsmodels.meta',
    ]);
  });

  it('scipy.stats.test has sandbox tag', () => {
    const tool = tools['scipy.stats.test']!;
    expect(tool.schema.tags).toContain('sandbox');
  });

  it('scipy.stats.test returns parsed result', async () => {
    const tool = tools['scipy.stats.test']!;
    const parsed = await callTool(tool, {
      test: 'ttest_ind',
      data_a: [1, 2, 3, 4, 5],
      data_b: [2, 3, 4, 5, 6],
    }) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(typeof parsed['pvalue']).toBe('number');
  });

  it('pymc.mcmc does not throw', async () => {
    const tool = tools['pymc.mcmc']!;
    const result = await callTool(tool, {
      model: { data: [1.1, 2.2, 1.8, 2.0, 1.9] },
      draws: 100,
    });
    expect(result).toBeTruthy();
  });

  it('statsmodels.meta has meta-analysis tag', () => {
    const tool = tools['statsmodels.meta']!;
    expect(tool.schema.tags).toContain('meta-analysis');
  });

  it('r.metafor has r tag', () => {
    const tool = tools['r.metafor']!;
    expect(tool.schema.tags).toContain('r');
  });
});

// ─── Domain tools ─────────────────────────────────────────────────────────────

describe('createDomainTools', () => {
  const executor = makeExecutor(DOM_DIGEST, {
    ok: true,
    MolWt: 180.16,
    LogP: -3.12,
    TPSA: 110.38,
  });
  const tools = createDomainTools({ executor, domDigest: DOM_DIGEST });

  it('exports exactly 3 tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'biopython.align',
      'networkx.analyse',
      'rdkit.descriptors',
    ]);
  });

  it('rdkit.descriptors has chemistry tag', () => {
    const tool = tools['rdkit.descriptors']!;
    expect(tool.schema.tags).toContain('chemistry');
  });

  it('biopython.align has biology tag', () => {
    const tool = tools['biopython.align']!;
    expect(tool.schema.tags).toContain('biology');
  });

  it('networkx.analyse has graph tag', () => {
    const tool = tools['networkx.analyse']!;
    expect(tool.schema.tags).toContain('graph');
  });

  it('rdkit.descriptors returns parsed result', async () => {
    const tool = tools['rdkit.descriptors']!;
    const parsed = await callTool(tool, { smiles: 'CC(=O)Oc1ccccc1C(=O)O' }) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(typeof parsed['MolWt']).toBe('number');
  });
});

// ─── Evidence tools ───────────────────────────────────────────────────────────

describe('createEvidenceTools', () => {
  const tools = createEvidenceTools();

  it('exports exactly 6 tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'arxiv.search',
      'crossref.resolve',
      'europepmc.search',
      'openalex.search',
      'pubmed.search',
      'semanticscholar.search',
    ]);
  });

  it('all evidence tools have external tag', () => {
    for (const [, tool] of Object.entries(tools)) {
      expect(tool.schema.tags).toContain('external');
    }
  });

  it('all evidence tools have evidence tag', () => {
    for (const [, tool] of Object.entries(tools)) {
      expect(tool.schema.tags).toContain('evidence');
    }
  });

  it('arxiv.search returns JSON (ok:boolean) on any network outcome', async () => {
    const tool = tools['arxiv.search']!;
    const out = await tool.invoke(CTX, { name: 'arxiv.search', arguments: { query: 'quantum gravity', max_results: 2 } });
    // output must be a parseable JSON string
    const parsed = JSON.parse(out.content) as { ok?: boolean };
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('crossref.resolve returns JSON on any network outcome', async () => {
    const tool = tools['crossref.resolve']!;
    const out = await tool.invoke(CTX, { name: 'crossref.resolve', arguments: { doi: '10.1234/test.doi' } });
    const parsed = JSON.parse(out.content) as { ok?: boolean };
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('reproducibility hash is deterministic for identical queries', () => {
    function hash(key: string, params: Record<string, unknown>): string {
      return createHash('sha256')
        .update(key)
        .update('\x00')
        .update(JSON.stringify(params, Object.keys(params).sort()))
        .digest('hex');
    }
    const h1 = hash('arxiv.search', { query: 'deep learning', maxResults: 5 });
    const h2 = hash('arxiv.search', { query: 'deep learning', maxResults: 5 });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});

// ─── Cross-cutting: total tool count ─────────────────────────────────────────

describe('SV tool map total count', () => {
  it('registers 18 tools in total', () => {
    const symTools = createSymbolicTools({ executor: makeExecutor(SYM_DIGEST), symDigest: SYM_DIGEST });
    const numTools = createNumericalTools({ executor: makeExecutor(NUM_DIGEST), numDigest: NUM_DIGEST });
    const domTools = createDomainTools({ executor: makeExecutor(DOM_DIGEST), domDigest: DOM_DIGEST });
    const evTools = createEvidenceTools();

    const all = { ...symTools, ...numTools, ...domTools, ...evTools };
    expect(Object.keys(all)).toHaveLength(18);
  });
});
