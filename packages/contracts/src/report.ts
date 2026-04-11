/**
 * @weaveintel/contracts — Completion report helpers
 */

import type {
  CompletionReport,
  ValidationResult,
  EvidenceBundle,
  EvidenceItem,
} from '@weaveintel/core';

/**
 * Build a CompletionReport from raw validation results.
 */
export function createCompletionReport(
  taskContractId: string,
  results: ValidationResult[],
  evidence?: EvidenceBundle,
): CompletionReport {
  const allPassed = results.every(r => r.passed);
  const anyPassed = results.some(r => r.passed);

  let confidence = 1;
  if (results.length > 0) {
    const avg = results.reduce((s, r) => s + (r.score ?? (r.passed ? 1 : 0)), 0) / results.length;
    confidence = Math.round(avg * 100) / 100;
  }

  return {
    taskContractId,
    status: allPassed ? 'fulfilled' : anyPassed ? 'partial' : 'failed',
    results,
    evidence: evidence ?? { items: [] },
    confidence,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Create an evidence bundle from loose items.
 */
export function createEvidenceBundle(...items: EvidenceItem[]): EvidenceBundle {
  return { items };
}

/**
 * Quick helpers for common evidence item types.
 */
export const evidence = {
  text(label: string, value: string): EvidenceItem {
    return { type: 'text', label, value };
  },
  metric(label: string, value: number): EvidenceItem {
    return { type: 'metric', label, value };
  },
  url(label: string, value: string): EvidenceItem {
    return { type: 'url', label, value };
  },
  file(label: string, value: string): EvidenceItem {
    return { type: 'file', label, value };
  },
  trace(label: string, value: string): EvidenceItem {
    return { type: 'trace', label, value };
  },
};
