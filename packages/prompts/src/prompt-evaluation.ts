/**
 * @weaveintel/prompts — Prompt dataset evaluation (Phase 7)
 *
 * These helpers keep prompt-quality evaluation in shared package code so app
 * runtimes can evaluate prompt versions consistently before promotion.
 */

import type { PromptRecordLike } from './records.js';
import { executePromptRecord, type PromptRecordExecutionResult } from './runtime.js';

export interface PromptEvalRubricCriterion {
  id: string;
  description: string;
  weight: number;
  guidance?: string;
}

export interface PromptEvalCase {
  id: string;
  description: string;
  variables: Record<string, unknown>;
  expectedOutput?: string;
  expectedContains?: string[];
  metadata?: Record<string, unknown>;
}

export interface PromptEvalDataset {
  id: string;
  name: string;
  description: string;
  promptId: string;
  promptVersion?: string;
  cases: PromptEvalCase[];
  rubric?: PromptEvalRubricCriterion[];
}

export interface PromptJudgeAdapter {
  id: string;
  description: string;
  judge(args: {
    renderedPrompt: string;
    evalCase: PromptEvalCase;
    rubric: PromptEvalRubricCriterion[];
    execution: PromptRecordExecutionResult;
  }): Promise<{
    score: number;
    reason?: string;
    criteriaScores?: Record<string, number>;
    metadata?: Record<string, unknown>;
  }>;
}

export interface PromptEvalHooks {
  onCaseStart?(args: { prompt: PromptRecordLike; evalCase: PromptEvalCase }): void;
  onCaseComplete?(args: {
    prompt: PromptRecordLike;
    evalCase: PromptEvalCase;
    result: PromptEvalCaseResult;
  }): void;
}

export interface PromptDatasetEvaluationOptions {
  passThreshold?: number;
  judgeAdapter?: PromptJudgeAdapter;
  hooks?: PromptEvalHooks;
}

export interface PromptEvalCaseResult {
  caseId: string;
  description: string;
  passed: boolean;
  score: number;
  render: {
    content: string;
    strategyKey: string;
    durationMs: number;
  };
  checks: {
    expectedOutputMatch?: boolean;
    expectedContainsMatches?: string[];
  };
  rubric?: {
    score: number;
    reason?: string;
    criteriaScores?: Record<string, number>;
  };
  metadata?: Record<string, unknown>;
}

export interface PromptDatasetEvaluationResult {
  datasetId: string;
  datasetName: string;
  promptId: string;
  promptVersion: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  averageScore: number;
  passThreshold: number;
  createdAt: string;
  durationMs: number;
  results: PromptEvalCaseResult[];
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

function localHeuristicScore(renderedPrompt: string, evalCase: PromptEvalCase): {
  score: number;
  checks: PromptEvalCaseResult['checks'];
} {
  let score = 0;
  let checks: PromptEvalCaseResult['checks'] = {};

  if (evalCase.expectedOutput !== undefined) {
    const matched = renderedPrompt.trim() === evalCase.expectedOutput.trim();
    checks.expectedOutputMatch = matched;
    score += matched ? 1 : 0;
  }

  if (evalCase.expectedContains && evalCase.expectedContains.length > 0) {
    const matched = evalCase.expectedContains.filter((item) => renderedPrompt.includes(item));
    checks.expectedContainsMatches = matched;
    score += matched.length / evalCase.expectedContains.length;
  }

  const dimensions =
    (evalCase.expectedOutput !== undefined ? 1 : 0) +
    (evalCase.expectedContains && evalCase.expectedContains.length > 0 ? 1 : 0);

  return {
    score: dimensions > 0 ? score / dimensions : 1,
    checks,
  };
}

/**
 * Evaluate one prompt version against a dataset and optional rubric judge.
 */
export async function evaluatePromptDatasetForRecord(
  promptRecord: PromptRecordLike,
  dataset: PromptEvalDataset,
  options: PromptDatasetEvaluationOptions = {},
): Promise<PromptDatasetEvaluationResult> {
  const startedAt = Date.now();
  const threshold = options.passThreshold ?? 0.75;
  const results: PromptEvalCaseResult[] = [];

  for (const evalCase of dataset.cases) {
    options.hooks?.onCaseStart?.({ prompt: promptRecord, evalCase });
    const execution = executePromptRecord(promptRecord, evalCase.variables);
    const heuristic = localHeuristicScore(execution.content, evalCase);

    let score = heuristic.score;
    let rubricResult: PromptEvalCaseResult['rubric'] | undefined;

    if (dataset.rubric && dataset.rubric.length > 0 && options.judgeAdapter) {
      const judged = await options.judgeAdapter.judge({
        renderedPrompt: execution.content,
        evalCase,
        rubric: dataset.rubric,
        execution,
      });
      rubricResult = {
        score: normalizeScore(judged.score),
        reason: judged.reason,
        criteriaScores: judged.criteriaScores,
      };
      // Blend deterministic heuristic checks with judge scoring for stability.
      score = normalizeScore((heuristic.score * 0.4) + (rubricResult.score * 0.6));
    }

    const passed = score >= threshold;
    const caseResult: PromptEvalCaseResult = {
      caseId: evalCase.id,
      description: evalCase.description,
      passed,
      score,
      render: {
        content: execution.content,
        strategyKey: execution.strategy.resolvedKey,
        durationMs: execution.durationMs,
      },
      checks: heuristic.checks,
      rubric: rubricResult,
      metadata: evalCase.metadata,
    };

    results.push(caseResult);
    options.hooks?.onCaseComplete?.({ prompt: promptRecord, evalCase, result: caseResult });
  }

  const passedCases = results.filter((item) => item.passed).length;
  const averageScore = results.length > 0
    ? results.reduce((acc, item) => acc + item.score, 0) / results.length
    : 0;

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    promptId: promptRecord.id,
    promptVersion: promptRecord.version ?? '1.0',
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    averageScore,
    passThreshold: threshold,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    results,
  };
}

/**
 * Compare baseline and candidate prompt records against the same dataset.
 */
export async function comparePromptDatasetResults(args: {
  baselineRecord: PromptRecordLike;
  candidateRecord: PromptRecordLike;
  dataset: PromptEvalDataset;
  options?: PromptDatasetEvaluationOptions;
}): Promise<{
  baseline: PromptDatasetEvaluationResult;
  candidate: PromptDatasetEvaluationResult;
  delta: {
    averageScoreDelta: number;
    passedCasesDelta: number;
    improved: boolean;
  };
}> {
  const baseline = await evaluatePromptDatasetForRecord(
    args.baselineRecord,
    args.dataset,
    args.options,
  );
  const candidate = await evaluatePromptDatasetForRecord(
    args.candidateRecord,
    args.dataset,
    args.options,
  );

  return {
    baseline,
    candidate,
    delta: {
      averageScoreDelta: candidate.averageScore - baseline.averageScore,
      passedCasesDelta: candidate.passedCases - baseline.passedCases,
      improved: candidate.averageScore > baseline.averageScore,
    },
  };
}
