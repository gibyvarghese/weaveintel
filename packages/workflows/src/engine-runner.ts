import type { WorkflowStep } from '@weaveintel/core';

/**
 * Resolve the next step ID when resuming from a paused state.
 * Respects branch/condition selectors carried in resume data.
 */
export function resolveResumeNextId(step: WorkflowStep, resumeData: unknown): string | undefined {
  if (typeof step.next === 'string') return step.next;
  if (!Array.isArray(step.next)) return undefined;

  // Resume data may carry a branch selector
  if (resumeData !== null && resumeData !== undefined && typeof resumeData === 'object') {
    const d = resumeData as Record<string, unknown>;
    // Explicit branch name
    if (typeof d['branch'] === 'string') {
      const found = step.next.find(n => n === d['branch']);
      if (found) return found;
    }
    // Explicit branch index
    if (typeof d['branchIndex'] === 'number') {
      return step.next[d['branchIndex']];
    }
  }

  // Default: first listed branch (backward-compatible)
  return step.next[0];
}
