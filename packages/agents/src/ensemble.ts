/**
 * @weaveintel/agents — Conflict resolution + ensemble runner (W5)
 *
 * Three built-in ConflictResolver implementations:
 *
 * - `createVoteResolver`    — majority vote; ties broken by the first group
 * - `createJudgeResolver`   — scores each candidate via RubricJudgeAdapter; picks highest
 * - `createArbiterResolver` — passes all candidates to a designated model to synthesise/pick
 *
 * `weaveEnsemble` runs N agents on the same input (in parallel or sequentially),
 * collects EnsembleCandidate results, and resolves via the configured ConflictResolver.
 *
 * Composes with W3 (parallel fan-out) and W2 (verifier):
 *   - Run workers in parallel → collect candidates → resolve → (optionally verify)
 */

import type {
  ConflictResolver,
  EnsembleCandidate,
  Agent,
  AgentInput,
  AgentResult,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveAudit, weaveResolveTracer } from '@weaveintel/core';
import type { RubricJudgeAdapter, RubricCriterion } from '@weaveintel/evals';
import type { Model } from '@weaveintel/core';

// ─── Vote resolver ───────────────────────────────────────────

/**
 * Majority-vote conflict resolver. Groups candidates by output text (exact
 * match after trimming) and returns the most common output. Ties broken by
 * the first group encountered in the input array.
 */
export function createVoteResolver(): ConflictResolver {
  return {
    async resolve(_ctx: ExecutionContext, candidates: EnsembleCandidate[]) {
      const counts = new Map<string, { count: number; candidates: EnsembleCandidate[] }>();
      for (const c of candidates) {
        const key = c.output.trim();
        const entry = counts.get(key) ?? { count: 0, candidates: [] };
        entry.count++;
        entry.candidates.push(c);
        counts.set(key, entry);
      }
      let bestKey = '';
      let bestCount = 0;
      let bestCandidates: EnsembleCandidate[] = [];
      for (const [key, { count, candidates: cs }] of counts) {
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
          bestCandidates = cs;
        }
      }
      const winner = bestCandidates[0]?.agentName ?? 'unknown';
      return {
        output: bestKey,
        winner,
        rationale: `Majority vote: ${bestCount}/${candidates.length} agents agreed. Winner: ${winner}.`,
      };
    },
  };
}

// ─── Judge resolver ──────────────────────────────────────────

export interface JudgeResolverOptions {
  /** Rubric adapter for scoring each candidate. */
  adapter: RubricJudgeAdapter;
  /** Criteria to evaluate each candidate against. */
  criteria: RubricCriterion[];
}

/**
 * Rubric-judge conflict resolver. Scores each candidate via `RubricJudgeAdapter`
 * and returns the one with the highest weighted score. When scores are tied,
 * returns the first in the input order.
 */
export function createJudgeResolver(opts: JudgeResolverOptions): ConflictResolver {
  const { adapter, criteria } = opts;

  return {
    async resolve(ctx: ExecutionContext, candidates: EnsembleCandidate[]) {
      const tracer = weaveResolveTracer(ctx);
      const scored = await Promise.all(
        candidates.map(async (c) => {
          let score = 0;
          let reason: string | undefined;
          try {
            const resp = await adapter.score({ content: c.output, criteria });
            score = typeof resp.score === 'number' ? Math.min(1, Math.max(0, resp.score)) : 0;
            reason = resp.reason;
          } catch { /* treat as 0 */ }
          return { candidate: c, score, reason };
        }),
      );

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0]!;

      void weaveAudit(ctx, {
        action: 'ensemble.judge.resolved',
        outcome: 'success',
        resource: 'ensemble',
        details: {
          winner: best.candidate.agentName,
          score: best.score,
          candidateCount: candidates.length,
        },
      });

      if (tracer) {
        void tracer.withSpan(ctx, 'ensemble.judge', async () => ({}), {
          winner: best.candidate.agentName,
          score: best.score,
        });
      }

      return {
        output: best.candidate.output,
        winner: best.candidate.agentName,
        rationale: `Judge selected "${best.candidate.agentName}" with score ${best.score.toFixed(2)}. ${best.reason ?? ''}`.trim(),
      };
    },
  };
}

// ─── Arbiter resolver ────────────────────────────────────────

export interface ArbiterResolverOptions {
  /** Model that evaluates and synthesises all candidates. */
  model: Model;
  /**
   * Optional instruction to the arbiter on how to synthesise/pick.
   * Defaults to "Pick the best answer or synthesise a better one."
   */
  instruction?: string;
}

/**
 * Arbiter conflict resolver. Presents all candidates to a designated model
 * which picks the best one or synthesises a superior response. The arbiter
 * model receives all candidates in a structured prompt and must reply with
 * the final answer.
 */
export function createArbiterResolver(opts: ArbiterResolverOptions): ConflictResolver {
  const { model, instruction } = opts;
  const task = instruction ?? 'Review all candidate responses below. Pick the best one or synthesise a better response. Output ONLY the final answer — no preamble, no explanation.';

  return {
    async resolve(ctx: ExecutionContext, candidates: EnsembleCandidate[]) {
      const candidateBlock = candidates
        .map((c, i) => `## Candidate ${i + 1} (${c.agentName})\n${c.output}`)
        .join('\n\n---\n\n');

      const response = await model.generate(ctx, {
        messages: [
          {
            role: 'system',
            content: `You are an expert arbiter selecting the best response from a set of candidates.\n\n${task}`,
          },
          {
            role: 'user',
            content: candidateBlock,
          },
        ],
      });

      void weaveAudit(ctx, {
        action: 'ensemble.arbiter.resolved',
        outcome: 'success',
        resource: 'ensemble',
        details: { candidateCount: candidates.length },
      });

      return {
        output: response.content,
        rationale: `Arbiter synthesised response from ${candidates.length} candidates.`,
      };
    },
  };
}

// ─── Ensemble runner ─────────────────────────────────────────

export interface EnsembleOptions {
  /**
   * Agents to run on the same input. At least 2 agents required for
   * conflict resolution to be meaningful.
   */
  agents: Agent[];
  /** Conflict resolver to reconcile disagreeing candidates. */
  resolver: ConflictResolver;
  /**
   * When true, all agents run concurrently via `Promise.all`.
   * When false (default), agents run sequentially.
   * Parallel mode is faster but uses more concurrent tokens.
   */
  parallel?: boolean;
}

export interface EnsembleResult extends AgentResult {
  /** All candidate outputs before resolution. */
  candidates: EnsembleCandidate[];
  /** The resolver's rationale for the chosen output. */
  rationale?: string;
  /** Which agent's output was selected (if identifiable). */
  winner?: string;
}

/**
 * Run N agents on the same input and resolve disagreements via a
 * `ConflictResolver`. Returns an `EnsembleResult` that extends `AgentResult`
 * with full candidate provenance.
 *
 * @example
 * const result = await weaveEnsemble({
 *   agents: [agentA, agentB, agentC],
 *   resolver: createJudgeResolver({ adapter: myAdapter, criteria }),
 *   parallel: true,
 * }).run(ctx, { messages: [{ role: 'user', content: 'What is the capital of France?' }] });
 */
export function weaveEnsemble(opts: EnsembleOptions): {
  run(ctx: ExecutionContext, input: AgentInput): Promise<EnsembleResult>;
} {
  const { agents, resolver, parallel = false } = opts;

  return {
    async run(ctx: ExecutionContext, input: AgentInput): Promise<EnsembleResult> {
      const runStart = Date.now();

      void weaveAudit(ctx, {
        action: 'ensemble.run.start',
        outcome: 'success',
        resource: 'ensemble',
        details: { agentCount: agents.length, parallel },
      });

      let agentResults: AgentResult[];
      if (parallel) {
        agentResults = await Promise.all(agents.map((a) => a.run(ctx, input)));
      } else {
        agentResults = [];
        for (const agent of agents) {
          agentResults.push(await agent.run(ctx, input));
        }
      }

      const candidates: EnsembleCandidate[] = agentResults.map((result, i) => ({
        agentName: agents[i]!.config.name,
        output: result.output,
        result,
      }));

      const resolution = await resolver.resolve(ctx, candidates);

      void weaveAudit(ctx, {
        action: 'ensemble.run.end',
        outcome: 'success',
        resource: 'ensemble',
        details: {
          winner: resolution.winner,
          candidateCount: candidates.length,
          durationMs: Date.now() - runStart,
        },
      });

      // Aggregate steps and usage across all agents
      const allSteps = agentResults.flatMap((r, i) =>
        r.steps.map((s) => ({ ...s, content: `[${agents[i]!.config.name}] ${s.content ?? ''}` })),
      );
      const totalTokens = agentResults.reduce((acc, r) => acc + r.usage.totalTokens, 0);
      const totalDurationMs = Date.now() - runStart;

      return {
        output: resolution.output,
        messages: [],
        steps: allSteps,
        usage: {
          totalSteps: allSteps.length,
          promptTokens: agentResults.reduce((acc, r) => acc + r.usage.promptTokens, 0),
          completionTokens: agentResults.reduce((acc, r) => acc + r.usage.completionTokens, 0),
          totalTokens,
          totalDurationMs,
          toolCalls: agentResults.reduce((acc, r) => acc + r.usage.toolCalls, 0),
          delegations: agentResults.reduce((acc, r) => acc + r.usage.delegations, 0),
        },
        status: 'completed',
        candidates,
        rationale: resolution.rationale,
        winner: resolution.winner,
      };
    },
  };
}
