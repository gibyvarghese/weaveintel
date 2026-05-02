/**
 * Phase 2.5 — Budget enforcement primitives.
 *
 * Lives in the LLM scaffold because every live-agent run has at least one
 * envelope (steps, tool-calls, tokens, wall-clock). The loop calls into a
 * `BudgetTracker` between iterations so the rest of the runtime stays
 * agnostic about *how* a budget is enforced.
 */

import type { LiveAgentBudget } from './types.js';

/** Thrown by `BudgetTracker.check()` once any envelope dimension is
 *  exhausted. The runner converts this into a `'budget_exhausted'`
 *  terminal status — never lets it propagate as an unhandled error. */
export class BudgetExhausted extends Error {
  constructor(public readonly dimension: keyof LiveAgentBudget, public readonly limit: number) {
    super(`live-agent budget exhausted on ${dimension} (limit=${limit})`);
    this.name = 'BudgetExhausted';
  }
}

export interface BudgetTracker {
  noteStep(): void;
  noteToolCall(): void;
  noteTokens(n: number): void;
  /** Throws BudgetExhausted on the first dimension over its ceiling. */
  check(): void;
}

export function createBudgetTracker(budget: LiveAgentBudget | undefined): BudgetTracker {
  const startMs = Date.now();
  let steps = 0;
  let toolCalls = 0;
  let tokens = 0;
  return {
    noteStep() { steps += 1; },
    noteToolCall() { toolCalls += 1; },
    noteTokens(n) { tokens += n; },
    check() {
      if (!budget) return;
      if (budget.maxSteps != null && steps > budget.maxSteps) {
        throw new BudgetExhausted('maxSteps', budget.maxSteps);
      }
      if (budget.maxToolCalls != null && toolCalls > budget.maxToolCalls) {
        throw new BudgetExhausted('maxToolCalls', budget.maxToolCalls);
      }
      if (budget.maxTokens != null && tokens > budget.maxTokens) {
        throw new BudgetExhausted('maxTokens', budget.maxTokens);
      }
      if (budget.maxWallMs != null && Date.now() - startMs > budget.maxWallMs) {
        throw new BudgetExhausted('maxWallMs', budget.maxWallMs);
      }
    },
  };
}
