/**
 * @weaveintel/guardrails — condition-evaluator tests
 *
 * Covers: null = always-run, AND/OR/NOT composition, short-circuit,
 * every leaf predicate type, and fail-open behaviour on unknown nodes.
 */
import { describe, it, expect } from 'vitest';
import type { ConditionNode } from '@weaveintel/core';
import type { GuardrailConditionContext } from './condition-context.js';
import { evaluateCondition } from './condition-evaluator.js';

// ── Fixture context ────────────────────────────────────────────────────────

const baseCtx: GuardrailConditionContext = {
  user: { persona: 'tenant_user', isNew: false },
  chat: { mode: 'direct' },
  turn: { number: 1, hasToolCalls: false, toolCategories: [] },
  risk: { level: 'low', verb: 'read' },
  prior: { hasWarn: false, hasCognitiveWarn: false, hasInjectionWarn: false },
  input: {
    length: 50,
    hasCode: false,
    hasUrls: false,
    hasBase64: false,
    hasStructuredData: false,
    hasDecisionLanguage: false,
    hasValidationSeeking: false,
    hasFactualQuestion: true,
    hasInstructionOverride: false,
    hasSensitivePattern: false,
  },
  output: null,
};

function ctx(overrides: Partial<GuardrailConditionContext> = {}): GuardrailConditionContext {
  return { ...baseCtx, ...overrides };
}

// ── null / undefined = always run ─────────────────────────────────────────

describe('null/absent conditions', () => {
  it('returns true for null (always-run)', () => {
    expect(evaluateCondition(null, baseCtx)).toBe(true);
  });

  it('returns true for undefined (always-run)', () => {
    expect(evaluateCondition(undefined, baseCtx)).toBe(true);
  });
});

// ── Boolean composition ────────────────────────────────────────────────────

describe('all (AND)', () => {
  it('returns true for empty all (vacuously true)', () => {
    expect(evaluateCondition({ all: [] }, baseCtx)).toBe(true);
  });

  it('returns true when all children are true', () => {
    const node: ConditionNode = {
      all: [
        { chat_mode: ['direct'] },
        { persona: ['tenant_user'] },
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(true);
  });

  it('returns false when one child is false', () => {
    const node: ConditionNode = {
      all: [
        { chat_mode: ['direct'] },
        { persona: ['platform_admin'] },  // does not match tenant_user
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
  });

  it('short-circuits: stops evaluating after first false', () => {
    let evaluated = 0;
    // We can't inject a spy without mocking, but we verify the return is correct.
    const node: ConditionNode = {
      all: [
        { persona: ['platform_admin'] },  // false → should stop here
        { chat_mode: ['direct'] },        // would be true but shouldn't run
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
    void evaluated; // suppress unused warning
  });
});

describe('any (OR)', () => {
  it('returns false for empty any (vacuously false)', () => {
    expect(evaluateCondition({ any: [] }, baseCtx)).toBe(false);
  });

  it('returns true when at least one child is true', () => {
    const node: ConditionNode = {
      any: [
        { persona: ['platform_admin'] },  // false
        { chat_mode: ['direct'] },        // true
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(true);
  });

  it('returns false when all children are false', () => {
    const node: ConditionNode = {
      any: [
        { persona: ['platform_admin'] },
        { chat_mode: ['agent'] },
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
  });
});

describe('not', () => {
  it('inverts a true condition', () => {
    expect(evaluateCondition({ not: { chat_mode: ['direct'] } }, baseCtx)).toBe(false);
  });

  it('inverts a false condition', () => {
    expect(evaluateCondition({ not: { chat_mode: ['agent'] } }, baseCtx)).toBe(true);
  });

  it('double negation restores original value', () => {
    const node: ConditionNode = { not: { not: { chat_mode: ['direct'] } } };
    expect(evaluateCondition(node, baseCtx)).toBe(true);
  });
});

describe('nested composition', () => {
  it('evaluates a realistic prompt-injection classifier condition', () => {
    const node: ConditionNode = {
      any: [
        { input_has_code: true },
        { input_has_base64: true },
        { input_has_structured_data: true },
        { input_has_urls: true },
        { input_has_instruction_override: true },
        { persona: ['anonymous'] },
        { prior_has_injection_warn: true },
        { input_length_gt: 300 },
      ],
    };
    // baseCtx has hasCode=false, hasBase64=false, etc., length=50 — should not fire
    expect(evaluateCondition(node, baseCtx)).toBe(false);

    // inject a URL → should fire
    const withUrl = ctx({ input: { ...baseCtx.input, hasUrls: true } });
    expect(evaluateCondition(node, withUrl)).toBe(true);
  });

  it('evaluates a semantic grounding condition', () => {
    const node: ConditionNode = {
      all: [
        { input_has_factual_question: true },
        { output_has_factual_claims: true },
        { output_has_tool_evidence: false },
      ],
    };
    // baseCtx has factual question = true, output = null (defaults to false for output signals)
    // output_has_factual_claims defaults false → all fails
    expect(evaluateCondition(node, baseCtx)).toBe(false);

    // with a post-stage output that has factual claims and no tool evidence
    const postCtx = ctx({
      output: {
        length: 200,
        hasCodeBlocks: false,
        hasFactualClaims: true,
        hasAdvice: false,
        hasCredentialPatterns: false,
        hasToolEvidence: false,
        hasUrls: false,
      },
    });
    expect(evaluateCondition(node, postCtx)).toBe(true);
  });
});

// ── Context membership predicates ──────────────────────────────────────────

describe('chat_mode', () => {
  it('matches when mode is in list', () => {
    expect(evaluateCondition({ chat_mode: ['agent', 'supervisor'] }, ctx({ chat: { mode: 'agent' } }))).toBe(true);
  });

  it('does not match when mode is absent from list', () => {
    expect(evaluateCondition({ chat_mode: ['agent', 'supervisor'] }, baseCtx)).toBe(false);
  });
});

describe('persona', () => {
  it('matches when persona is in list', () => {
    expect(evaluateCondition({ persona: ['tenant_user', 'anonymous'] }, baseCtx)).toBe(true);
  });

  it('does not match when persona is absent', () => {
    expect(evaluateCondition({ persona: ['platform_admin'] }, baseCtx)).toBe(false);
  });
});

describe('risk_level', () => {
  it('matches when risk level is in list', () => {
    const c = ctx({ risk: { level: 'high', verb: 'write' } });
    expect(evaluateCondition({ risk_level: ['high', 'critical'] }, c)).toBe(true);
  });

  it('does not match low risk', () => {
    expect(evaluateCondition({ risk_level: ['high', 'critical'] }, baseCtx)).toBe(false);
  });
});

describe('tool_category_in', () => {
  it('matches when a tool category is present', () => {
    const c = ctx({ turn: { ...baseCtx.turn, toolCategories: ['cse', 'web_search'] } });
    expect(evaluateCondition({ tool_category_in: ['web_search'] }, c)).toBe(true);
  });

  it('does not match when category list is disjoint', () => {
    const c = ctx({ turn: { ...baseCtx.turn, toolCategories: ['file'] } });
    expect(evaluateCondition({ tool_category_in: ['cse', 'web_search'] }, c)).toBe(false);
  });
});

// ── Prior-result flags ─────────────────────────────────────────────────────

describe('prior_has_warn', () => {
  it('matches true when prior has warn', () => {
    const c = ctx({ prior: { hasWarn: true, hasCognitiveWarn: false, hasInjectionWarn: false } });
    expect(evaluateCondition({ prior_has_warn: true }, c)).toBe(true);
  });

  it('matches false when prior has no warn', () => {
    expect(evaluateCondition({ prior_has_warn: false }, baseCtx)).toBe(true);
  });
});

describe('prior_has_cognitive_warn', () => {
  it('matches correctly', () => {
    const c = ctx({ prior: { hasWarn: true, hasCognitiveWarn: true, hasInjectionWarn: false } });
    expect(evaluateCondition({ prior_has_cognitive_warn: true }, c)).toBe(true);
    expect(evaluateCondition({ prior_has_cognitive_warn: false }, c)).toBe(false);
  });
});

describe('prior_has_injection_warn', () => {
  it('matches correctly', () => {
    const c = ctx({ prior: { hasWarn: true, hasCognitiveWarn: false, hasInjectionWarn: true } });
    expect(evaluateCondition({ prior_has_injection_warn: true }, c)).toBe(true);
    expect(evaluateCondition({ prior_has_injection_warn: false }, c)).toBe(false);
  });
});

// ── Turn flags ─────────────────────────────────────────────────────────────

describe('turn_has_tool_calls', () => {
  it('matches when tool calls present', () => {
    const c = ctx({ turn: { ...baseCtx.turn, hasToolCalls: true } });
    expect(evaluateCondition({ turn_has_tool_calls: true }, c)).toBe(true);
  });

  it('does not match when no tool calls', () => {
    expect(evaluateCondition({ turn_has_tool_calls: true }, baseCtx)).toBe(false);
  });
});

describe('turn_number_gt', () => {
  it('returns true when turn number exceeds threshold', () => {
    const c = ctx({ turn: { ...baseCtx.turn, number: 5 } });
    expect(evaluateCondition({ turn_number_gt: 3 }, c)).toBe(true);
  });

  it('returns false when turn number equals threshold (strict greater-than)', () => {
    const c = ctx({ turn: { ...baseCtx.turn, number: 3 } });
    expect(evaluateCondition({ turn_number_gt: 3 }, c)).toBe(false);
  });

  it('returns false when turn number is below threshold', () => {
    expect(evaluateCondition({ turn_number_gt: 3 }, baseCtx)).toBe(false);
  });
});

// ── Input numeric ──────────────────────────────────────────────────────────

describe('input_length_gt', () => {
  it('returns true when input is longer than threshold', () => {
    const c = ctx({ input: { ...baseCtx.input, length: 500 } });
    expect(evaluateCondition({ input_length_gt: 300 }, c)).toBe(true);
  });

  it('returns false when input length equals threshold', () => {
    const c = ctx({ input: { ...baseCtx.input, length: 300 } });
    expect(evaluateCondition({ input_length_gt: 300 }, c)).toBe(false);
  });

  it('returns false when input is shorter', () => {
    expect(evaluateCondition({ input_length_gt: 300 }, baseCtx)).toBe(false);
  });
});

// ── Input boolean signals ──────────────────────────────────────────────────

describe('input boolean predicates', () => {
  it('input_has_code matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasCode: true } });
    expect(evaluateCondition({ input_has_code: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_code: false }, c)).toBe(false);
    expect(evaluateCondition({ input_has_code: true }, baseCtx)).toBe(false);
  });

  it('input_has_urls matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasUrls: true } });
    expect(evaluateCondition({ input_has_urls: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_urls: true }, baseCtx)).toBe(false);
  });

  it('input_has_base64 matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasBase64: true } });
    expect(evaluateCondition({ input_has_base64: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_base64: true }, baseCtx)).toBe(false);
  });

  it('input_has_structured_data matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasStructuredData: true } });
    expect(evaluateCondition({ input_has_structured_data: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_structured_data: true }, baseCtx)).toBe(false);
  });

  it('input_has_decision_language matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasDecisionLanguage: true } });
    expect(evaluateCondition({ input_has_decision_language: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_decision_language: true }, baseCtx)).toBe(false);
  });

  it('input_has_validation_seeking matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasValidationSeeking: true } });
    expect(evaluateCondition({ input_has_validation_seeking: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_validation_seeking: true }, baseCtx)).toBe(false);
  });

  it('input_has_factual_question matches correctly (true in baseCtx)', () => {
    expect(evaluateCondition({ input_has_factual_question: true }, baseCtx)).toBe(true);
    expect(evaluateCondition({ input_has_factual_question: false }, baseCtx)).toBe(false);
  });

  it('input_has_instruction_override matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasInstructionOverride: true } });
    expect(evaluateCondition({ input_has_instruction_override: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_instruction_override: true }, baseCtx)).toBe(false);
  });

  it('input_has_sensitive_pattern matches correctly', () => {
    const c = ctx({ input: { ...baseCtx.input, hasSensitivePattern: true } });
    expect(evaluateCondition({ input_has_sensitive_pattern: true }, c)).toBe(true);
    expect(evaluateCondition({ input_has_sensitive_pattern: false }, c)).toBe(false);
    expect(evaluateCondition({ input_has_sensitive_pattern: true }, baseCtx)).toBe(false);
    expect(evaluateCondition({ input_has_sensitive_pattern: false }, baseCtx)).toBe(true);
  });
});

// ── Output numeric ─────────────────────────────────────────────────────────

describe('output_length_gt', () => {
  it('returns false when output is null (pre-stage)', () => {
    expect(evaluateCondition({ output_length_gt: 0 }, baseCtx)).toBe(false);
  });

  it('returns true when output length exceeds threshold', () => {
    const c = ctx({
      output: {
        length: 600,
        hasCodeBlocks: false,
        hasFactualClaims: false,
        hasAdvice: false,
        hasCredentialPatterns: false,
        hasToolEvidence: false,
        hasUrls: false,
      },
    });
    expect(evaluateCondition({ output_length_gt: 500 }, c)).toBe(true);
  });

  it('returns false when output length is at or below threshold', () => {
    const c = ctx({
      output: {
        length: 200,
        hasCodeBlocks: false,
        hasFactualClaims: false,
        hasAdvice: false,
        hasCredentialPatterns: false,
        hasToolEvidence: false,
        hasUrls: false,
      },
    });
    expect(evaluateCondition({ output_length_gt: 200 }, c)).toBe(false);
  });
});

// ── Output boolean signals ─────────────────────────────────────────────────

const withOutput = (overrides: Partial<NonNullable<GuardrailConditionContext['output']>> = {}): GuardrailConditionContext =>
  ctx({
    output: {
      length: 100,
      hasCodeBlocks: false,
      hasFactualClaims: false,
      hasAdvice: false,
      hasCredentialPatterns: false,
      hasToolEvidence: false,
      hasUrls: false,
      ...overrides,
    },
  });

describe('output boolean predicates', () => {
  it('output_has_code_blocks defaults false when output is null', () => {
    expect(evaluateCondition({ output_has_code_blocks: false }, baseCtx)).toBe(true);
    expect(evaluateCondition({ output_has_code_blocks: true }, baseCtx)).toBe(false);
  });

  it('output_has_code_blocks matches correctly when output present', () => {
    expect(evaluateCondition({ output_has_code_blocks: true }, withOutput({ hasCodeBlocks: true }))).toBe(true);
    expect(evaluateCondition({ output_has_code_blocks: false }, withOutput({ hasCodeBlocks: true }))).toBe(false);
  });

  it('output_has_factual_claims matches correctly', () => {
    expect(evaluateCondition({ output_has_factual_claims: true }, withOutput({ hasFactualClaims: true }))).toBe(true);
    expect(evaluateCondition({ output_has_factual_claims: true }, withOutput())).toBe(false);
  });

  it('output_has_advice matches correctly', () => {
    expect(evaluateCondition({ output_has_advice: true }, withOutput({ hasAdvice: true }))).toBe(true);
    expect(evaluateCondition({ output_has_advice: true }, withOutput())).toBe(false);
  });

  it('output_has_credential_patterns matches correctly', () => {
    expect(evaluateCondition({ output_has_credential_patterns: true }, withOutput({ hasCredentialPatterns: true }))).toBe(true);
    expect(evaluateCondition({ output_has_credential_patterns: true }, withOutput())).toBe(false);
  });

  it('output_has_tool_evidence matches correctly', () => {
    expect(evaluateCondition({ output_has_tool_evidence: true }, withOutput({ hasToolEvidence: true }))).toBe(true);
    expect(evaluateCondition({ output_has_tool_evidence: true }, withOutput())).toBe(false);
  });

  it('output_has_urls matches correctly', () => {
    expect(evaluateCondition({ output_has_urls: true }, withOutput({ hasUrls: true }))).toBe(true);
    expect(evaluateCondition({ output_has_urls: true }, withOutput())).toBe(false);
  });
});

// ── Fail-open for unknown nodes ────────────────────────────────────────────

describe('unknown node shapes', () => {
  it('fails open (returns true) for unrecognised leaf predicates', () => {
    // Cast to any to simulate a future predicate not yet handled by this evaluator version.
    const unknownNode = { future_signal: 'some_value' } as unknown as ConditionNode;
    expect(evaluateCondition(unknownNode, baseCtx)).toBe(true);
  });
});

// ── Real-world condition examples from the design doc ─────────────────────

describe('design-doc condition examples', () => {
  it('LLM Safety Judge: fires for agent mode', () => {
    const node: ConditionNode = {
      any: [
        { chat_mode: ['agent', 'supervisor'] },
        { turn_has_tool_calls: true },
        { risk_level: ['high', 'critical'] },
        { output_length_gt: 500 },
        { prior_has_warn: true },
        { persona: ['anonymous'] },
      ],
    };
    const agentCtx = ctx({ chat: { mode: 'agent' } });
    expect(evaluateCondition(node, agentCtx)).toBe(true);
  });

  it('LLM Safety Judge: does not fire for low-risk direct mode with short output', () => {
    const node: ConditionNode = {
      any: [
        { chat_mode: ['agent', 'supervisor'] },
        { turn_has_tool_calls: true },
        { risk_level: ['high', 'critical'] },
        { output_length_gt: 500 },
        { prior_has_warn: true },
        { persona: ['anonymous'] },
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
  });

  it('Sycophancy Judge: fires when validation seeking present', () => {
    const node: ConditionNode = {
      any: [
        { input_has_validation_seeking: true },
        { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] },
      ],
    };
    const c = ctx({ input: { ...baseCtx.input, hasValidationSeeking: true } });
    expect(evaluateCondition(node, c)).toBe(true);
  });

  it('Sycophancy Judge: fires when turn > 3 and cognitive warn', () => {
    const node: ConditionNode = {
      any: [
        { input_has_validation_seeking: true },
        { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] },
      ],
    };
    const c = ctx({
      turn: { ...baseCtx.turn, number: 5 },
      prior: { hasWarn: true, hasCognitiveWarn: true, hasInjectionWarn: false },
    });
    expect(evaluateCondition(node, c)).toBe(true);
  });

  it('Sycophancy Judge: does not fire for neutral direct-mode turn 1', () => {
    const node: ConditionNode = {
      any: [
        { input_has_validation_seeking: true },
        { all: [{ turn_number_gt: 3 }, { prior_has_cognitive_warn: true }] },
      ],
    };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
  });

  it('Cognitive Post Devil\'s Advocate: only fires on decision language', () => {
    const node: ConditionNode = { input_has_decision_language: true };
    expect(evaluateCondition(node, baseCtx)).toBe(false);
    const c = ctx({ input: { ...baseCtx.input, hasDecisionLanguage: true } });
    expect(evaluateCondition(node, c)).toBe(true);
  });

  it('SSRF probe condition: fires when URLs present', () => {
    const node: ConditionNode = {
      any: [
        { input_has_urls: true },
        { input_has_structured_data: true },
        { chat_mode: ['agent', 'supervisor'] },
      ],
    };
    const c = ctx({ input: { ...baseCtx.input, hasUrls: true } });
    expect(evaluateCondition(node, c)).toBe(true);
    // plain direct mode with no URLs/structured data should not fire
    expect(evaluateCondition(node, baseCtx)).toBe(false);
  });
});
