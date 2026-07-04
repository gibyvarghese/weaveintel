import type { ExecutionContext, EvalSuiteResult } from '@weaveintel/core';

export interface RegressionConfig {
  readonly scoreDropThreshold: number;
  readonly passRateDropThreshold: number;
}

export interface RegressionResult {
  readonly baseline: EvalSuiteResult;
  readonly current: EvalSuiteResult;
  readonly hasRegression: boolean;
  readonly scoreDelta: number;
  readonly passRateDelta: number;
  readonly details: readonly RegressionDetail[];
}

export interface RegressionDetail {
  readonly caseId: string;
  readonly baselinePassed: boolean;
  readonly currentPassed: boolean;
  readonly baselineScore?: number;
  readonly currentScore?: number;
  readonly regression: boolean;
}

export function detectRegression(
  baseline: EvalSuiteResult,
  current: EvalSuiteResult,
  config: RegressionConfig = { scoreDropThreshold: 0.1, passRateDropThreshold: 0.05 },
): RegressionResult {
  const baselinePassRate = baseline.totalCases > 0 ? baseline.passed / baseline.totalCases : 0;
  const currentPassRate = current.totalCases > 0 ? current.passed / current.totalCases : 0;
  const passRateDelta = currentPassRate - baselinePassRate;

  const baselineAvg = baseline.avgScore ?? 0;
  const currentAvg = current.avgScore ?? 0;
  const scoreDelta = currentAvg - baselineAvg;

  const details: RegressionDetail[] = [];
  for (const currentResult of current.results) {
    const baselineResult = baseline.results.find(r => r.caseId === currentResult.caseId);
    details.push({
      caseId: currentResult.caseId,
      baselinePassed: baselineResult?.passed ?? true,
      currentPassed: currentResult.passed,
      baselineScore: baselineResult?.score,
      currentScore: currentResult.score,
      regression: (baselineResult?.passed === true && !currentResult.passed) ||
        (baselineResult?.score !== undefined && currentResult.score !== undefined && currentResult.score < baselineResult.score - config.scoreDropThreshold),
    });
  }

  return {
    baseline,
    current,
    hasRegression: passRateDelta < -config.passRateDropThreshold || scoreDelta < -config.scoreDropThreshold,
    scoreDelta,
    passRateDelta,
    details,
  };
}
