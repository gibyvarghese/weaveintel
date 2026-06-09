/**
 * @weaveintel/guardrails — condition-evaluator.ts
 *
 * Pure evaluator for the JSON condition tree (ConditionNode).
 * No I/O — returns true (run the guardrail) or false (skip it).
 *
 * Composition semantics:
 *   all: []  → true  (vacuously true, like Array.every)
 *   any: []  → false (vacuously false, like Array.some)
 *   not: node → !evaluate(node)
 *
 * Unknown leaf shapes fail open — the guardrail runs rather than being silently skipped.
 */
import type { ConditionNode } from '@weaveintel/core';
import type { GuardrailConditionContext } from './condition-context.js';

export function evaluateCondition(
  node: ConditionNode | null | undefined,
  ctx: GuardrailConditionContext,
): boolean {
  // null / absent = always run (backward-compatible default for existing guardrails)
  if (node == null) return true;

  // ── Composition ────────────────────────────────────────────────────────────
  if ('all' in node) return node.all.every(child => evaluateCondition(child, ctx));
  if ('any' in node) return node.any.some(child => evaluateCondition(child, ctx));
  if ('not' in node) return !evaluateCondition(node.not, ctx);

  // ── Context membership ─────────────────────────────────────────────────────
  if ('chat_mode' in node) return node.chat_mode.includes(ctx.chat.mode);
  if ('persona' in node) return node.persona.includes(ctx.user.persona);
  if ('risk_level' in node) return node.risk_level.includes(ctx.risk.level);
  if ('tool_category_in' in node) {
    return node.tool_category_in.some(c => ctx.turn.toolCategories.includes(c));
  }

  // ── Prior-result flags ─────────────────────────────────────────────────────
  if ('prior_has_warn' in node) return ctx.prior.hasWarn === node.prior_has_warn;
  if ('prior_has_cognitive_warn' in node) return ctx.prior.hasCognitiveWarn === node.prior_has_cognitive_warn;
  if ('prior_has_injection_warn' in node) return ctx.prior.hasInjectionWarn === node.prior_has_injection_warn;

  // ── Turn flags ─────────────────────────────────────────────────────────────
  if ('turn_has_tool_calls' in node) return ctx.turn.hasToolCalls === node.turn_has_tool_calls;
  if ('turn_number_gt' in node) return ctx.turn.number > node.turn_number_gt;

  // ── Input numeric ──────────────────────────────────────────────────────────
  if ('input_length_gt' in node) return ctx.input.length > node.input_length_gt;

  // ── Input boolean signals ──────────────────────────────────────────────────
  if ('input_has_code' in node) return ctx.input.hasCode === node.input_has_code;
  if ('input_has_urls' in node) return ctx.input.hasUrls === node.input_has_urls;
  if ('input_has_base64' in node) return ctx.input.hasBase64 === node.input_has_base64;
  if ('input_has_structured_data' in node) return ctx.input.hasStructuredData === node.input_has_structured_data;
  if ('input_has_decision_language' in node) return ctx.input.hasDecisionLanguage === node.input_has_decision_language;
  if ('input_has_validation_seeking' in node) return ctx.input.hasValidationSeeking === node.input_has_validation_seeking;
  if ('input_has_factual_question' in node) return ctx.input.hasFactualQuestion === node.input_has_factual_question;
  if ('input_has_instruction_override' in node) return ctx.input.hasInstructionOverride === node.input_has_instruction_override;
  if ('input_has_sensitive_pattern' in node) return ctx.input.hasSensitivePattern === node.input_has_sensitive_pattern;

  // ── Output numeric ─────────────────────────────────────────────────────────
  // During pre-stage ctx.output is null; numeric predicates on absent output fail the condition.
  if ('output_length_gt' in node) return (ctx.output?.length ?? 0) > node.output_length_gt;

  // ── Output boolean signals ─────────────────────────────────────────────────
  // All output predicates default false when output signals are not yet available (pre-stage).
  if ('output_has_code_blocks' in node) {
    return (ctx.output?.hasCodeBlocks ?? false) === node.output_has_code_blocks;
  }
  if ('output_has_factual_claims' in node) {
    return (ctx.output?.hasFactualClaims ?? false) === node.output_has_factual_claims;
  }
  if ('output_has_advice' in node) {
    return (ctx.output?.hasAdvice ?? false) === node.output_has_advice;
  }
  if ('output_has_credential_patterns' in node) {
    return (ctx.output?.hasCredentialPatterns ?? false) === node.output_has_credential_patterns;
  }
  if ('output_has_tool_evidence' in node) {
    return (ctx.output?.hasToolEvidence ?? false) === node.output_has_tool_evidence;
  }
  if ('output_has_urls' in node) {
    return (ctx.output?.hasUrls ?? false) === node.output_has_urls;
  }

  // Unknown node shape — fail open so the guardrail runs rather than being silently skipped.
  return true;
}
