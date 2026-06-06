/**
 * @weaveintel/guardrails — escalation.test.ts  (W4)
 */
import { describe, it, expect, vi } from 'vitest';
import type { GuardrailResult } from '@weaveintel/core';
import { evaluateEscalation, type EscalationContext } from './escalation.js';
import type { EscalationPolicy } from '@weaveintel/core';

const makeResult = (decision: 'allow' | 'warn' | 'deny', category = 'cognitive'): GuardrailResult => ({
  decision,
  guardrailId: 'g1',
  metadata: { category },
});

const makePolicy = (overrides: Partial<EscalationPolicy> = {}): EscalationPolicy => ({
  id: 'pol-1',
  name: 'Two cognitive warns',
  description: 'Block after 2 cognitive warns',
  enabled: true,
  trigger: { minWarnCount: 2, categories: ['cognitive'] },
  onEscalate: 'block',
  ...overrides,
});

describe('evaluateEscalation', () => {
  it('does not escalate when warn count is below threshold', async () => {
    const results = [makeResult('warn'), makeResult('allow')];
    const ctx: EscalationContext = { results };
    const esc = await evaluateEscalation(results, [makePolicy()], ctx);
    expect(esc.escalated).toBe(false);
    expect(esc.decision).toBe('allow');
  });

  it('escalates when warn count meets threshold', async () => {
    const results = [makeResult('warn'), makeResult('warn'), makeResult('allow')];
    const ctx: EscalationContext = { results };
    const esc = await evaluateEscalation(results, [makePolicy()], ctx);
    expect(esc.escalated).toBe(true);
    expect(esc.decision).toBe('deny');
    expect(esc.policy?.id).toBe('pol-1');
  });

  it('only counts warns matching the configured categories', async () => {
    const results = [
      makeResult('warn', 'safety'), // different category
      makeResult('warn', 'safety'),
    ];
    const ctx: EscalationContext = { results };
    const esc = await evaluateEscalation(results, [makePolicy()], ctx); // policy wants 'cognitive'
    expect(esc.escalated).toBe(false);
  });

  it('escalates on matching risk level', async () => {
    const results: GuardrailResult[] = [{
      decision: 'warn',
      guardrailId: 'g2',
      metadata: { category: 'cognitive', riskLevel: 'critical' },
    }];
    const ctx: EscalationContext = { results };
    const policy = makePolicy({ trigger: { riskLevels: ['critical'] } });
    const esc = await evaluateEscalation(results, [policy], ctx);
    expect(esc.escalated).toBe(true);
  });

  it('skips disabled policies', async () => {
    const results = [makeResult('warn'), makeResult('warn')];
    const ctx: EscalationContext = { results };
    const policy = makePolicy({ enabled: false });
    const esc = await evaluateEscalation(results, [policy], ctx);
    expect(esc.escalated).toBe(false);
  });

  it('calls the handler when require-approval fires', async () => {
    const results = [makeResult('warn'), makeResult('warn')];
    const ctx: EscalationContext = { action: 'test-action', results };
    const policy = makePolicy({ onEscalate: 'require-approval' });
    const handler = vi.fn().mockResolvedValue({ taskId: 'task-123' });

    const esc = await evaluateEscalation(results, [policy], ctx, handler);
    expect(esc.escalated).toBe(true);
    expect(esc.taskId).toBe('task-123');
    expect(handler).toHaveBeenCalledWith(policy, ctx);
  });

  it('does not fail when handler throws', async () => {
    const results = [makeResult('warn'), makeResult('warn')];
    const ctx: EscalationContext = { results };
    const policy = makePolicy({ onEscalate: 'require-approval' });
    const handler = vi.fn().mockRejectedValue(new Error('task service unavailable'));

    const esc = await evaluateEscalation(results, [policy], ctx, handler);
    expect(esc.escalated).toBe(true);
    expect(esc.taskId).toBeUndefined(); // handler failed, taskId not set
  });
});
