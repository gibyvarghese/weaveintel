export interface RetryBudget {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryableErrors?: readonly string[];
}

export interface RetryBudgetController {
  shouldRetry(error: string, attempt: number): boolean;
  getDelay(attempt: number): number;
  getBudget(): RetryBudget;
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

export function createRetryBudget(budget: RetryBudget): RetryBudgetController {
  return {
    shouldRetry(error: string, attempt: number): boolean {
      if (attempt >= budget.maxRetries) {
        return false;
      }
      if (budget.retryableErrors !== undefined && budget.retryableErrors.length > 0) {
        return budget.retryableErrors.some((e) => error.includes(e));
      }
      return true;
    },

    getDelay(attempt: number): number {
      const delay = budget.baseDelayMs * Math.pow(2, attempt);
      return Math.min(delay, budget.maxDelayMs);
    },

    getBudget(): RetryBudget {
      return budget;
    },

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= budget.maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: unknown) {
          lastError = err;
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (!this.shouldRetry(errorMessage, attempt + 1)) {
            throw err;
          }
          const delay = this.getDelay(attempt);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastError;
    },
  };
}
