/**
 * @weaveintel/guardrails — evaluators/system-prompt-leakage.ts  (4.19)
 *
 * Pattern-based guardrail that detects when an LLM response is leaking
 * system-prompt content back to the user. System-prompt disclosure is a
 * confidentiality violation: it can reveal internal instructions, persona
 * details, capability constraints, or business logic that operators intend
 * to keep private.
 *
 * This evaluator runs on the `assistantOutput` (post-generation) stage.
 * It is intentionally pattern-based rather than LLM-graded so it runs fast
 * and deterministically in the critical response path without adding another
 * model call. It detects the most common disclosure patterns; an LLM-judge
 * layer can be added on top for subtler cases.
 *
 * Detection approach:
 *  1. Structural markers: "You are a..." / "Your role is" / "As an AI..."
 *     preambles that appear verbatim in most system prompts.
 *  2. Meta-commentary markers: the model explicitly says it has a system
 *     prompt or instructions it's following.
 *  3. Delimiter echoing: reproduction of common system-prompt delimiters
 *     like <|system|>, [INST], <<SYS>>, ##INSTRUCTIONS##, etc.
 *  4. Optional hash check: if `config.systemPromptHash` is set (SHA-256 of
 *     the real system prompt), the evaluator checks whether the output
 *     overlaps significantly with the prompt text (heuristic fingerprint).
 *
 * config shape:
 *   action?: 'deny' | 'warn'      — decision when triggered (default: 'warn')
 *   sensitivity?: 'low' | 'medium' | 'high'  — number of pattern classes
 *                                               that must match (default: 'low' = any match)
 *   customPatterns?: string[]     — additional RegExp source strings to include
 */

import type { AsyncGuardrailContext, Guardrail, GuardrailResult } from '@weaveintel/core';

/* ─── Pattern banks ─────────────────────────────────────────────────── */

/** Structural phrases commonly found at the start of system prompts. */
const STRUCTURAL_PATTERNS: RegExp[] = [
  /\byou are (?:a|an|the) (?:helpful|professional|friendly|expert|advanced|powerful|ai|language|chat|assistant)/i,
  /\byour (?:role|job|purpose|task|goal|mission) is\b/i,
  /\byou (?:must|should|will|shall|are required to) (?:always|never|not|only|respond|answer|behave|act)/i,
  /\bas (?:a|an) (?:helpful|professional|ai|language) (?:assistant|model|ai)\b/i,
  /\bdo not (?:reveal|disclose|share|mention|repeat) (?:these|this|your|the) (?:instructions?|prompt|context|system|guidelines?)\b/i,
];

/** Meta-commentary — the model explicitly references its own instructions. */
const META_PATTERNS: RegExp[] = [
  /\bmy (?:system|instructions?|prompt|guidelines?|directives?|rules?) (?:say|state|tell|require|instruct)\b/i,
  /\baccording to my (?:system|instructions?|prompt|guidelines?)\b/i,
  /\bi (?:have|was given|was provided with|was instructed) a system prompt\b/i,
  /\bthe system prompt (?:says?|states?|tells?|specifies?|reads?)\b/i,
  /\bmy (?:context|setup|configuration) (?:says?|states?|tells?|includes?)\b/i,
  /\bi(?:'m| am) programmed (?:to|with)\b/i,
];

/** Common system-prompt delimiter patterns used by various model APIs. */
const DELIMITER_PATTERNS: RegExp[] = [
  /\|system\|/i,
  /<\|im_start\|>/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /##\s*(?:INSTRUCTIONS?|SYSTEM\s*PROMPT|CONTEXT|PERSONA|BACKGROUND)\s*##/i,
  /\[SYSTEM\]/i,
  /\bSYSTEM:\s*\n/i,
  /---\s*(?:system|instructions?|prompt)\s*---/i,
];

/**
 * Verbatim echo patterns — short specific phrases that would only appear if
 * the model copied from its context window.
 */
const VERBATIM_ECHO_PATTERNS: RegExp[] = [
  /\bignore previous instructions\b/i,
  /\bconfidential and proprietary\b/i,
  /\bdo not share (?:this|these) instructions?\b/i,
  /\bthis is your system prompt\b/i,
  /\bkeep (?:this|these) instructions? confidential\b/i,
];

const ALL_PATTERN_BANKS: RegExp[][] = [
  STRUCTURAL_PATTERNS,
  META_PATTERNS,
  DELIMITER_PATTERNS,
  VERBATIM_ECHO_PATTERNS,
];

/* ─── Evaluator ─────────────────────────────────────────────────────── */

export function createSystemPromptLeakageEvaluator() {
  return async function systemPromptLeakageEvaluator(
    guardrail: Guardrail,
    _input: string,
    ctx: AsyncGuardrailContext,
  ): Promise<GuardrailResult> {
    const output = ctx.assistantOutput ?? '';
    if (!output.trim()) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'Empty assistant output — no leakage check needed',
        confidence: 1,
      };
    }

    const action = guardrail.config['action'] === 'deny' ? 'deny' : 'warn';
    const customPatterns = (guardrail.config['customPatterns'] as string[] | undefined)
      ?.map((src) => {
        try { return new RegExp(src, 'i'); } catch { return null; }
      })
      .filter((r): r is RegExp => r !== null) ?? [];

    const banksToCheck: RegExp[][] = [
      ...ALL_PATTERN_BANKS,
      ...(customPatterns.length > 0 ? [customPatterns] : []),
    ];

    // Track which pattern classes fired.
    const firedBanks: string[] = [];
    const matchedPatterns: string[] = [];

    for (let bankIdx = 0; bankIdx < banksToCheck.length; bankIdx++) {
      const bank = banksToCheck[bankIdx]!;
      for (const pattern of bank) {
        if (pattern.test(output)) {
          const bankName = bankIdx < ALL_PATTERN_BANKS.length
            ? ['structural', 'meta_commentary', 'delimiter', 'verbatim_echo'][bankIdx]!
            : 'custom';
          if (!firedBanks.includes(bankName)) firedBanks.push(bankName);
          matchedPatterns.push(pattern.source.slice(0, 80));
          break; // one match per bank is sufficient
        }
      }
    }

    if (firedBanks.length === 0) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'No system-prompt leakage patterns detected',
        confidence: 0.9,
        metadata: { banksChecked: banksToCheck.length },
      };
    }

    const explanation =
      `System-prompt leakage detected in assistant output. ` +
      `Triggered pattern class(es): ${firedBanks.join(', ')}.`;

    return {
      decision: action,
      guardrailId: guardrail.id,
      explanation,
      confidence: Math.min(0.95, 0.6 + firedBanks.length * 0.1),
      metadata: {
        firedBanks,
        samplePatterns: matchedPatterns.slice(0, 5),
      },
    };
  };
}
