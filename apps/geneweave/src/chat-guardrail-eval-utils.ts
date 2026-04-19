/**
 * GeneWeave chat — guardrail evaluation and human-task policy helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import { randomUUID } from 'node:crypto';
import type { AgentStep, Guardrail, GuardrailResult, GuardrailStage } from '@weaveintel/core';
import { createGuardrailPipeline, hasDeny, hasWarning, getDenyReason, summarizeGuardrailResults, type GuardrailCategorySummary } from '@weaveintel/guardrails';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import { normalizeGuardrail, stageMatches } from './chat-guardrail-utils.js';
import type { DatabaseAdapter } from './db.js';

// ── Guardrail evaluation ────────────────────────────────────

export async function evaluateGuardrails(
  db: DatabaseAdapter,
  chatId: string,
  messageId: string | null,
  input: string,
  stage: GuardrailStage,
  refs?: { userInput?: string; assistantOutput?: string; toolEvidence?: string },
): Promise<{ decision: 'allow' | 'deny' | 'warn'; reason?: string; results: GuardrailResult[]; cognitive?: GuardrailCategorySummary }> {
  try {
    const rows = await db.listGuardrails();
    const enabledRows = rows.filter(r => r.enabled && stageMatches(r.stage, stage));
    const guardrails: Guardrail[] = enabledRows.map(r => normalizeGuardrail(r, stage));

    const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });
    const results = guardrails.length > 0
      ? await pipeline.evaluate(input, stage, {
          userInput: refs?.userInput ?? input,
          assistantOutput: refs?.assistantOutput,
          toolEvidence: refs?.toolEvidence,
          action: refs?.userInput ?? input,
        })
      : [];
    const cognitive = summarizeGuardrailResults(results, 'cognitive') ?? undefined;

    const decision = hasDeny(results) ? 'deny' as const : hasWarning(results) ? 'warn' as const : 'allow' as const;
    const reason = getDenyReason(results);

    // Persist evaluation
    await db.createGuardrailEval({
      id: randomUUID(),
      chat_id: chatId,
      message_id: messageId,
      stage,
      input_preview: input.slice(0, 100),
      results: JSON.stringify(results),
      overall_decision: decision,
    });

    return { decision, reason, results, cognitive };
  } catch {
    return { decision: 'allow', results: [] };
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
        taskType: row.task_type as any,
        defaultPriority: row.default_priority as any,
        slaHours: row.sla_hours ?? undefined,
        autoEscalateAfterHours: row.auto_escalate_after_hours ?? undefined,
        assignmentStrategy: row.assignment_strategy as any,
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
