/**
 * GeneWeave chat — guardrail evaluation and human-task policy helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 *
 * evaluateGuardrails now also:
 *   - Passes an optional Model to the pipeline so model-graded guardrails
 *     can run when a model reference is available.
 *   - Loads escalation_policy rows from the DB, evaluates them after the
 *     pipeline run, and persists the EscalationResult alongside the eval row.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { AgentStep, EscalationPolicy, Guardrail, GuardrailResult, GuardrailStage, Model } from '@weaveintel/core';
import { getActiveGuardrailJudgeModel, getActiveGuardrailModerationModel, getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import {
  createGuardrailPipeline,
  evaluateEscalation,
  hasDeny,
  hasWarning,
  getDenyReason,
  summarizeGuardrailResults,
  type GuardrailCategorySummary,
  type EscalationContext,
} from '@weaveintel/guardrails';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import { normalizeGuardrail, stageMatches } from './chat-guardrail-utils.js';
import type { DatabaseAdapter } from './db.js';
import { resolveLimits } from './platform-limits.js';

// ── Escalation policy loading ───────────────────────────────

function parseEscalationPolicy(row: { id: string; name: string; description: string | null; config: string | null; enabled: number }): EscalationPolicy | null {
  if (!row.config) return null;
  try {
    const cfg = JSON.parse(row.config) as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      trigger: {
        minWarnCount: typeof cfg['min_warn_count'] === 'number' ? cfg['min_warn_count'] : undefined,
        categories: Array.isArray(cfg['categories']) ? cfg['categories'] as string[] : undefined,
        riskLevels: Array.isArray(cfg['risk_levels']) ? cfg['risk_levels'] as EscalationPolicy['trigger']['riskLevels'] : undefined,
      },
      onEscalate: cfg['on_escalate'] === 'require-approval' ? 'require-approval' : 'block',
    };
  } catch {
    return null;
  }
}

// ── Guardrail evaluation ────────────────────────────────────

export interface EvaluateGuardrailsOpts {
  /** Optional model to pass into PipelineOptions for model-graded evaluators (W2/W3). */
  model?: Model;
  /** Optional pipeline budget in ms — skip model-graded checks if exceeded (W9). */
  budgetMs?: number;
  /** Max chars of input passed to the guardrail pipeline. Defaults to platform limit (8000). */
  maxInputChars?: number;
  /** Tenant ID used to resolve per-tenant limits. */
  tenantId?: string | null;
}

export async function evaluateGuardrails(
  db: DatabaseAdapter,
  chatId: string,
  messageId: string | null,
  input: string,
  stage: GuardrailStage,
  refs?: { userInput?: string; assistantOutput?: string; toolEvidence?: string },
  opts?: EvaluateGuardrailsOpts,
): Promise<{
  decision: 'allow' | 'deny' | 'warn';
  reason?: string;
  results: GuardrailResult[];
  cognitive?: GuardrailCategorySummary;
  escalation?: ReturnType<typeof evaluateEscalation> extends Promise<infer T> ? T : never;
  error?: string;
}> {
  try {
    const rows = await db.listGuardrails();
    const guardrailRows = rows.filter(r => r.enabled && r.type !== 'escalation_policy' && stageMatches(r.stage, stage));
    const escalationRows = rows.filter(r => r.enabled && r.type === 'escalation_policy');

    const guardrails: Guardrail[] = guardrailRows.map(r => normalizeGuardrail(r, stage));
    const escalationPolicies: EscalationPolicy[] = escalationRows
      .map(r => parseEscalationPolicy(r))
      .filter((p): p is EscalationPolicy => p !== null);

    // Truncate before pipeline so neither the normalizer nor the LLM judge
    // ever processes a pathologically large input (e.g. 100K-char flood inputs).
    const limits = await resolveLimits(db, opts?.tenantId);
    const maxInputChars = opts?.maxInputChars ?? limits.guardrail_input_max_chars;
    const guardedInput = input.length > maxInputChars ? input.slice(0, maxInputChars) : input;
    const guardedUserInput = (refs?.userInput ?? input).slice(0, maxInputChars);

    const judgeModel: Model | undefined = opts?.model ?? getActiveGuardrailJudgeModel();

    const pipeline = createGuardrailPipeline(guardrails, {
      shortCircuitOnDeny: true,
      model: judgeModel,
      moderationModel: getActiveGuardrailModerationModel(),
      embeddingModel: getActiveGuardrailEmbeddingModel(),
      budgetMs: opts?.budgetMs,
    });

    const results = guardrails.length > 0
      ? await pipeline.evaluate(guardedInput, stage, {
          userInput: guardedUserInput,
          assistantOutput: refs?.assistantOutput,
          toolEvidence: refs?.toolEvidence,
          action: guardedUserInput,
        })
      : [];

    const cognitive = summarizeGuardrailResults(results, 'cognitive') ?? undefined;

    // Evaluate escalation policies (W4)
    const escalationCtx: EscalationContext = { action: refs?.userInput ?? input, results };
    const escalation = await evaluateEscalation(results, escalationPolicies, escalationCtx);

    const decision = hasDeny(results) || escalation.decision === 'deny'
      ? 'deny' as const
      : hasWarning(results)
        ? 'warn' as const
        : 'allow' as const;
    const reason = getDenyReason(results) ?? (escalation.escalated ? escalation.reason : undefined);

    // Persist evaluation (includes escalation result)
    await db.createGuardrailEval({
      id: newUUIDv7(),
      chat_id: chatId,
      message_id: messageId,
      stage,
      input_preview: input.slice(0, 100),
      results: JSON.stringify(results),
      overall_decision: decision,
      escalation: escalation.escalated ? JSON.stringify(escalation) : null,
    });

    return { decision, reason, results, cognitive, escalation };
  } catch {
    const reason = stage === 'pre-execution'
      ? 'Guardrail evaluation failed before execution; request blocked.'
      : 'Guardrail evaluation failed after execution; treat response as unverified.';
    return {
      decision: stage === 'pre-execution' ? 'deny' : 'warn',
      reason,
      results: [],
      error: 'guardrail_evaluation_failed',
    };
  }
}

// ── Human-task policy evaluation ────────────────────────────

export async function evaluateTaskPolicies(
  db: DatabaseAdapter,
  steps: AgentStep[],
): Promise<Array<{ tool: string; policy: string; taskType: string; priority: string }>> {
  try {
    const rows = await db.listHumanTaskPolicies();
    const enabledRows = rows.filter(r => r.enabled);
    if (enabledRows.length === 0) return [];

    const evaluator = new PolicyEvaluator();
    for (const row of enabledRows) {
      evaluator.addPolicy(createPolicy({
        name: row.name,
        description: row.description ?? undefined,
        trigger: row.trigger,
        taskType: row.task_type as Parameters<typeof createPolicy>[0]['taskType'],
        defaultPriority: row.default_priority as Parameters<typeof createPolicy>[0]['defaultPriority'],
        slaHours: row.sla_hours ?? undefined,
        autoEscalateAfterHours: row.auto_escalate_after_hours ?? undefined,
        assignmentStrategy: row.assignment_strategy as Parameters<typeof createPolicy>[0]['assignmentStrategy'],
        assignTo: row.assign_to ?? undefined,
        enabled: true,
      }));
    }

    const checks: Array<{ tool: string; policy: string; taskType: string; priority: string }> = [];
    for (const step of steps) {
      if (step.toolCall) {
        const result = evaluator.check({ trigger: step.toolCall.name });
        if (result.required && result.policy) {
          checks.push({
            tool: step.toolCall.name,
            policy: result.policy.name,
            taskType: result.policy.taskType,
            priority: result.policy.defaultPriority,
          });
        }
      }
    }

    return checks;
  } catch {
    return [];
  }
}
