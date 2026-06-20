/**
 * Unit tests for verify.ts — weaveRubricVerifier
 */

import { describe, it, expect } from 'vitest';
import { weaveRubricVerifier } from './verify.js';
import { makeCtx, stubAdapter } from './test-helpers.js';
import type { RubricCriterion } from '@weaveintel/evals';

const CRITERIA: RubricCriterion[] = [
  { id: 'relevance', description: 'Directly answers the question', weight: 1 },
];

describe('weaveRubricVerifier', () => {
  it('passed: score >= minScore (default 0.7)', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.85, reason: 'great' }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    const result = await verifier.verify(ctx, 'The answer is 42.');
    expect(result.passed).toBe(true);
    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.reason).toBeUndefined();
  });

  it('failed: score < minScore', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.5, reason: 'off topic' }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    const result = await verifier.verify(ctx, 'Tangential response.');
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('off topic');
  });

  it('failed without reason: default reason mentions score and threshold', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.3 }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA, minScore: 0.7 });
    const result = await verifier.verify(ctx, 'bad answer');
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('0.30');
    expect(result.reason).toContain('0.7');
  });

  it('score clamped to [0,1]: adapter returns 2.0 → clamped to 1, passed', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 2.0 }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    const result = await verifier.verify(ctx, 'x');
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('score clamped: adapter returns -1 → clamped to 0, failed', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: -1 }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    const result = await verifier.verify(ctx, 'x');
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('custom minScore=0.9: only passes at score >= 0.9', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.85 }]);
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA, minScore: 0.9 });
    const result = await verifier.verify(ctx, 'x');
    expect(result.passed).toBe(false);
  });

  it('passes context through to adapter', async () => {
    const ctx = makeCtx();
    let receivedContext: Record<string, unknown> | undefined;
    const adapter = {
      id: 'spy',
      description: 'spy adapter',
      async score(req: { context?: Record<string, unknown> }) {
        receivedContext = req.context;
        return { score: 0.8 };
      },
    };
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    await verifier.verify(ctx, 'x', { sessionId: 'abc' });
    expect(receivedContext?.['sessionId']).toBe('abc');
  });

  it('adapter returning non-numeric score → treated as 0, fails', async () => {
    const ctx = makeCtx();
    const adapter = {
      id: 'bad',
      description: 'bad score',
      async score() { return { score: 'high' as unknown as number }; },
    };
    const verifier = weaveRubricVerifier(adapter, { criteria: CRITERIA });
    const result = await verifier.verify(ctx, 'x');
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});
