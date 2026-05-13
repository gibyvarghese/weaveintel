import { describe, expect, it } from 'vitest';
import { weaveToolRegistry as createToolRegistry, weaveTool as defineTool } from '@weaveintel/core';
import {
  applyToolFilterToRegistry,
  decideToolSubset,
  weaveToolSubsetFilter,
} from './tool-subset.js';
import { weaveCostGovernor } from './governor.js';
import type { ToolSubsetConfig } from './policy.js';

const ctxBase = { runId: 'r1', meshId: 'm1', agentId: 'a1' };

describe('decideToolSubset', () => {
  const universe = ['kaggle_list_competitions', 'kaggle_push_kernel', 'kaggle_get_kernel_output', 'web_search'];

  it('passes through when config is null', () => {
    const d = decideToolSubset(null, universe, ctxBase);
    expect(d.filtered).toBe(false);
    expect(d.keep).toEqual(universe);
    expect(d.reason).toBe('no-config');
  });

  it('passes through when strategy=all', () => {
    const d = decideToolSubset({ strategy: 'all' }, universe, ctxBase);
    expect(d.filtered).toBe(false);
  });

  it('passes through when strategy=intent-rag (reserved)', () => {
    const d = decideToolSubset({ strategy: 'intent-rag', topK: 3 }, universe, ctxBase);
    expect(d.filtered).toBe(false);
    expect(d.reason).toContain('reserved');
  });

  it('passes through when phase missing', () => {
    const d = decideToolSubset({ strategy: 'phase', phases: { discovery: ['kaggle_list_competitions'] } }, universe, ctxBase);
    expect(d.filtered).toBe(false);
    expect(d.reason).toBe('phase=missing');
  });

  it('passes through when phase not mapped', () => {
    const cfg: ToolSubsetConfig = { strategy: 'phase', phases: { discovery: ['kaggle_list_competitions'] } };
    const d = decideToolSubset(cfg, universe, { ...ctxBase, phase: 'kernel' });
    expect(d.filtered).toBe(false);
    expect(d.reason).toContain('not-mapped');
  });

  it('filters to phase-mapped subset', () => {
    const cfg: ToolSubsetConfig = {
      strategy: 'phase',
      phases: {
        discovery: ['kaggle_list_competitions', 'web_search'],
        kernel: ['kaggle_push_kernel', 'kaggle_get_kernel_output'],
      },
    };
    const d = decideToolSubset(cfg, universe, { ...ctxBase, phase: 'kernel' });
    expect(d.filtered).toBe(true);
    expect(d.keep).toEqual(['kaggle_push_kernel', 'kaggle_get_kernel_output']);
    expect(d.dropped).toEqual(['kaggle_list_competitions', 'web_search']);
  });

  it('passes through when phase-allowed has zero overlap (graceful)', () => {
    const cfg: ToolSubsetConfig = { strategy: 'phase', phases: { kernel: ['nonexistent_tool'] } };
    const d = decideToolSubset(cfg, universe, { ...ctxBase, phase: 'kernel' });
    expect(d.filtered).toBe(false);
    expect(d.reason).toContain('no-overlap');
  });
});

describe('weaveToolSubsetFilter', () => {
  const universe = ['a', 'b', 'c'];

  it('returns null for pass-through', async () => {
    const f = weaveToolSubsetFilter({ strategy: 'all' });
    const r = await f(universe, ctxBase);
    expect(r).toBeNull();
  });

  it('returns kept subset when filtered', async () => {
    const f = weaveToolSubsetFilter({ strategy: 'phase', phases: { p1: ['a', 'c'] } });
    const r = await f(universe, { ...ctxBase, phase: 'p1' });
    expect(r).toEqual(['a', 'c']);
  });

  it('never throws — returns null on any internal error', async () => {
    // Force malformed phases
    const f = weaveToolSubsetFilter({ strategy: 'phase', phases: null as unknown as never });
    const r = await f(universe, { ...ctxBase, phase: 'p1' });
    expect(r).toBeNull();
  });
});

describe('applyToolFilterToRegistry', () => {
  function buildRegistry(): ReturnType<typeof createToolRegistry> {
    const reg = createToolRegistry();
    for (const name of ['alpha', 'beta', 'gamma']) {
      reg.register(
        defineTool({
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: 'ok' }),
        }),
      );
    }
    return reg;
  }

  it('copies all tools on pass-through', async () => {
    const source = buildRegistry();
    const target = createToolRegistry();
    const out = await applyToolFilterToRegistry(
      source,
      weaveToolSubsetFilter({ strategy: 'all' }),
      ctxBase,
      target,
    );
    expect(out.filtered).toBe(false);
    expect(target.list().map((t) => t.schema.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('copies only kept tools when filtered', async () => {
    const source = buildRegistry();
    const target = createToolRegistry();
    const out = await applyToolFilterToRegistry(
      source,
      weaveToolSubsetFilter({ strategy: 'phase', phases: { p: ['alpha', 'gamma'] } }),
      { ...ctxBase, phase: 'p' },
      target,
    );
    expect(out.filtered).toBe(true);
    expect(out.kept).toEqual(['alpha', 'gamma']);
    expect(out.dropped).toEqual(['beta']);
    expect(target.list().map((t) => t.schema.name).sort()).toEqual(['alpha', 'gamma']);
  });
});

describe('weaveCostGovernor wires toolFilter from policy', () => {
  it('uses noopToolFilter when strategy=all', async () => {
    const bundle = weaveCostGovernor({ tier: 'custom', toolSubset: { strategy: 'all' }, promptCaching: { enabled: false }, modelCascade: {}, intelGating: { enabled: false }, historyCompaction: { strategy: 'none' }, maxStepsCap: 10, reasoningEffort: 'low', toolOutputTruncation: {} });
    const r = await bundle.toolFilter(['a', 'b'], ctxBase);
    expect(r).toBeNull();
  });

  it('uses real subset filter when strategy=phase', async () => {
    const bundle = weaveCostGovernor({
      tier: 'custom',
      toolSubset: { strategy: 'phase', phases: { kernel: ['a'] } },
      promptCaching: { enabled: false },
      modelCascade: {},
      intelGating: { enabled: false },
      historyCompaction: { strategy: 'none' },
      maxStepsCap: 10,
      reasoningEffort: 'low',
      toolOutputTruncation: {},
    });
    const r = await bundle.toolFilter(['a', 'b'], { ...ctxBase, phase: 'kernel' });
    expect(r).toEqual(['a']);
  });
});
