/**
 * @weaveintel/prompts — Prompt optimizer abstraction (Phase 7)
 *
 * Optimizers are pluggable components that can propose improved prompt text
 * while preserving auditability through deterministic diff metadata.
 */

import type { PromptRecordLike } from './records.js';

export interface PromptOptimizationEngine {
  key: string;
  name: string;
  description: string;
  optimize(args: {
    prompt: PromptRecordLike;
    objective: string;
    constraints?: string[];
    context?: Record<string, unknown>;
  }): Promise<{
    template: string;
    variables?: string | null;
    metadata?: Record<string, unknown>;
    reasoning?: string;
  }>;
}

export interface PromptOptimizationRunResult {
  optimizerKey: string;
  optimizerName: string;
  objective: string;
  source: {
    promptId: string;
    version: string;
    template: string;
  };
  candidate: {
    promptId: string;
    version: string;
    template: string;
    variables?: string | null;
  };
  diff: {
    sourceLength: number;
    candidateLength: number;
    charDelta: number;
    sourceLineCount: number;
    candidateLineCount: number;
    lineDelta: number;
    changedLineCount: number;
  };
  reasoning?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

function countChangedLines(source: string, candidate: string): number {
  const sourceLines = source.split('\n');
  const candidateLines = candidate.split('\n');
  const maxLen = Math.max(sourceLines.length, candidateLines.length);
  let changed = 0;
  for (let i = 0; i < maxLen; i += 1) {
    if ((sourceLines[i] ?? '') !== (candidateLines[i] ?? '')) changed += 1;
  }
  return changed;
}

/**
 * Run a prompt optimizer and return an auditable optimization artifact.
 */
export async function runPromptOptimization(args: {
  prompt: PromptRecordLike;
  optimizer: PromptOptimizationEngine;
  objective: string;
  constraints?: string[];
  context?: Record<string, unknown>;
  targetVersion?: string;
}): Promise<PromptOptimizationRunResult> {
  const sourceTemplate = args.prompt.template ?? '';
  const optimized = await args.optimizer.optimize({
    prompt: args.prompt,
    objective: args.objective,
    constraints: args.constraints,
    context: args.context,
  });

  const candidateTemplate = optimized.template;
  const sourceLineCount = sourceTemplate.split('\n').length;
  const candidateLineCount = candidateTemplate.split('\n').length;

  return {
    optimizerKey: args.optimizer.key,
    optimizerName: args.optimizer.name,
    objective: args.objective,
    source: {
      promptId: args.prompt.id,
      version: args.prompt.version ?? '1.0',
      template: sourceTemplate,
    },
    candidate: {
      promptId: args.prompt.id,
      version: args.targetVersion ?? args.prompt.version ?? '1.0',
      template: candidateTemplate,
      variables: optimized.variables,
    },
    diff: {
      sourceLength: sourceTemplate.length,
      candidateLength: candidateTemplate.length,
      charDelta: candidateTemplate.length - sourceTemplate.length,
      sourceLineCount,
      candidateLineCount,
      lineDelta: candidateLineCount - sourceLineCount,
      changedLineCount: countChangedLines(sourceTemplate, candidateTemplate),
    },
    reasoning: optimized.reasoning,
    metadata: optimized.metadata,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Simple deterministic optimizer useful for tests and baseline tuning flows.
 */
export function createConstraintAppenderOptimizer(args: {
  key: string;
  name: string;
  description: string;
  suffix: string;
}): PromptOptimizationEngine {
  return {
    key: args.key,
    name: args.name,
    description: args.description,
    async optimize({ prompt, constraints }) {
      const baseTemplate = (prompt.template ?? '').trim();
      const lines = [baseTemplate];
      if (constraints && constraints.length > 0) {
        lines.push('Constraints:');
        for (const constraint of constraints) lines.push(`- ${constraint}`);
      }
      lines.push(args.suffix.trim());
      return {
        template: lines.join('\n').trim(),
        metadata: { source: 'constraint-appender' },
        reasoning: 'Appended explicit constraint block to increase deterministic compliance.',
      };
    },
  };
}
