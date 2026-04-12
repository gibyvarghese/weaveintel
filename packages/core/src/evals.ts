/**
 * @weaveintel/core — Evaluation contracts
 *
 * Why: Evals are first-class. They work at every level: model, prompt, tool,
 * retrieval, agent, workflow. The contracts separate eval definition from
 * execution so evals can be shared, composed, and run in CI.
 */

import type { ExecutionContext } from './context.js';

export interface EvalDefinition {
  readonly name: string;
  readonly description?: string;
  readonly type: EvalType;
  readonly assertions: readonly Assertion[];
  readonly metadata?: Record<string, unknown>;
}

export type EvalType =
  | 'model'
  | 'prompt'
  | 'tool'
  | 'retrieval'
  | 'agent'
  | 'workflow'
  | 'safety'
  | 'custom';

export interface Assertion {
  readonly name: string;
  readonly type: AssertionType;
  readonly config: Record<string, unknown>;
}

export type AssertionType =
  | 'exact_match'
  | 'contains'
  | 'regex'
  | 'schema_valid'
  | 'rubric'
  | 'model_graded'
  | 'pairwise'
  | 'latency_threshold'
  | 'cost_threshold'
  | 'factuality'
  | 'citation_present'
  | 'safety'
  | 'guardrail_decision'
  | 'custom';

export interface EvalCase {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly expected?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface EvalResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly score?: number;
  readonly assertions: readonly AssertionResult[];
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly score?: number;
  readonly reason?: string;
}

export interface EvalSuiteResult {
  readonly name: string;
  readonly totalCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly avgScore?: number;
  readonly avgDurationMs: number;
  readonly results: readonly EvalResult[];
}

export interface EvalRunner {
  run(
    ctx: ExecutionContext,
    definition: EvalDefinition,
    cases: EvalCase[],
  ): Promise<EvalSuiteResult>;
}
