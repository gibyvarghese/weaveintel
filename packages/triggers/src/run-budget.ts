// SPDX-License-Identifier: MIT
/**
 * @weaveintel/triggers — RUN BUDGET (anti-runaway ceiling for autonomous / scheduled runs).
 *
 * When a trigger fires a multi-step AI task with no human watching, you need a hard stop so a loop
 * can't burn tokens or spin forever. A `RunBudget` caps a run on TWO axes — total tokens and total
 * steps — whichever is hit first. Check `budgetExhausted()` BEFORE each step; `chargeBudget()` after.
 * Pure + zero-dependency; reusable by any scheduled or triggered agent, not tied to any product.
 */

export interface RunBudget {
  /** Maximum tokens this run may consume. */
  tokenBudget: number;
  /** Maximum steps this run may take. */
  maxSteps: number;
  tokensUsed: number;
  steps: number;
}

/** Start a fresh budget from a token + step ceiling. */
export function newRunBudget(cfg: { tokenBudget: number; maxSteps: number }): RunBudget {
  return { tokenBudget: cfg.tokenBudget, maxSteps: cfg.maxSteps, tokensUsed: 0, steps: 0 };
}

/** Charge a step's token use; returns the budget for chaining. */
export function chargeBudget(b: RunBudget, tokens: number): RunBudget {
  b.tokensUsed += Math.max(0, Math.trunc(tokens) || 0);
  b.steps += 1;
  return b;
}

/** Has the run hit its token or step ceiling? (Check BEFORE doing the next step.) */
export function budgetExhausted(b: RunBudget): boolean {
  return b.tokensUsed >= b.tokenBudget || b.steps >= b.maxSteps;
}

/** Remaining token headroom (never negative). */
export function budgetRemaining(b: RunBudget): number {
  return Math.max(0, b.tokenBudget - b.tokensUsed);
}
