/**
 * @weaveintel/guardrails — Unit tests
 */
import { describe, it, expect } from 'vitest';
import type { Guardrail, GuardrailResult } from '@weaveintel/core';
import {
  evaluateGuardrail,
  summarizeGuardrailResults,
  createGuardrailPipeline,
  hasDeny,
  hasWarning,
  getDenyReason,
  DefaultRiskClassifier,
  DefaultConfidenceGate,
  DefaultActionGate,
  CostGuard,
} from './index.js';

// ─── evaluateGuardrail ──────────────────────────────────────

describe('evaluateGuardrail', () => {
  it('allows input not matching regex', () => {
    const g: Guardrail = {
      id: 'g1', name: 'SSN Check', type: 'regex', stage: 'pre-execution',
      enabled: true, config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
    };
    const result = evaluateGuardrail(g, 'Hello world', 'pre-execution');
    expect(result.decision).toBe('allow');
  });

  it('denies input matching regex', () => {
    const g: Guardrail = {
      id: 'g2', name: 'SSN Check', type: 'regex', stage: 'pre-execution',
      enabled: true, config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
    };
    const result = evaluateGuardrail(g, 'My SSN is 123-45-6789', 'pre-execution');
    expect(result.decision).toBe('deny');
    expect(result.guardrailId).toBe('g2');
  });

  it('warns on regex match when action is warn', () => {
    const g: Guardrail = {
      id: 'g3', name: 'Email Check', type: 'regex', stage: 'pre-execution',
      enabled: true, config: { pattern: '[^@]+@[^@]+\\.[^@]+', action: 'warn' },
    };
    const result = evaluateGuardrail(g, 'Contact me at test@example.com', 'pre-execution');
    expect(result.decision).toBe('warn');
  });

  it('denies blocklist match', () => {
    const g: Guardrail = {
      id: 'g4', name: 'Blocklist', type: 'blocklist', stage: 'pre-execution',
      enabled: true, config: { words: ['forbidden', 'badword'] },
    };
    const result = evaluateGuardrail(g, 'This is forbidden content', 'pre-execution');
    expect(result.decision).toBe('deny');
  });

  it('allows non-blocklisted input', () => {
    const g: Guardrail = {
      id: 'g5', name: 'Blocklist', type: 'blocklist', stage: 'pre-execution',
      enabled: true, config: { words: ['forbidden'] },
    };
    const result = evaluateGuardrail(g, 'This is fine', 'pre-execution');
    expect(result.decision).toBe('allow');
  });

  it('checks length limits', () => {
    const g: Guardrail = {
      id: 'g6', name: 'Length', type: 'length', stage: 'pre-execution',
      enabled: true, config: { maxLength: 10, action: 'deny' },
    };
    const result = evaluateGuardrail(g, 'This is way too long for the limit', 'pre-execution');
    expect(result.decision).toBe('deny');
  });

  it('allows within length', () => {
    const g: Guardrail = {
      id: 'g7', name: 'Length', type: 'length', stage: 'pre-execution',
      enabled: true, config: { maxLength: 100 },
    };
    const result = evaluateGuardrail(g, 'Short text', 'pre-execution');
    expect(result.decision).toBe('allow');
  });

  it('evaluates context-aware custom grounding rules', () => {
    const g: Guardrail = {
      id: 'g8', name: 'Grounding', type: 'custom', stage: 'post-execution',
      enabled: true, config: { rule: 'grounding-overlap', category: 'cognitive', min_overlap: 0.2 },
    };
    const result = evaluateGuardrail(g, 'BANANA', 'post-execution', {
      userInput: 'What is the capital of France?',
      assistantOutput: 'BANANA',
    });
    expect(result.decision).toBe('warn');
    expect(result.metadata?.['category']).toBe('cognitive');
  });

  it('warns when day-of-week answer lacks evidence context', () => {
    const g: Guardrail = {
      id: 'g10',
      name: 'Date Evidence Check',
      type: 'custom',
      stage: 'post-execution',
      enabled: true,
      config: {
        rule: 'grounding-overlap',
        category: 'verification',
        min_overlap: 0.35,
      },
    };

    const result = evaluateGuardrail(g, 'It is Monday.', 'post-execution', {
      userInput: 'What day is it today?',
      assistantOutput: 'It is Monday.',
      metadata: { hasDateTimeTool: false },
    });

    expect(result.decision).toBe('warn');
    expect(result.explanation).toContain('grounding overlap');
  });

  it('evaluates aggregate confidence rules using previous results', () => {
    const g: Guardrail = {
      id: 'g9', name: 'Aggregate Confidence', type: 'custom', stage: 'post-execution',
      enabled: true, config: { rule: 'aggregate-confidence-gate', category: 'cognitive', gate_threshold: 0.8, gate_on_fail: 'warn' },
    };
    const result = evaluateGuardrail(g, 'ignored', 'post-execution', {
      previousResults: [
        { decision: 'warn', guardrailId: 'a', confidence: 0.2, metadata: { category: 'cognitive', riskLevel: 'medium' } },
        { decision: 'allow', guardrailId: 'b', confidence: 0.4, metadata: { category: 'cognitive' } },
      ],
    });
    expect(result.decision).toBe('warn');
    expect(result.confidence).toBeLessThan(0.8);
  });
});

// ─── Pipeline ───────────────────────────────────────────────

describe('createGuardrailPipeline', () => {
  it('evaluates all guardrails in order', async () => {
    const guardrails: Guardrail[] = [
      { id: 'g1', name: 'Check 1', type: 'regex', stage: 'pre-execution', enabled: true, config: { pattern: 'bad', action: 'warn' }, priority: 1 },
      { id: 'g2', name: 'Check 2', type: 'blocklist', stage: 'pre-execution', enabled: true, config: { words: ['terrible'] }, priority: 2 },
    ];

    const pipeline = createGuardrailPipeline(guardrails);
    const results = await pipeline.evaluate('This is fine', 'pre-execution');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.decision === 'allow')).toBe(true);
  });

  it('short-circuits on deny', async () => {
    const guardrails: Guardrail[] = [
      { id: 'g1', name: 'Deny First', type: 'blocklist', stage: 'pre-execution', enabled: true, config: { words: ['forbidden'] }, priority: 1 },
      { id: 'g2', name: 'Never Reached', type: 'regex', stage: 'pre-execution', enabled: true, config: { pattern: '.*', action: 'warn' }, priority: 2 },
    ];

    const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });
    const results = await pipeline.evaluate('This is forbidden', 'pre-execution');
    expect(results).toHaveLength(1);
    expect(results[0]!.decision).toBe('deny');
  });

  it('filters by stage', async () => {
    const guardrails: Guardrail[] = [
      { id: 'g1', name: 'Pre Only', type: 'blocklist', stage: 'pre-execution', enabled: true, config: { words: ['test'] }, priority: 1 },
      { id: 'g2', name: 'Post Only', type: 'blocklist', stage: 'post-execution', enabled: true, config: { words: ['test'] }, priority: 1 },
    ];

    const pipeline = createGuardrailPipeline(guardrails);
    const preResults = await pipeline.evaluate('test text', 'pre-execution');
    expect(preResults).toHaveLength(1);
    expect(preResults[0]!.guardrailId).toBe('g1');
  });

  it('skips disabled guardrails', async () => {
    const guardrails: Guardrail[] = [
      { id: 'g1', name: 'Disabled', type: 'blocklist', stage: 'pre-execution', enabled: false, config: { words: ['test'] }, priority: 1 },
    ];

    const pipeline = createGuardrailPipeline(guardrails);
    const results = await pipeline.evaluate('test text', 'pre-execution');
    expect(results).toHaveLength(0);
  });

  it('passes runtime context through the pipeline', async () => {
    const guardrails: Guardrail[] = [
      { id: 'g1', name: 'Grounding', type: 'custom', stage: 'post-execution', enabled: true, config: { rule: 'grounding-overlap', category: 'cognitive', min_overlap: 0.2 }, priority: 1 },
      { id: 'g2', name: 'Confidence', type: 'custom', stage: 'post-execution', enabled: true, config: { rule: 'aggregate-confidence-gate', category: 'cognitive', gate_threshold: 0.8, gate_on_fail: 'warn' }, priority: 2 },
    ];

    const pipeline = createGuardrailPipeline(guardrails);
    const results = await pipeline.evaluate('BANANA', 'post-execution', {
      userInput: 'What is the capital of France?',
      assistantOutput: 'BANANA',
    });
    expect(results).toHaveLength(2);
    expect(results[0]!.decision).toBe('warn');
    expect(results[1]!.decision).toBe('warn');
  });
});

// ─── Helpers ────────────────────────────────────────────────

describe('result helpers', () => {
  const results: GuardrailResult[] = [
    { decision: 'allow', guardrailId: 'g1' },
    { decision: 'deny', guardrailId: 'g2', explanation: 'Blocked: SSN detected' },
    { decision: 'warn', guardrailId: 'g3', explanation: 'Contains email' },
  ];

  it('hasDeny detects deny', () => {
    expect(hasDeny(results)).toBe(true);
    expect(hasDeny([{ decision: 'allow', guardrailId: 'g1' }])).toBe(false);
  });

  it('hasWarning detects warn', () => {
    expect(hasWarning(results)).toBe(true);
    expect(hasWarning([{ decision: 'allow', guardrailId: 'g1' }])).toBe(false);
  });

  it('getDenyReason returns first deny explanation', () => {
    expect(getDenyReason(results)).toBe('Blocked: SSN detected');
    expect(getDenyReason([{ decision: 'allow', guardrailId: 'g1' }])).toBeUndefined();
  });

  it('summarizes a category of results', () => {
    const summary = summarizeGuardrailResults([
      { decision: 'warn', guardrailId: 'g1', confidence: 0.4, metadata: { category: 'cognitive', riskLevel: 'medium' } },
      { decision: 'allow', guardrailId: 'g2', confidence: 0.8, metadata: { category: 'cognitive' } },
      { decision: 'deny', guardrailId: 'g3', confidence: 0.1, metadata: { category: 'other' } },
    ], 'cognitive');
    expect(summary?.decision).toBe('warn');
    expect(summary?.riskLevel).toBe('medium');
    expect(summary?.checks).toHaveLength(2);
  });
});

// ─── RiskClassifier ─────────────────────────────────────────

describe('DefaultRiskClassifier', () => {
  it('classifies CRUD operations', async () => {
    const classifier = new DefaultRiskClassifier();
    const del = await classifier.classify('delete-database');
    expect(del.level).toBe('critical');

    const read = await classifier.classify('read-file');
    expect(read.level).toBe('low');
  });

  it('defaults to low for unknown actions', async () => {
    const classifier = new DefaultRiskClassifier();
    const result = await classifier.classify('something-unusual');
    expect(result.level).toBe('low');
  });
});

// ─── ConfidenceGate ─────────────────────────────────────────

describe('DefaultConfidenceGate', () => {
  it('allows above threshold', () => {
    const gate = new DefaultConfidenceGate(0.7, 'block');
    expect(gate.evaluate(0.9)).toBe('allow');
  });

  it('blocks below threshold when action is block', () => {
    const gate = new DefaultConfidenceGate(0.7, 'block');
    expect(gate.evaluate(0.5)).toBe('deny');
  });

  it('warns below threshold when action is warn', () => {
    const gate = new DefaultConfidenceGate(0.7, 'warn');
    expect(gate.evaluate(0.5)).toBe('warn');
  });
});

// ─── ActionGate ─────────────────────────────────────────────

describe('DefaultActionGate', () => {
  it('denies actions in deniedActions list', () => {
    const gate = new DefaultActionGate([], ['delete', 'drop']);
    expect(gate.evaluate('delete')).toBe('deny');
    expect(gate.evaluate('read')).toBe('allow');
  });

  it('allows only actions in allowedActions list', () => {
    const gate = new DefaultActionGate(['read', 'list'], []);
    expect(gate.evaluate('read')).toBe('allow');
    expect(gate.evaluate('write')).toBe('deny');
  });
});

// ─── CostGuard ──────────────────────────────────────────────

describe('CostGuard', () => {
  it('allows within budget', () => {
    const guard = new CostGuard({ maxTokensTotal: 100000, maxCostUsd: 10, maxRequestsPerMinute: 100 });
    const results = guard.check();
    expect(results).toHaveLength(0);
  });

  it('records usage and blocks when over budget', () => {
    const guard = new CostGuard({ maxTokensTotal: 100, maxCostUsd: 10, maxRequestsPerMinute: 100 });
    guard.record(80, 0.01);
    expect(guard.check()).toHaveLength(0);
    guard.record(30, 0.01);
    // totalTokens = 110 > 100
    const results = guard.check();
    expect(results.some(r => r.decision === 'deny')).toBe(true);
    expect(results.some(r => r.explanation?.includes('tokens'))).toBe(true);
  });

  it('blocks on cost limit', () => {
    const guard = new CostGuard({ maxTokensTotal: 999999, maxCostUsd: 0.05, maxRequestsPerMinute: 100 });
    guard.record(100, 0.03);
    guard.record(100, 0.03);
    // totalCost = 0.06 > 0.05
    const results = guard.check();
    expect(results.some(r => r.decision === 'deny')).toBe(true);
    expect(results.some(r => r.explanation?.includes('cost'))).toBe(true);
  });

  it('blocks on request limit', () => {
    const guard = new CostGuard({ maxTokensTotal: 999999, maxCostUsd: 100, maxRequestsPerMinute: 2 });
    guard.record(10, 0.001);
    guard.record(10, 0.001);
    guard.record(10, 0.001);
    // requestCount = 3 > 2
    const results = guard.check();
    expect(results.some(r => r.decision === 'deny')).toBe(true);
    expect(results.some(r => r.explanation?.includes('Rate limit'))).toBe(true);
  });
});
