import { describe, expect, it, vi } from 'vitest';
import {
  cosineSimilarity,
  decideIntentRagSubset,
  hashDescription,
  weaveIntentRagToolSubsetFilter,
  type Embedder,
  type EmbeddingStore,
  type ToolEmbedding,
} from './intent-rag.js';
import type { ToolSubsetConfig } from './policy.js';

const v = (...nums: number[]) => nums;

const makeEmb = (toolKey: string, vector: number[], modelId = 'm', descriptionHash = 'h'): ToolEmbedding => ({
  toolKey,
  modelId,
  dimension: vector.length,
  vector,
  descriptionHash,
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity(v(1, 2, 3), v(1, 2, 3))).toBeCloseTo(1, 5);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBe(0);
  });
  it('returns -1 for antipodal vectors', () => {
    expect(cosineSimilarity(v(1, 1), v(-1, -1))).toBeCloseTo(-1, 5);
  });
  it('returns 0 for length mismatch', () => {
    expect(cosineSimilarity(v(1, 2), v(1, 2, 3))).toBe(0);
  });
  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it('returns 0 for all-zero vector', () => {
    expect(cosineSimilarity(v(0, 0), v(1, 1))).toBe(0);
  });
});

describe('hashDescription', () => {
  it('returns a 16-char hex string', () => {
    const h = hashDescription('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is deterministic', () => {
    expect(hashDescription('abc')).toBe(hashDescription('abc'));
  });
  it('varies across inputs', () => {
    expect(hashDescription('abc')).not.toBe(hashDescription('abd'));
  });
});

describe('decideIntentRagSubset', () => {
  const goal = v(1, 0, 0);
  const embeddings: ToolEmbedding[] = [
    makeEmb('alpha', v(0.9, 0.1, 0)),
    makeEmb('beta', v(0.5, 0.5, 0)),
    makeEmb('gamma', v(0, 1, 0)),
    makeEmb('delta', v(-0.5, 0.5, 0)),
  ];

  it('keeps top-K by cosine similarity', () => {
    const d = decideIntentRagSubset({
      config: { topK: 2 },
      availableKeys: ['alpha', 'beta', 'gamma', 'delta'],
      goalVector: goal,
      toolEmbeddings: embeddings,
    });
    expect(d.filtered).toBe(true);
    expect(d.keep).toEqual(['alpha', 'beta']);
    expect(d.dropped).toEqual(['gamma', 'delta']);
  });

  it('respects minSimilarity threshold', () => {
    const d = decideIntentRagSubset({
      config: { topK: 4, minSimilarity: 0.8 },
      availableKeys: ['alpha', 'beta', 'gamma', 'delta'],
      goalVector: goal,
      toolEmbeddings: embeddings,
    });
    expect(d.filtered).toBe(true);
    expect(d.keep).toEqual(['alpha']);
  });

  it('always includes includeAlways keys when present', () => {
    const d = decideIntentRagSubset({
      config: { topK: 1, includeAlways: ['gamma'] },
      availableKeys: ['alpha', 'beta', 'gamma', 'delta'],
      goalVector: goal,
      toolEmbeddings: embeddings,
    });
    expect(d.filtered).toBe(true);
    expect(d.keep.includes('alpha')).toBe(true);
    expect(d.keep.includes('gamma')).toBe(true);
  });

  it('passes through when no goal vector', () => {
    const d = decideIntentRagSubset({
      config: { topK: 2 },
      availableKeys: ['alpha', 'beta'],
      goalVector: null,
      toolEmbeddings: embeddings,
    });
    expect(d.filtered).toBe(false);
    expect(d.keep).toEqual(['alpha', 'beta']);
  });

  it('passes through when embeddings empty', () => {
    const d = decideIntentRagSubset({
      config: { topK: 2 },
      availableKeys: ['alpha'],
      goalVector: goal,
      toolEmbeddings: [],
    });
    expect(d.filtered).toBe(false);
  });

  it('returns includeAlways subset when no embeddings overlap available keys', () => {
    const d = decideIntentRagSubset({
      config: { topK: 2, includeAlways: ['x'] },
      availableKeys: ['x', 'y'],
      goalVector: goal,
      toolEmbeddings: embeddings, // none match x/y
    });
    expect(d.filtered).toBe(true);
    expect(d.keep).toEqual(['x']);
    expect(d.dropped).toEqual(['y']);
  });

  it('passes through when no embeddings overlap and no includeAlways', () => {
    const d = decideIntentRagSubset({
      config: { topK: 2 },
      availableKeys: ['x', 'y'],
      goalVector: goal,
      toolEmbeddings: embeddings,
    });
    expect(d.filtered).toBe(false);
  });

  it('skips embeddings with mismatched dimension silently', () => {
    const mixed: ToolEmbedding[] = [
      makeEmb('alpha', v(1, 0, 0)),
      makeEmb('beta', v(1, 0)), // wrong dim
    ];
    const d = decideIntentRagSubset({
      config: { topK: 5 },
      availableKeys: ['alpha', 'beta'],
      goalVector: goal,
      toolEmbeddings: mixed,
    });
    expect(d.filtered).toBe(true);
    expect(d.keep).toEqual(['alpha']);
  });
});

describe('weaveIntentRagToolSubsetFilter', () => {
  const baseConfig: ToolSubsetConfig = {
    strategy: 'intent-rag',
    topK: 2,
    minSimilarity: 0.1,
  };

  const makeEmbedder = (returns: number[][]): Embedder => ({
    modelId: 'stub',
    dimension: returns[0]?.length ?? 0,
    embed: vi.fn(async () => returns),
  });

  const makeStore = (rows: ToolEmbedding[]): EmbeddingStore => ({
    get: vi.fn(async (k) => rows.find((r) => r.toolKey === k) ?? null),
    getAll: vi.fn(async () => rows),
    upsert: vi.fn(async () => undefined),
  });

  it('returns null when strategy is not intent-rag', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: { strategy: 'phase' },
      embedder: makeEmbedder([[1, 0]]),
      embeddingStore: makeStore([makeEmb('a', [1, 0])]),
      goalResolver: () => 'hello',
    });
    const result = await filter(['a'], { phase: 'x' });
    expect(result).toBeNull();
  });

  it('returns null when goal is empty', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: baseConfig,
      embedder: makeEmbedder([[1, 0]]),
      embeddingStore: makeStore([makeEmb('a', [1, 0])]),
      goalResolver: () => '',
    });
    expect(await filter(['a'], {})).toBeNull();
  });

  it('returns null when embeddings store is empty', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: baseConfig,
      embedder: makeEmbedder([[1, 0]]),
      embeddingStore: makeStore([]),
      goalResolver: () => 'hi',
    });
    expect(await filter(['a'], {})).toBeNull();
  });

  it('returns null when embedder throws', async () => {
    const embedder: Embedder = {
      modelId: 's',
      dimension: 2,
      embed: async () => {
        throw new Error('boom');
      },
    };
    const filter = weaveIntentRagToolSubsetFilter({
      config: baseConfig,
      embedder,
      embeddingStore: makeStore([makeEmb('a', [1, 0])]),
      goalResolver: () => 'hi',
      log: () => undefined,
    });
    expect(await filter(['a'], {})).toBeNull();
  });

  it('returns null when goalResolver throws', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: baseConfig,
      embedder: makeEmbedder([[1, 0]]),
      embeddingStore: makeStore([makeEmb('a', [1, 0])]),
      goalResolver: async () => {
        throw new Error('nope');
      },
      log: () => undefined,
    });
    expect(await filter(['a'], {})).toBeNull();
  });

  it('returns ranked subset for matching goal', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: baseConfig,
      embedder: makeEmbedder([[1, 0, 0]]),
      embeddingStore: makeStore([
        makeEmb('alpha', [0.9, 0.1, 0]),
        makeEmb('beta', [0, 1, 0]),
        makeEmb('gamma', [0.7, 0.3, 0]),
      ]),
      goalResolver: () => 'fit a model',
    });
    const result = await filter(['alpha', 'beta', 'gamma'], {});
    expect(result).not.toBeNull();
    expect(result).toEqual(['alpha', 'gamma']); // top-2 by cosine
  });

  it('forces includeAlways keys into the kept set', async () => {
    const filter = weaveIntentRagToolSubsetFilter({
      config: { ...baseConfig, topK: 1, includeAlways: ['submit'] },
      embedder: makeEmbedder([[1, 0]]),
      embeddingStore: makeStore([
        makeEmb('alpha', [1, 0]),
        makeEmb('submit', [0, 1]),
      ]),
      goalResolver: () => 'do thing',
    });
    const result = await filter(['alpha', 'submit'], {});
    expect(result).not.toBeNull();
    expect(new Set(result!)).toEqual(new Set(['alpha', 'submit']));
  });
});
