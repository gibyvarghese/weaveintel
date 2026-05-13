/**
 * Phase 7 — Max-Steps Cap unit tests.
 */
import { describe, expect, it } from 'vitest';
import { decideMaxSteps, decideMaxStepsDetailed } from './max-steps.js';

describe('decideMaxSteps', () => {
  it('returns the cap when no requested value is given', () => {
    expect(decideMaxSteps({ maxStepsCap: 40 })).toBe(40);
  });

  it('returns the cap when requested is 0 / negative / NaN', () => {
    expect(decideMaxSteps({ maxStepsCap: 40 }, 0)).toBe(40);
    expect(decideMaxSteps({ maxStepsCap: 40 }, -5)).toBe(40);
    expect(decideMaxSteps({ maxStepsCap: 40 }, Number.NaN)).toBe(40);
  });

  it('clamps requested down to cap', () => {
    expect(decideMaxSteps({ maxStepsCap: 20 }, 80)).toBe(20);
  });

  it('returns requested when ≤ cap', () => {
    expect(decideMaxSteps({ maxStepsCap: 40 }, 10)).toBe(10);
  });

  it('floor cap at 1', () => {
    expect(decideMaxSteps({ maxStepsCap: 0 })).toBe(1);
    expect(decideMaxSteps({ maxStepsCap: -10 })).toBe(1);
  });
});

describe('decideMaxStepsDetailed', () => {
  it('reports clamped=true with the original requested value', () => {
    const d = decideMaxStepsDetailed({ maxStepsCap: 20 }, 80);
    expect(d).toEqual({ maxSteps: 20, clamped: true, requested: 80, cap: 20 });
  });

  it('reports clamped=false when no requested or below cap', () => {
    const a = decideMaxStepsDetailed({ maxStepsCap: 40 });
    expect(a.clamped).toBe(false);
    expect(a.maxSteps).toBe(40);
    const b = decideMaxStepsDetailed({ maxStepsCap: 40 }, 10);
    expect(b).toEqual({ maxSteps: 10, clamped: false, requested: 10, cap: 40 });
  });
});
