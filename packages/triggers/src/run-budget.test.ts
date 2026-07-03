// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { newRunBudget, chargeBudget, budgetExhausted, budgetRemaining } from './run-budget.js';

describe('run-budget — anti-runaway ceiling', () => {
  it('charges tokens + steps and reports exhaustion on EITHER ceiling', () => {
    const b = newRunBudget({ tokenBudget: 1000, maxSteps: 3 });
    expect(budgetExhausted(b)).toBe(false);
    chargeBudget(b, 400); expect(budgetRemaining(b)).toBe(600); expect(budgetExhausted(b)).toBe(false);
    chargeBudget(b, 700); expect(budgetExhausted(b)).toBe(true); // tokens 1100 ≥ 1000
  });
  it('exhausts on the step ceiling even under token budget', () => {
    const b = newRunBudget({ tokenBudget: 100000, maxSteps: 2 });
    chargeBudget(b, 1); chargeBudget(b, 1);
    expect(budgetExhausted(b)).toBe(true); // 2 steps ≥ 2
  });
  it('tolerates negative/NaN token charges', () => {
    const b = newRunBudget({ tokenBudget: 1000, maxSteps: 5 });
    chargeBudget(b, -50); chargeBudget(b, NaN);
    expect(b.tokensUsed).toBe(0); expect(b.steps).toBe(2);
  });
  it('budgetRemaining never goes negative even when over budget', () => {
    const b = newRunBudget({ tokenBudget: 100, maxSteps: 10 });
    chargeBudget(b, 250);
    expect(budgetRemaining(b)).toBe(0);
    expect(budgetExhausted(b)).toBe(true);
  });
});
