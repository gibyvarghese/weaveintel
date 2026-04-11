/**
 * @weaveintel/contracts — Task outcome helpers
 */

import type {
  TaskOutcome,
  TaskOutcomeStatus,
  FailureReason,
  CompletionReport,
} from '@weaveintel/core';

/**
 * Create a TaskOutcome from a CompletionReport.
 */
export function createTaskOutcome(
  contractId: string,
  report: CompletionReport,
  output?: unknown,
): TaskOutcome {
  const statusMap: Record<string, TaskOutcomeStatus> = {
    fulfilled: 'success',
    partial: 'partial-success',
    failed: 'failure',
  };

  const status = statusMap[report.status] ?? 'failure';

  const outcome: TaskOutcome = {
    contractId,
    status,
    output: output ?? undefined,
    report,
  };

  if (status === 'failure') {
    const failedCriteria = report.results.filter(r => !r.passed);
    outcome.failureReason = createFailureReason(
      'VALIDATION_FAILED',
      `Failed ${failedCriteria.length} acceptance criteria`,
      'validation',
      true,
    );
  }

  return outcome;
}

/**
 * Create a FailureReason.
 */
export function createFailureReason(
  code: string,
  message: string,
  category: FailureReason['category'],
  recoverable: boolean,
  details?: Record<string, unknown>,
): FailureReason {
  return { code, message, category, recoverable, details };
}

/**
 * Pre-built failure reasons for common scenarios.
 */
export const failures = {
  timeout(message?: string): FailureReason {
    return createFailureReason('TIMEOUT', message ?? 'Task exceeded time limit', 'timeout', true);
  },
  cancelled(message?: string): FailureReason {
    return createFailureReason('CANCELLED', message ?? 'Task was cancelled by user', 'user-cancelled', false);
  },
  permissionDenied(message?: string): FailureReason {
    return createFailureReason('PERMISSION_DENIED', message ?? 'Insufficient permissions', 'permission', false);
  },
  modelError(message?: string): FailureReason {
    return createFailureReason('MODEL_ERROR', message ?? 'Model inference failed', 'model-error', true);
  },
  validationFailed(message?: string): FailureReason {
    return createFailureReason('VALIDATION_FAILED', message ?? 'Output failed acceptance criteria', 'validation', true);
  },
};
