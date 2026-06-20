/**
 * @weaveintel/agents — P6-1: Multi-tier evaluation pipeline
 *
 * Chains: schema-check → rubric-critic (reflect) → verifier → ensemble arbiter
 * as a single configurable pipeline run AFTER the agent's main loop produces
 * its terminal response.
 *
 * Each stage is optional and independently configurable. The first stage that
 * rejects propagates structured feedback back so the agent can regenerate
 * within its step budget.
 *
 * The full per-stage report is available in `AgentResult.metadata.evalPipeline`.
 *
 * Unique advantage: no other framework chains schema-check → rubric critic →
 * ensemble arbiter as a unified configurable pipeline with structured reporting.
 */

import type { ExecutionContext, Model, Critic, CritiqueResult, Verifier, VerifyResult } from '@weaveintel/core';

// ─── Stage result types ───────────────────────────────────────

export interface EvalSchemaStageResult {
  readonly stage: 'schema';
  readonly accepted: boolean;
  readonly errors: string[];
}

export interface EvalReflectStageResult {
  readonly stage: 'reflect';
  readonly accepted: boolean;
  readonly feedback?: string;
  readonly score?: number;
  readonly revisions: number;
}

export interface EvalVerifyStageResult {
  readonly stage: 'verify';
  readonly accepted: boolean;
  readonly reason?: string;
  readonly score?: number;
  readonly attempts: number;
}

export interface EvalEnsembleStageResult {
  readonly stage: 'ensemble';
  readonly accepted: boolean;
  readonly winner?: string;
  readonly rationale?: string;
  readonly candidates: number;
  readonly score?: number;
}

export type EvalStageResult =
  | EvalSchemaStageResult
  | EvalReflectStageResult
  | EvalVerifyStageResult
  | EvalEnsembleStageResult;

/** Aggregate report stored in `AgentResult.metadata.evalPipeline`. */
export interface EvalPipelineReport {
  /** Overall acceptance — true only if every enabled stage accepted. */
  readonly accepted: boolean;
  /** Average score across scored stages (0–1). */
  readonly overallScore: number;
  /** Per-stage results in evaluation order. */
  readonly stages: readonly EvalStageResult[];
  /** Revision cycles consumed. */
  readonly revisions: number;
  /** Verify re-tries consumed. */
  readonly verifyAttempts: number;
  /** ISO timestamp of pipeline completion. */
  readonly evaluatedAt: string;
}

// ─── Stage option types ───────────────────────────────────────

/** Schema validation stage — validates against a JSON schema. */
export interface EvalSchemaStage {
  readonly type: 'schema';
  /** JSON Schema to validate the response against. */
  readonly schema: Record<string, unknown>;
  /**
   * When true (default), a schema failure blocks subsequent stages and
   * triggers a regeneration request.
   */
  readonly blockOnFailure?: boolean;
}

/** Critic / reflection stage — runs a rubric or self critic. */
export interface EvalReflectStage {
  readonly type: 'reflect';
  /** Critic implementation. Defaults to self-critic using the agent model. */
  readonly critic?: Critic;
  /** Maximum regeneration cycles. Default 1. */
  readonly maxRevisions?: number;
  /** Criteria text passed to the critic. */
  readonly criteria?: string;
  /** Minimum score to accept (0–1). Default 0.7. */
  readonly minScore?: number;
}

/** Verifier stage — passes/fails the output against a formal verifier. */
export interface EvalVerifyStage {
  readonly type: 'verify';
  /** Verifier implementation. */
  readonly verifier: Verifier;
  /** Maximum re-generation attempts. Default 1. */
  readonly maxAttempts?: number;
}

/** Ensemble arbiter stage — runs multiple sub-models and picks the best. */
export interface EvalEnsembleStage {
  readonly type: 'ensemble';
  /**
   * Additional models to generate candidate responses from. The first model
   * is always the agent's primary model (already run). Pass 1+ extra models.
   */
  readonly models: Model[];
  /**
   * Arbiter model — picks the best candidate.
   * Defaults to the first model in `models`.
   */
  readonly arbiter?: Model;
  /** Criteria the arbiter uses to score candidates. */
  readonly criteria?: string;
}

export type EvalStageConfig =
  | EvalSchemaStage
  | EvalReflectStage
  | EvalVerifyStage
  | EvalEnsembleStage;

/** Top-level eval pipeline configuration. */
export interface EvalPipelineOptions {
  /** Ordered list of evaluation stages. Executed left → right. */
  readonly stages: readonly EvalStageConfig[];
  /**
   * When true (default), the pipeline short-circuits on the first rejection —
   * subsequent stages are skipped. When false, all stages run regardless.
   */
  readonly failFast?: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────

/** Validate content against a JSON schema (structural, no external refs). */
function validateSchema(content: string, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const type = schema['type'] as string | undefined;
  // Try JSON parse if schema expects object/array
  if (type === 'object' || type === 'array') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      errors.push('Response is not valid JSON');
      return errors;
    }
    if (type === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      errors.push('Expected an object');
    }
    if (type === 'array' && !Array.isArray(parsed)) {
      errors.push('Expected an array');
    }
    // Check required properties
    if (type === 'object' && schema['required'] && Array.isArray(schema['required'])) {
      const obj = parsed as Record<string, unknown>;
      for (const key of schema['required'] as string[]) {
        if (!(key in obj)) errors.push(`Missing required property: ${key}`);
      }
    }
    // Check properties type constraints (one level deep)
    if (type === 'object' && schema['properties'] && typeof schema['properties'] === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(schema['properties'] as Record<string, Record<string, unknown>>)) {
        if (key in obj) {
          const propType = propSchema['type'] as string | undefined;
          const val = obj[key];
          if (propType === 'string' && typeof val !== 'string') errors.push(`Property ${key}: expected string`);
          if (propType === 'number' && typeof val !== 'number') errors.push(`Property ${key}: expected number`);
          if (propType === 'boolean' && typeof val !== 'boolean') errors.push(`Property ${key}: expected boolean`);
          if (propType === 'array' && !Array.isArray(val)) errors.push(`Property ${key}: expected array`);
          if (propType === 'object' && (typeof val !== 'object' || val === null)) errors.push(`Property ${key}: expected object`);
        }
      }
    }
  } else if (type === 'string' && typeof content !== 'string') {
    errors.push('Expected a string response');
  }
  return errors;
}

// ─── Pipeline runner ──────────────────────────────────────────

export interface RunPipelineInput {
  ctx: ExecutionContext;
  content: string;
  agentModel: Model;
  agentName: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface RunPipelineOutput {
  /** Final (possibly revised) content. */
  content: string;
  report: EvalPipelineReport;
  /** Feedback string for the agent loop (non-null when a stage rejected). */
  rejectionFeedback?: string;
}

/**
 * Run the evaluation pipeline against `content`. Returns the (possibly
 * revised) content and a structured per-stage report.
 */
export async function runEvalPipeline(
  pipelineOpts: EvalPipelineOptions,
  input: RunPipelineInput,
): Promise<RunPipelineOutput> {
  const { stages, failFast = true } = pipelineOpts;
  const { ctx, agentModel, agentName } = input;

  let currentContent = input.content;
  const stageResults: EvalStageResult[] = [];
  let totalRevisions = 0;
  let totalVerifyAttempts = 0;
  let overallAccepted = true;
  let rejectionFeedback: string | undefined;
  const scores: number[] = [];

  for (const stage of stages) {
    if (!overallAccepted && failFast) break;

    // ── Schema stage ───────────────────────────────────────────
    if (stage.type === 'schema') {
      const errors = validateSchema(currentContent, stage.schema);
      const accepted = errors.length === 0;
      const stageResult: EvalSchemaStageResult = { stage: 'schema', accepted, errors };
      stageResults.push(stageResult);
      if (!accepted) {
        overallAccepted = false;
        rejectionFeedback = `Schema validation failed: ${errors.join('; ')}. Please respond with valid JSON matching the required schema.`;
        if (failFast && (stage.blockOnFailure !== false)) break;
      }
      continue;
    }

    // ── Reflect stage ──────────────────────────────────────────
    if (stage.type === 'reflect') {
      const { createSelfCritic } = await import('./reflect.js');
      const critic: Critic = stage.critic ?? createSelfCritic({ model: agentModel, criteria: stage.criteria });
      const minScore = stage.minScore ?? 0.7;
      const maxRevisions = stage.maxRevisions ?? 1;

      let accepted = false;
      let feedback: string | undefined;
      let score: number | undefined;
      let revisions = 0;
      let evalContent = currentContent;

      for (let attempt = 0; attempt <= maxRevisions; attempt++) {
        let cr: CritiqueResult;
        try {
          cr = await critic.critique(ctx, agentName, evalContent);
        } catch {
          // Critic failure — accept as-is (fail open)
          cr = { accepted: true };
        }
        accepted = cr.accepted;
        feedback = cr.feedback;
        score = cr.score;
        if (score !== undefined) scores.push(score);
        if (accepted || attempt === maxRevisions) break;
        revisions++;
        totalRevisions++;
        // On rejection, the agent's outer loop handles regeneration.
        // The pipeline itself marks as rejected and bubbles up feedback.
        evalContent = currentContent; // no inline regeneration — leave to caller
      }

      const stageResult: EvalReflectStageResult = {
        stage: 'reflect',
        accepted,
        feedback,
        score,
        revisions,
      };
      stageResults.push(stageResult);
      if (!accepted) {
        overallAccepted = false;
        rejectionFeedback = feedback ?? 'Please improve your response quality.';
        if (failFast) break;
      }
      continue;
    }

    // ── Verify stage ───────────────────────────────────────────
    if (stage.type === 'verify') {
      const maxAttempts = stage.maxAttempts ?? 1;
      let accepted = false;
      let reason: string | undefined;
      let score: number | undefined;
      let attempts = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attempts++;
        let vr: VerifyResult;
        try {
          vr = await stage.verifier.verify(ctx, currentContent, { agentName });
        } catch {
          vr = { passed: false, reason: 'Verifier error' };
        }
        accepted = vr.passed;
        reason = vr.reason;
        score = vr.score;
        if (score !== undefined) scores.push(score);
        totalVerifyAttempts++;
        if (accepted) break;
      }

      const stageResult: EvalVerifyStageResult = {
        stage: 'verify',
        accepted,
        reason,
        score,
        attempts,
      };
      stageResults.push(stageResult);
      if (!accepted) {
        overallAccepted = false;
        rejectionFeedback = reason ?? 'Verification failed. Please improve your response.';
        if (failFast) break;
      }
      continue;
    }

    // ── Ensemble stage ─────────────────────────────────────────
    if (stage.type === 'ensemble') {
      const { models, criteria } = stage;
      const arbiter = stage.arbiter ?? agentModel;

      // Generate candidates from additional models
      const candidates: string[] = [currentContent];
      for (const m of models) {
        try {
          const resp = await m.generate(ctx, {
            messages: input.conversationHistory
              ? (input.conversationHistory as Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>)
              : [{ role: 'user', content: `Please provide a response for: ${agentName}` }],
          });
          if (resp.content) candidates.push(resp.content);
        } catch {
          /* skip failed model — don't block pipeline */
        }
      }

      // Arbiter picks the best candidate
      let winner = currentContent;
      let rationale: string | undefined;
      let score: number | undefined;

      if (candidates.length > 1) {
        const arbitrationPrompt = [
          {
            role: 'user' as const,
            content: [
              `You are an expert evaluator. Given these ${candidates.length} response candidates, select the BEST one.`,
              criteria ? `Evaluation criteria: ${criteria}` : '',
              '',
              ...candidates.map((c, i) => `## Candidate ${i + 1}\n${c}`),
              '',
              'Respond with JSON: { "winner": <1-based index>, "rationale": "<brief explanation>", "score": <0.0-1.0> }',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ];

        try {
          const arbResponse = await arbiter.generate(ctx, { messages: arbitrationPrompt });
          const parsed = JSON.parse(arbResponse.content || '{}') as {
            winner?: number;
            rationale?: string;
            score?: number;
          };
          const idx = (parsed.winner ?? 1) - 1;
          winner = candidates[Math.max(0, Math.min(idx, candidates.length - 1))]!;
          rationale = parsed.rationale;
          score = parsed.score;
          if (score !== undefined) scores.push(score);
          currentContent = winner;
        } catch {
          /* arbiter failure — keep current content */
        }
      }

      const stageResult: EvalEnsembleStageResult = {
        stage: 'ensemble',
        accepted: true, // ensemble always accepts (it picks the best)
        winner,
        rationale,
        candidates: candidates.length,
        score,
      };
      stageResults.push(stageResult);
      continue;
    }
  }

  const overallScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 1.0;

  const report: EvalPipelineReport = {
    accepted: overallAccepted,
    overallScore,
    stages: stageResults,
    revisions: totalRevisions,
    verifyAttempts: totalVerifyAttempts,
    evaluatedAt: new Date().toISOString(),
  };

  return {
    content: currentContent,
    report,
    rejectionFeedback: overallAccepted ? undefined : rejectionFeedback,
  };
}
