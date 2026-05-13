import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityId,
  ExecutionContext,
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ToolAuditEvent,
} from '@weaveintel/core';
import type { ToolAuditEmitter } from '@weaveintel/tools';
import type { EscalationRule, ModelCascadeConfig, ModelRef } from './policy.js';
import {
  RunCostStateTracker,
  decideCascadeModel,
  evaluateEscalationRule,
  weaveModelCascadeResolver,
  wrapAuditEmitterWithCascadeTracker,
  type ModelResolverLike,
} from './model-cascade.js';

function fakeModel(id: string): Model {
  const caps: ReadonlySet<CapabilityId> = new Set();
  const info: ModelInfo = { provider: 'openai', modelId: id, capabilities: caps };
  return {
    info,
    capabilities: caps,
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      return {
        id: 'r-' + id,
        content: id,
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: id,
      };
    },
  };
}

const cheap: ModelRef = { provider: 'openai', modelId: 'gpt-4o-mini' };
const expensive: ModelRef = { provider: 'openai', modelId: 'gpt-4o' };

describe('evaluateEscalationRule', () => {
  it('tool_call_failed_count fires at threshold', () => {
    const rule: EscalationRule = { kind: 'tool_call_failed_count', threshold: 2 };
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 1, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(false);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 2, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(true);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 5, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(true);
  });

  it('json_parse_failed_count defaults threshold=1', () => {
    const rule: EscalationRule = { kind: 'json_parse_failed_count' };
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(false);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 1, resolveCount: 0 })).toBe(true);
  });

  it('step_kind matches when current step is in list', () => {
    const rule: EscalationRule = { kind: 'step_kind', stepKinds: ['final_answer', 'submit'] };
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, currentStepKind: 'plan', resolveCount: 0 })).toBe(false);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, currentStepKind: 'submit', resolveCount: 0 })).toBe(true);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(false);
  });

  it('intel_score_below fires when score < threshold', () => {
    const rule: EscalationRule = { kind: 'intel_score_below', threshold: 0.5 };
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, intelScore: 0.6, resolveCount: 0 })).toBe(false);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, intelScore: 0.4, resolveCount: 0 })).toBe(true);
    expect(evaluateEscalationRule(rule, { toolCallFailedCount: 0, jsonParseFailedCount: 0, resolveCount: 0 })).toBe(false);
  });
});

describe('decideCascadeModel', () => {
  it('pass-through when config undefined', () => {
    expect(decideCascadeModel(undefined, null, {}).choice).toBe('pass-through');
  });

  it('pass-through when no cheap or expensive set', () => {
    expect(decideCascadeModel({ escalateOn: [{ kind: 'tool_call_failed_count', threshold: 1 }] }, null, {}).choice).toBe('pass-through');
  });

  it('returns cheap when no rules fire', () => {
    const cfg: ModelCascadeConfig = { cheap, expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 5 }] };
    const d = decideCascadeModel(cfg, { toolCallFailedCount: 1, jsonParseFailedCount: 0, resolveCount: 0 }, {});
    expect(d.choice).toBe('cheap');
    expect(d.modelRef).toEqual(cheap);
  });

  it('escalates to expensive when a rule fires', () => {
    const cfg: ModelCascadeConfig = { cheap, expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 2 }] };
    const d = decideCascadeModel(cfg, { toolCallFailedCount: 3, jsonParseFailedCount: 0, resolveCount: 0 }, {});
    expect(d.choice).toBe('expensive');
    expect(d.modelRef).toEqual(expensive);
    expect(d.triggerRule?.kind).toBe('tool_call_failed_count');
  });

  it('per-tick stepKind override beats tracker state', () => {
    const cfg: ModelCascadeConfig = { cheap, expensive, escalateOn: [{ kind: 'step_kind', stepKinds: ['submit'] }] };
    const d = decideCascadeModel(cfg, { toolCallFailedCount: 0, jsonParseFailedCount: 0, currentStepKind: 'plan', resolveCount: 0 }, { stepKind: 'submit' });
    expect(d.choice).toBe('expensive');
  });

  it('falls back to expensive when escalation fires but cheap unset', () => {
    const cfg: ModelCascadeConfig = { expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 1 }] };
    const d = decideCascadeModel(cfg, { toolCallFailedCount: 2, jsonParseFailedCount: 0, resolveCount: 0 }, {});
    expect(d.choice).toBe('expensive');
  });

  it('falls back to expensive when cheap unset and no rules fire', () => {
    const cfg: ModelCascadeConfig = { expensive };
    const d = decideCascadeModel(cfg, null, {});
    expect(d.choice).toBe('expensive');
  });
});

describe('RunCostStateTracker', () => {
  it('starts with empty state', () => {
    const t = new RunCostStateTracker();
    expect(t.get('r1')).toBeNull();
    expect(t.size()).toBe(0);
  });

  it('records tool failures (only when not ok)', () => {
    const t = new RunCostStateTracker();
    t.recordToolCall('r1', { ok: true });
    t.recordToolCall('r1', { ok: false });
    t.recordToolCall('r1', { ok: false });
    expect(t.get('r1')?.toolCallFailedCount).toBe(2);
  });

  it('records json parse failures', () => {
    const t = new RunCostStateTracker();
    t.recordJsonParse('r1', { ok: false });
    expect(t.get('r1')?.jsonParseFailedCount).toBe(1);
  });

  it('forget drops state', () => {
    const t = new RunCostStateTracker();
    t.recordToolCall('r1', { ok: false });
    t.forget('r1');
    expect(t.get('r1')).toBeNull();
  });

  it('TTL evicts stale entries', async () => {
    const t = new RunCostStateTracker({ ttlMs: 10 });
    t.recordToolCall('r1', { ok: false });
    expect(t.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    // Access triggers eviction.
    expect(t.get('r1')).toBeNull();
    expect(t.size()).toBe(0);
  });
});

describe('weaveModelCascadeResolver', () => {
  function baseResolver(model: Model): ModelResolverLike {
    return { resolve: () => model };
  }

  it('falls through when config returns null', async () => {
    const base = fakeModel('base-x');
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => null,
      loadModel: () => fakeModel('should-not-be-called'),
    });
    const m = await r.resolve({});
    expect(m?.info.modelId).toBe('base-x');
  });

  it('returns cheap when no rules fire', async () => {
    const base = fakeModel('base');
    const tracker = new RunCostStateTracker();
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap, expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 5 }] }),
      loadModel: (ref) => fakeModel(ref.modelId),
      tracker,
    });
    const m = await r.resolve({ runId: 'r1' });
    expect(m?.info.modelId).toBe('gpt-4o-mini');
  });

  it('escalates to expensive after enough tool failures', async () => {
    const base = fakeModel('base');
    const tracker = new RunCostStateTracker();
    tracker.recordToolCall('r1', { ok: false });
    tracker.recordToolCall('r1', { ok: false });
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap, expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 2 }] }),
      loadModel: (ref) => fakeModel(ref.modelId),
      tracker,
    });
    const m = await r.resolve({ runId: 'r1' });
    expect(m?.info.modelId).toBe('gpt-4o');
  });

  it('falls back to base when loadModel returns undefined', async () => {
    const base = fakeModel('base');
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap, expensive }),
      loadModel: () => undefined,
    });
    const m = await r.resolve({});
    expect(m?.info.modelId).toBe('base');
  });

  it('falls back to base when resolveConfig throws', async () => {
    const base = fakeModel('base');
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => { throw new Error('boom'); },
      loadModel: () => fakeModel('should-not'),
    });
    const m = await r.resolve({});
    expect(m?.info.modelId).toBe('base');
  });

  it('falls back to base when loadModel throws', async () => {
    const base = fakeModel('base');
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap }),
      loadModel: () => { throw new Error('boom'); },
    });
    const m = await r.resolve({});
    expect(m?.info.modelId).toBe('base');
  });

  it('logs escalation events', async () => {
    const base = fakeModel('base');
    const tracker = new RunCostStateTracker();
    tracker.recordToolCall('r1', { ok: false });
    tracker.recordToolCall('r1', { ok: false });
    const log = vi.fn();
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap, expensive, escalateOn: [{ kind: 'tool_call_failed_count', threshold: 2 }] }),
      loadModel: (ref) => fakeModel(ref.modelId),
      tracker,
      log,
    });
    await r.resolve({ runId: 'r1' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('escalate'));
  });

  it('increments resolveCount when runId+tracker present', async () => {
    const base = fakeModel('base');
    const tracker = new RunCostStateTracker();
    const r = weaveModelCascadeResolver({
      base: baseResolver(base),
      resolveConfig: () => ({ cheap }),
      loadModel: (ref) => fakeModel(ref.modelId),
      tracker,
    });
    await r.resolve({ runId: 'r1' });
    await r.resolve({ runId: 'r1' });
    expect(tracker.get('r1')?.resolveCount).toBe(2);
  });
});

describe('wrapAuditEmitterWithCascadeTracker', () => {
  function event(outcome: string): ToolAuditEvent {
    return {
      toolName: 't',
      outcome: outcome as ToolAuditEvent['outcome'],
      createdAt: new Date().toISOString(),
    };
  }

  it('forwards events to inner emitter', async () => {
    const inner: ToolAuditEmitter = { emit: vi.fn() };
    const tracker = new RunCostStateTracker();
    const wrapped = wrapAuditEmitterWithCascadeTracker(inner, tracker, {
      resolveRunId: () => 'r1',
    });
    await wrapped.emit(event('success'));
    expect(inner.emit).toHaveBeenCalledOnce();
  });

  it('increments tracker on error outcome', async () => {
    const inner: ToolAuditEmitter = { emit: vi.fn() };
    const tracker = new RunCostStateTracker();
    const wrapped = wrapAuditEmitterWithCascadeTracker(inner, tracker, {
      resolveRunId: () => 'r1',
    });
    await wrapped.emit(event('error'));
    expect(tracker.get('r1')?.toolCallFailedCount).toBe(1);
  });

  it('skips tracker update when resolveRunId returns null', async () => {
    const inner: ToolAuditEmitter = { emit: vi.fn() };
    const tracker = new RunCostStateTracker();
    const wrapped = wrapAuditEmitterWithCascadeTracker(inner, tracker, {
      resolveRunId: () => null,
    });
    await wrapped.emit(event('error'));
    expect(tracker.size()).toBe(0);
  });

  it('does not throw when inner emit fails', async () => {
    const inner: ToolAuditEmitter = { emit: vi.fn(async () => { throw new Error('db down'); }) };
    const tracker = new RunCostStateTracker();
    const wrapped = wrapAuditEmitterWithCascadeTracker(inner, tracker, {
      resolveRunId: () => 'r1',
    });
    await expect(wrapped.emit(event('error'))).resolves.toBeUndefined();
    // Tracker still updated despite inner failure.
    expect(tracker.get('r1')?.toolCallFailedCount).toBe(1);
  });

  it('respects custom failureOutcomes', async () => {
    const inner: ToolAuditEmitter = { emit: vi.fn() };
    const tracker = new RunCostStateTracker();
    const wrapped = wrapAuditEmitterWithCascadeTracker(inner, tracker, {
      resolveRunId: () => 'r1',
      failureOutcomes: ['error', 'timeout'],
    });
    await wrapped.emit(event('timeout'));
    await wrapped.emit(event('success'));
    expect(tracker.get('r1')?.toolCallFailedCount).toBe(1);
  });
});
