/**
 * @weaveintel/contracts — Completion validator
 *
 * Validates agent/workflow output against a TaskContract's acceptance criteria.
 */

import type {
  TaskContract,
  AcceptanceCriteria,
  CompletionReport,
  CompletionValidator,
  ValidationResult,
  EvidenceBundle,
} from '@weaveintel/core';

// ─── Built-in criterion checkers ─────────────────────────────

type CriterionChecker = (output: unknown, criteria: AcceptanceCriteria) => ValidationResult;

function checkSchema(output: unknown, criteria: AcceptanceCriteria): ValidationResult {
  // Basic schema validation: check required keys exist in output
  const config = (criteria.config ?? {}) as Record<string, unknown>;
  const requiredKeys = (config['requiredKeys'] as string[]) ?? [];
  const obj = (typeof output === 'object' && output !== null) ? output as Record<string, unknown> : {};

  const missing = requiredKeys.filter(k => !(k in obj));
  return {
    criteriaId: criteria.id,
    passed: missing.length === 0,
    score: missing.length === 0 ? 1 : 1 - missing.length / requiredKeys.length,
    explanation: missing.length === 0
      ? 'All required keys present'
      : `Missing keys: ${missing.join(', ')}`,
  };
}

function checkAssertion(output: unknown, criteria: AcceptanceCriteria): ValidationResult {
  const config = (criteria.config ?? {}) as Record<string, unknown>;
  const field = config['field'] as string | undefined;
  const operator = (config['operator'] as string) ?? 'exists';
  const expected = config['expected'];

  const obj = (typeof output === 'object' && output !== null) ? output as Record<string, unknown> : {};
  const actual = field ? obj[field] : output;

  let passed = false;
  let explanation = '';

  switch (operator) {
    case 'exists':
      passed = actual !== undefined && actual !== null;
      explanation = passed ? `${field ?? 'output'} exists` : `${field ?? 'output'} is missing`;
      break;
    case 'equals':
      passed = actual === expected;
      explanation = passed ? `${field} equals expected value` : `${field}: expected ${String(expected)}, got ${String(actual)}`;
      break;
    case 'contains':
      passed = typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
      explanation = passed ? `${field} contains "${expected}"` : `${field} does not contain "${expected}"`;
      break;
    case 'gt':
      passed = typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      explanation = passed ? `${field} > ${expected}` : `${field}: ${actual} is not > ${expected}`;
      break;
    case 'gte':
      passed = typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      explanation = passed ? `${field} >= ${expected}` : `${field}: ${actual} is not >= ${expected}`;
      break;
    default:
      passed = false;
      explanation = `Unknown operator: ${operator}`;
  }

  return { criteriaId: criteria.id, passed, score: passed ? 1 : 0, explanation };
}

function checkCustom(_output: unknown, criteria: AcceptanceCriteria): ValidationResult {
  // Custom criteria always pass by default — meant to be overridden
  return {
    criteriaId: criteria.id,
    passed: true,
    score: 1,
    explanation: 'Custom criterion — auto-passed (provide custom validator for real checks)',
  };
}

const BUILTIN_CHECKERS: Record<string, CriterionChecker> = {
  schema: checkSchema,
  assertion: checkAssertion,
  custom: checkCustom,
  'model-graded': checkCustom,    // placeholder — real impl would call a model
  'human-review': checkCustom,    // placeholder — real impl would create a human task
};

// ─── Default validator ───────────────────────────────────────

export class DefaultCompletionValidator implements CompletionValidator {
  private readonly customCheckers = new Map<string, CriterionChecker>();

  /**
   * Register a custom criterion checker for a given criteria type.
   */
  registerChecker(type: string, checker: CriterionChecker): void {
    this.customCheckers.set(type, checker);
  }

  async validate(output: unknown, contract: TaskContract): Promise<CompletionReport> {
    const results: ValidationResult[] = [];

    for (const criteria of contract.acceptanceCriteria) {
      const checker = this.customCheckers.get(criteria.type) ?? BUILTIN_CHECKERS[criteria.type];
      if (!checker) {
        results.push({
          criteriaId: criteria.id,
          passed: false,
          score: 0,
          explanation: `No checker registered for type "${criteria.type}"`,
        });
        continue;
      }
      results.push(checker(output, criteria));
    }

    // Determine status
    const requiredFailed = results.some((r, i) => contract.acceptanceCriteria[i]?.required && !r.passed);
    const anyFailed = results.some(r => !r.passed);

    // Compute weighted confidence
    let confidence = 1;
    if (results.length > 0) {
      let totalWeight = 0;
      let weightedScore = 0;
      for (let i = 0; i < results.length; i++) {
        const w = contract.acceptanceCriteria[i]?.weight ?? 1;
        totalWeight += w;
        weightedScore += (results[i]?.score ?? 0) * w;
      }
      confidence = totalWeight > 0 ? weightedScore / totalWeight : 0;
    }

    const status = requiredFailed ? 'failed' : anyFailed ? 'partial' : 'fulfilled';

    return {
      taskContractId: contract.id,
      status,
      results,
      evidence: { items: [] },
      confidence,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Create a simple evidence bundle from items.
 */
export function createEvidence(...items: Array<{ type: 'text' | 'file' | 'url' | 'metric' | 'trace'; label: string; value: unknown }>): EvidenceBundle {
  return { items };
}
