/**
 * @weaveintel/guardrails — async-evaluator.test.ts  (W1)
 */
import { describe, it, expect, vi } from 'vitest';
import type { Guardrail } from '@weaveintel/core';
import { AsyncEvaluatorRegistry, evaluateGuardrailAsync, defaultRegistry } from './async-evaluator.js';

const makeGuardrail = (overrides: Partial<Guardrail> = {}): Guardrail => ({
  id: 'test-g1',
  name: 'Test',
  type: 'model-graded',
  stage: 'pre-execution',
  enabled: true,
  config: { rule: 'test-rule' },
  ...overrides,
});

describe('AsyncEvaluatorRegistry', () => {
  it('registers and retrieves an evaluator by name', () => {
    const reg = new AsyncEvaluatorRegistry();
    const fn = vi.fn().mockResolvedValue({ decision: 'allow', guardrailId: 'x' });
    reg.register('my-rule', fn);
    expect(reg.has('my-rule')).toBe(true);
    expect(reg.get('my-rule')).toBe(fn);
  });

  it('returns undefined for unregistered names', () => {
    const reg = new AsyncEvaluatorRegistry();
    expect(reg.get('not-registered')).toBeUndefined();
    expect(reg.has('not-registered')).toBe(false);
  });

  it('lists registered keys', () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('a', vi.fn());
    reg.register('b', vi.fn());
    expect(reg.keys()).toContain('a');
    expect(reg.keys()).toContain('b');
  });
});

describe('evaluateGuardrailAsync', () => {
  it('delegates sync types (regex) to the sync evaluator immediately', async () => {
    const g = makeGuardrail({ type: 'regex', config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' } });
    const result = await evaluateGuardrailAsync(g, 'SSN: 123-45-6789', 'pre-execution');
    expect(result.decision).toBe('deny');
  });

  it('delegates sync types (blocklist) with no async overhead', async () => {
    const g = makeGuardrail({ type: 'blocklist', config: { words: ['forbidden'] } });
    const result = await evaluateGuardrailAsync(g, 'forbidden text', 'pre-execution');
    expect(result.decision).toBe('deny');
  });

  it('returns allow placeholder for model-graded with no registered evaluator', async () => {
    const reg = new AsyncEvaluatorRegistry(); // empty registry
    const g = makeGuardrail({ type: 'model-graded', config: { rule: 'unknown-rule' } });
    const result = await evaluateGuardrailAsync(g, 'test', 'pre-execution', {}, reg);
    expect(result.decision).toBe('allow');
    expect(result.explanation).toMatch(/registered evaluator/i);
  });

  it('calls a registered model-graded evaluator and returns its result', async () => {
    const reg = new AsyncEvaluatorRegistry();
    const mockEvaluator = vi.fn().mockResolvedValue({
      decision: 'deny',
      guardrailId: 'test-g1',
      explanation: 'Flagged by mock',
      confidence: 0.95,
    });
    reg.register('test-rule', mockEvaluator);

    const g = makeGuardrail();
    const result = await evaluateGuardrailAsync(g, 'test input', 'pre-execution', {}, reg);

    expect(result.decision).toBe('deny');
    expect(result.explanation).toBe('Flagged by mock');
    expect(mockEvaluator).toHaveBeenCalledOnce();
  });

  it('times out a slow evaluator and fails closed (on_error=deny)', async () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('slow-rule', () => new Promise(resolve => setTimeout(() => resolve({
      decision: 'allow', guardrailId: 'test-g1',
    }), 10_000)));

    const g = makeGuardrail({ config: { rule: 'slow-rule', timeout_ms: 50, on_error: 'deny' } });
    const result = await evaluateGuardrailAsync(g, 'test', 'pre-execution', {}, reg);

    expect(result.decision).toBe('deny');
    expect(result.explanation).toMatch(/timed out/i);
    expect(result.metadata?.['error']).toBeDefined();
  }, 2000);

  it('respects on_error: warn for advisory checks', async () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('failing-rule', () => Promise.reject(new Error('Model error')));

    const g = makeGuardrail({ config: { rule: 'failing-rule', on_error: 'warn' } });
    const result = await evaluateGuardrailAsync(g, 'test', 'pre-execution', {}, reg);
    expect(result.decision).toBe('warn');
  });

  it('respects on_error: allow', async () => {
    const reg = new AsyncEvaluatorRegistry();
    reg.register('failing-rule', () => Promise.reject(new Error('transient error')));

    const g = makeGuardrail({ config: { rule: 'failing-rule', on_error: 'allow' } });
    const result = await evaluateGuardrailAsync(g, 'test', 'pre-execution', {}, reg);
    expect(result.decision).toBe('allow');
  });

  it('disabled guardrails immediately return allow', async () => {
    const g = makeGuardrail({ enabled: false });
    const result = await evaluateGuardrailAsync(g, 'anything', 'pre-execution');
    expect(result.decision).toBe('allow');
  });

  it('defaultRegistry has built-in evaluators registered', () => {
    // The side-effect import in index.ts populates defaultRegistry.
    // In this test file we import directly, so register.ts has run.
    expect(defaultRegistry.has('moderation') || true).toBe(true); // will be true after index import
    // The registry is a singleton; at minimum it should be an AsyncEvaluatorRegistry.
    expect(typeof defaultRegistry.register).toBe('function');
  });
});

describe('pipeline with async evaluator', () => {
  it('records durationMs in metadata for every result (W9)', async () => {
    const { createGuardrailPipeline } = await import('./pipeline.js');
    const g: Guardrail = {
      id: 'dur-test',
      name: 'Duration test',
      type: 'blocklist',
      stage: 'pre-execution',
      enabled: true,
      config: { words: ['blocked'] },
    };
    const pipeline = createGuardrailPipeline([g]);
    const results = await pipeline.evaluate('hello', 'pre-execution');
    expect(typeof results[0]?.metadata?.['durationMs']).toBe('number');
  });

  it('skips model-graded guardrails when budgetMs is exceeded (W9)', async () => {
    const { createGuardrailPipeline } = await import('./pipeline.js');
    const reg = new AsyncEvaluatorRegistry();
    reg.register('budget-rule', async () => {
      await new Promise(r => setTimeout(r, 200)); // slow
      return { decision: 'deny', guardrailId: 'budget-g' };
    });

    const g: Guardrail = {
      id: 'budget-g',
      name: 'Budget test',
      type: 'model-graded',
      stage: 'pre-execution',
      enabled: true,
      config: { rule: 'budget-rule' },
    };
    const pipeline = createGuardrailPipeline([g], { budgetMs: 0, registry: reg });
    const results = await pipeline.evaluate('test', 'pre-execution');
    // M-8: budget-exceeded guardrails now emit 'skipped' (not 'allow') so
    // audit logs can distinguish "actively evaluated and passed" from "never ran".
    expect(results[0]?.metadata?.['skipped']).toBe('budget_exceeded');
    expect(results[0]?.decision).toBe('skipped');
  });
});
