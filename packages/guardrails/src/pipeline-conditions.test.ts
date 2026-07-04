/**
 * @weaveintel/guardrails — pipeline-conditions.test.ts
 *
 * Integration tests for conditionContext wiring in DefaultGuardrailPipeline.
 * Verifies: skipping, audit completeness, shortCircuitOnDeny interaction,
 * budgetMs interaction, and backward-compatibility (no conditionContext provided).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Guardrail } from '@weaveintel/core';
import type { GuardrailConditionContext } from './condition-context.js';
import { createGuardrailPipeline, type PipelineOptions } from './pipeline.js';
import { AsyncEvaluatorRegistry } from './async-evaluator.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const makeGuardrail = (id: string, overrides: Partial<Guardrail> = {}): Guardrail => ({
  id,
  name: id,
  type: 'blocklist',
  stage: 'pre-execution',
  enabled: true,
  config: { words: ['forbidden'] },
  priority: 0,
  ...overrides,
});

const baseCtx: GuardrailConditionContext = {
  user: { persona: 'tenant_user', isNew: false },
  chat: { mode: 'direct' },
  turn: { number: 1, hasToolCalls: false, toolCategories: [] },
  risk: { level: 'low', verb: 'read' },
  prior: { hasWarn: false, hasCognitiveWarn: false, hasInjectionWarn: false },
  input: {
    length: 20,
    hasCode: false,
    hasUrls: false,
    hasBase64: false,
    hasStructuredData: false,
    hasDecisionLanguage: false,
    hasValidationSeeking: false,
    hasFactualQuestion: false,
    hasInstructionOverride: false,
    hasSensitivePattern: false,
  },
  output: null,
};

// ── Backward compatibility ─────────────────────────────────────────────────

describe('backward compatibility — no conditionContext', () => {
  it('runs all guardrails when conditionContext is absent, regardless of triggerConditions', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail('g1', {
        // Only fires for agent mode, but no conditionContext → should still run
        triggerConditions: { chat_mode: ['agent'] },
      }),
      makeGuardrail('g2'),
    ];
    const pipeline = createGuardrailPipeline(guardrails);
    const results = await pipeline.evaluate('clean input', 'pre-execution');
    // Both guardrails evaluated (neither blocked "clean input")
    expect(results).toHaveLength(2);
    expect(results.every(r => r.metadata?.['skipped'] === undefined)).toBe(true);
  });

  it('runs a guardrail with null triggerConditions with no conditionContext', async () => {
    const g = makeGuardrail('g1', { triggerConditions: null });
    const pipeline = createGuardrailPipeline([g]);
    const results = await pipeline.evaluate('clean input', 'pre-execution');
    expect(results).toHaveLength(1);
    expect(results[0]?.metadata?.['skipped']).toBeUndefined();
  });
});

// ── Condition skipping ─────────────────────────────────────────────────────

describe('condition skipping', () => {
  it('skips a guardrail whose condition is not met', async () => {
    const g = makeGuardrail('g1', {
      // Only fires in agent mode
      triggerConditions: { chat_mode: ['agent'] },
    });
    const opts: PipelineOptions = { conditionContext: baseCtx }; // direct mode
    const pipeline = createGuardrailPipeline([g], opts);
    const results = await pipeline.evaluate('clean input', 'pre-execution');

    expect(results).toHaveLength(1);
    expect(results[0]?.guardrailId).toBe('g1');
    expect(results[0]?.decision).toBe('allow');
    expect(results[0]?.explanation).toBe('skipped — condition not met');
    expect(results[0]?.metadata?.['skipped']).toBe('condition_not_met');
    expect(results[0]?.metadata?.['durationMs']).toBe(0);
  });

  it('runs a guardrail whose condition is met', async () => {
    const g = makeGuardrail('g1', {
      config: { words: ['forbidden'] },
      triggerConditions: { chat_mode: ['direct'] },
    });
    const pipeline = createGuardrailPipeline([g], { conditionContext: baseCtx });
    const results = await pipeline.evaluate('forbidden content', 'pre-execution');

    expect(results).toHaveLength(1);
    expect(results[0]?.decision).toBe('deny');
    expect(results[0]?.metadata?.['skipped']).toBeUndefined();
  });

  it('null triggerConditions always runs (even with conditionContext present)', async () => {
    const g = makeGuardrail('g1', { triggerConditions: null });
    const pipeline = createGuardrailPipeline([g], { conditionContext: baseCtx });
    const results = await pipeline.evaluate('clean input', 'pre-execution');
    expect(results[0]?.metadata?.['skipped']).toBeUndefined();
    expect(results[0]?.decision).toBe('allow');
  });

  it('absent triggerConditions always runs (even with conditionContext present)', async () => {
    // makeGuardrail does not set triggerConditions — undefined = always-run
    const g = makeGuardrail('g1');
    const pipeline = createGuardrailPipeline([g], { conditionContext: baseCtx });
    const results = await pipeline.evaluate('clean input', 'pre-execution');
    expect(results[0]?.metadata?.['skipped']).toBeUndefined();
  });

  it('skips multiple guardrails whose conditions are not met', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail('g1', { triggerConditions: { chat_mode: ['agent'] }, priority: 1 }),
      makeGuardrail('g2', { triggerConditions: { risk_level: ['high', 'critical'] }, priority: 2 }),
      makeGuardrail('g3', { priority: 3 }), // no condition → always runs
    ];
    const pipeline = createGuardrailPipeline(guardrails, { conditionContext: baseCtx });
    const results = await pipeline.evaluate('clean input', 'pre-execution');

    expect(results).toHaveLength(3);
    expect(results[0]?.metadata?.['skipped']).toBe('condition_not_met');
    expect(results[1]?.metadata?.['skipped']).toBe('condition_not_met');
    expect(results[2]?.metadata?.['skipped']).toBeUndefined();
  });
});

// ── Audit completeness ─────────────────────────────────────────────────────

describe('audit completeness', () => {
  it('every guardrail appears in results — skipped ones are recorded not omitted', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail('skip-me', { triggerConditions: { chat_mode: ['supervisor'] }, priority: 1 }),
      makeGuardrail('run-me', { priority: 2 }),
    ];
    const pipeline = createGuardrailPipeline(guardrails, { conditionContext: baseCtx });
    const results = await pipeline.evaluate('hello', 'pre-execution');

    const ids = results.map(r => r.guardrailId);
    expect(ids).toContain('skip-me');
    expect(ids).toContain('run-me');
    expect(results).toHaveLength(2);
  });

  it('skipped result has all required GuardrailResult fields', async () => {
    const g = makeGuardrail('g1', { triggerConditions: { chat_mode: ['agent'] } });
    const pipeline = createGuardrailPipeline([g], { conditionContext: baseCtx });
    const [result] = await pipeline.evaluate('hello', 'pre-execution');

    expect(result).toMatchObject({
      decision: 'allow',
      guardrailId: 'g1',
      explanation: expect.stringContaining('condition not met'),
      metadata: { skipped: 'condition_not_met', durationMs: 0 },
    });
  });
});

// ── shortCircuitOnDeny interaction ─────────────────────────────────────────

describe('shortCircuitOnDeny with conditions', () => {
  it('a skipped guardrail does not prevent a subsequent deny from short-circuiting', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail('skip-me', {
        triggerConditions: { chat_mode: ['agent'] },
        config: { words: ['forbidden'] },
        priority: 1,
      }),
      makeGuardrail('deny-me', {
        config: { words: ['forbidden'] },
        priority: 2,
      }),
      makeGuardrail('never-reached', {
        config: { words: ['other'] },
        priority: 3,
      }),
    ];
    const pipeline = createGuardrailPipeline(guardrails, {
      shortCircuitOnDeny: true,
      conditionContext: baseCtx,
    });
    const results = await pipeline.evaluate('forbidden content', 'pre-execution');

    // skip-me (skipped) + deny-me (deny, short-circuit) → never-reached is not evaluated
    expect(results).toHaveLength(2);
    expect(results[0]?.metadata?.['skipped']).toBe('condition_not_met');
    expect(results[1]?.decision).toBe('deny');
    expect(results.find(r => r.guardrailId === 'never-reached')).toBeUndefined();
  });

  it('short-circuit is not triggered by a skipped guardrail', async () => {
    const guardrails: Guardrail[] = [
      makeGuardrail('skip-me', {
        triggerConditions: { chat_mode: ['agent'] },
        config: { words: ['bad'] }, // would deny if it ran
        priority: 1,
      }),
      makeGuardrail('run-me', {
        config: { words: ['also-bad'] }, // safe input — allows
        priority: 2,
      }),
    ];
    const pipeline = createGuardrailPipeline(guardrails, {
      shortCircuitOnDeny: true,
      conditionContext: baseCtx,
    });
    const results = await pipeline.evaluate('safe input', 'pre-execution');

    // Both appear: skip-me is skipped, run-me is evaluated (and allows)
    expect(results).toHaveLength(2);
    expect(results[0]?.metadata?.['skipped']).toBe('condition_not_met');
    expect(results[1]?.decision).toBe('allow');
  });
});

// ── budgetMs interaction ───────────────────────────────────────────────────

describe('budgetMs with conditions', () => {
  it('a condition-skipped guardrail does not consume budget (durationMs = 0)', async () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('slow-rule', async () => {
      await new Promise(r => setTimeout(r, 200));
      return { decision: 'allow' as const, guardrailId: 'model-g' };
    });

    const guardrails: Guardrail[] = [
      // This model-graded guardrail would normally eat budget, but its condition is not met
      makeGuardrail('model-g', {
        type: 'model-graded',
        config: { rule: 'slow-rule' },
        triggerConditions: { chat_mode: ['agent'] }, // won't match direct mode
        priority: 1,
      }),
    ];

    const pipeline = createGuardrailPipeline(guardrails, {
      budgetMs: 1,         // extremely tight budget
      registry: reg,
      conditionContext: baseCtx,
    });
    const results = await pipeline.evaluate('test', 'pre-execution');

    // Skipped by condition, not by budget
    expect(results[0]?.metadata?.['skipped']).toBe('condition_not_met');
  });

  it('a condition-passing model-graded guardrail is still budget-skipped when budget exceeded', async () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('budget-rule', async () => {
      await new Promise(r => setTimeout(r, 200));
      return { decision: 'allow' as const, guardrailId: 'model-g' };
    });

    const guardrails: Guardrail[] = [
      makeGuardrail('model-g', {
        type: 'model-graded',
        config: { rule: 'budget-rule' },
        // Condition matches (direct mode)
        triggerConditions: { chat_mode: ['direct'] },
        priority: 1,
      }),
    ];

    const pipeline = createGuardrailPipeline(guardrails, {
      budgetMs: 0, // already exceeded before the loop
      registry: reg,
      conditionContext: baseCtx,
    });
    const results = await pipeline.evaluate('test', 'pre-execution');

    // Passes condition gate, but budget is exceeded → budget_exceeded skip
    expect(results[0]?.metadata?.['skipped']).toBe('budget_exceeded');
  });
});

// ── Complex mixed scenario ─────────────────────────────────────────────────

describe('mixed scenario', () => {
  it('evaluates a realistic pre-execution pipeline with diverse conditions', async () => {
    const reg = new AsyncEvaluatorRegistry();
    const injectionEval = vi.fn().mockResolvedValue({
      decision: 'allow' as const,
      guardrailId: 'injection-classifier',
    });
    reg.register('injection-classifier', injectionEval);

    const agentCtx: GuardrailConditionContext = {
      ...baseCtx,
      chat: { mode: 'agent' },
      turn: { ...baseCtx.turn, hasToolCalls: true },
      input: { ...baseCtx.input, hasUrls: true, length: 400 },
    };

    const guardrails: Guardrail[] = [
      // Always-run: blocklist (no condition)
      makeGuardrail('blocklist', { config: { words: ['forbidden'] }, priority: 1 }),
      // Conditional: only in agent/supervisor mode
      makeGuardrail('injection-classifier', {
        type: 'model-graded',
        config: { rule: 'injection-classifier' },
        triggerConditions: {
          any: [
            { chat_mode: ['agent', 'supervisor'] },
            { input_has_urls: true },
            { input_length_gt: 300 },
          ],
        },
        priority: 2,
      }),
      // Conditional: only for elevated risk — not met in agentCtx (low risk)
      makeGuardrail('high-risk-only', {
        triggerConditions: { risk_level: ['high', 'critical'] },
        priority: 3,
      }),
    ];

    const pipeline = createGuardrailPipeline(guardrails, {
      registry: reg,
      conditionContext: agentCtx,
    });
    const results = await pipeline.evaluate('check https://example.com', 'pre-execution');

    expect(results).toHaveLength(3);
    // blocklist: ran and allowed
    expect(results[0]?.guardrailId).toBe('blocklist');
    expect(results[0]?.metadata?.['skipped']).toBeUndefined();
    // injection-classifier: condition met (agent mode + URLs + length) → ran
    expect(results[1]?.guardrailId).toBe('injection-classifier');
    expect(results[1]?.metadata?.['skipped']).toBeUndefined();
    expect(injectionEval).toHaveBeenCalledOnce();
    // high-risk-only: condition not met (low risk) → skipped
    expect(results[2]?.guardrailId).toBe('high-risk-only');
    expect(results[2]?.metadata?.['skipped']).toBe('condition_not_met');
  });
});
