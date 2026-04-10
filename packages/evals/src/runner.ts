/**
 * @weaveintel/evals — Evaluation runner
 *
 * Runs eval suites against any testable component (model, prompt, tool,
 * retrieval, agent). Supports assertion types from exact_match to
 * model-graded evaluation. Results include per-case scores, aggregate
 * metrics, and pass/fail status.
 */

import type {
  EvalDefinition,
  EvalCase,
  EvalResult,
  EvalSuiteResult,
  EvalRunner,
  Assertion,
  AssertionResult,
  ExecutionContext,
} from '@weaveintel/core';

// ─── Assertion evaluators ────────────────────────────────────

type AssertionEvaluator = (
  assertion: Assertion,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  expected?: Record<string, unknown>,
) => AssertionResult;

const evaluators: Record<string, AssertionEvaluator> = {
  exact_match(assertion, _input, output, expected) {
    const outputVal = String(output['output'] ?? '');
    const expectedVal = String(expected?.['output'] ?? assertion.config['expected'] ?? '');
    const passed = outputVal === expectedVal;
    return { name: assertion.name, passed, score: passed ? 1 : 0 };
  },

  contains(assertion, _input, output, _expected) {
    const outputVal = String(output['output'] ?? '');
    const substring = String(assertion.config['substring'] ?? '');
    const passed = outputVal.includes(substring);
    return { name: assertion.name, passed, score: passed ? 1 : 0 };
  },

  regex(assertion, _input, output, _expected) {
    const outputVal = String(output['output'] ?? '');
    const pattern = String(assertion.config['pattern'] ?? '');
    const regex = new RegExp(pattern, String(assertion.config['flags'] ?? ''));
    const passed = regex.test(outputVal);
    return { name: assertion.name, passed, score: passed ? 1 : 0 };
  },

  schema_valid(assertion, _input, output, _expected) {
    // Simple type checking (full JSON Schema validation would require ajv)
    const schema = assertion.config['schema'] as Record<string, unknown> | undefined;
    if (!schema) return { name: assertion.name, passed: true, score: 1 };

    const outputVal = output['output'];
    let parsed: unknown;
    try {
      parsed = typeof outputVal === 'string' ? JSON.parse(outputVal) : outputVal;
    } catch {
      return { name: assertion.name, passed: false, score: 0, reason: 'Output is not valid JSON' };
    }

    const expectedType = schema['type'] as string | undefined;
    if (expectedType) {
      const actualType = Array.isArray(parsed) ? 'array' : typeof parsed;
      if (actualType !== expectedType) {
        return { name: assertion.name, passed: false, score: 0, reason: `Expected type ${expectedType}, got ${actualType}` };
      }
    }

    return { name: assertion.name, passed: true, score: 1 };
  },

  latency_threshold(assertion, _input, output, _expected) {
    const durationMs = Number(output['durationMs'] ?? 0);
    const maxMs = Number(assertion.config['maxMs'] ?? Infinity);
    const passed = durationMs <= maxMs;
    return {
      name: assertion.name,
      passed,
      score: passed ? 1 : Math.max(0, 1 - (durationMs - maxMs) / maxMs),
      reason: passed ? undefined : `Took ${durationMs}ms, max ${maxMs}ms`,
    };
  },

  cost_threshold(assertion, _input, output, _expected) {
    const cost = Number(output['costUsd'] ?? 0);
    const maxCost = Number(assertion.config['maxCostUsd'] ?? Infinity);
    const passed = cost <= maxCost;
    return {
      name: assertion.name,
      passed,
      score: passed ? 1 : 0,
      reason: passed ? undefined : `Cost $${cost}, max $${maxCost}`,
    };
  },

  citation_present(assertion, _input, output, _expected) {
    const outputVal = String(output['output'] ?? '');
    const patterns = (assertion.config['patterns'] as string[]) ?? ['\\[\\d+\\]', '\\(source:'];
    const passed = patterns.some((p) => new RegExp(p).test(outputVal));
    return { name: assertion.name, passed, score: passed ? 1 : 0 };
  },

  safety(assertion, _input, output, _expected) {
    const outputVal = String(output['output'] ?? '');
    const blockedPhrases = (assertion.config['blockedPhrases'] as string[]) ?? [];
    const found = blockedPhrases.filter((p) => outputVal.toLowerCase().includes(p.toLowerCase()));
    const passed = found.length === 0;
    return {
      name: assertion.name,
      passed,
      score: passed ? 1 : 0,
      reason: passed ? undefined : `Contains blocked phrases: ${found.join(', ')}`,
    };
  },
};

// ─── Eval runner ─────────────────────────────────────────────

export interface CreateEvalRunnerOptions {
  /** Function that executes a single eval case and returns the output */
  executor: (ctx: ExecutionContext, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

  /** Custom assertion evaluators */
  customEvaluators?: Record<string, AssertionEvaluator>;
}

export function createEvalRunner(opts: CreateEvalRunnerOptions): EvalRunner {
  const allEvaluators = { ...evaluators, ...opts.customEvaluators };

  return {
    async run(ctx: ExecutionContext, definition: EvalDefinition, cases: EvalCase[]): Promise<EvalSuiteResult> {
      const results: EvalResult[] = [];

      for (const evalCase of cases) {
        const startTime = Date.now();

        let output: Record<string, unknown>;
        try {
          output = await opts.executor(ctx, evalCase.input);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }

        const durationMs = Date.now() - startTime;
        output['durationMs'] = durationMs;

        const assertionResults: AssertionResult[] = [];
        for (const assertion of definition.assertions) {
          const evaluator = allEvaluators[assertion.type];
          if (evaluator) {
            assertionResults.push(evaluator(assertion, evalCase.input, output, evalCase.expected));
          } else {
            assertionResults.push({
              name: assertion.name,
              passed: false,
              score: 0,
              reason: `No evaluator for assertion type: ${assertion.type}`,
            });
          }
        }

        const allPassed = assertionResults.every((a) => a.passed);
        const avgScore = assertionResults.length > 0
          ? assertionResults.reduce((sum, a) => sum + (a.score ?? 0), 0) / assertionResults.length
          : 1;

        results.push({
          caseId: evalCase.id,
          passed: allPassed,
          score: avgScore,
          assertions: assertionResults,
          durationMs,
          metadata: evalCase.metadata,
        });
      }

      const passed = results.filter((r) => r.passed).length;
      const failed = results.length - passed;
      const avgScore = results.length > 0
        ? results.reduce((sum, r) => sum + (r.score ?? 0), 0) / results.length
        : 0;
      const avgDurationMs = results.length > 0
        ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length
        : 0;

      return {
        name: definition.name,
        totalCases: results.length,
        passed,
        failed,
        avgScore,
        avgDurationMs,
        results,
      };
    },
  };
}
