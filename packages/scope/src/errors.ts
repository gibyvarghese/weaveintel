/**
 * @weaveintel/scope — errors.ts
 *
 * Custom error classes for the scope isolation system.
 */
import type { ScopeCheckResult } from './types.js';

/**
 * Thrown when an agent attempts an operation that violates its scope boundary.
 *
 * Includes the full ScopeCheckResult so callers can:
 *   - Log the violation type
 *   - Surface a useful message to the user ("This request requires explicit
 *     authorization to access the Kaggle competition domain")
 *   - Decide whether to retry with explicit A2A delegation
 */
export class ScopeViolationError extends Error {
  readonly checkResult: ScopeCheckResult;

  constructor(message: string, checkResult: ScopeCheckResult) {
    super(message);
    this.name = 'ScopeViolationError';
    this.checkResult = checkResult;
  }
}

/**
 * Thrown when a CrossScopeToken fails validation (expired, tampered, wrong binding).
 */
export class InvalidScopeTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid scope token: ${reason}`);
    this.name = 'InvalidScopeTokenError';
  }
}
