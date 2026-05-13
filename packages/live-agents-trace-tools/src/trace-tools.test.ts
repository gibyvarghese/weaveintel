import { describe, expect, it } from 'vitest';
import {
  createLiveTraceTools,
  type CostSoFarReader,
  type LiveRunEventLike,
  type LiveRunEventReader,
  type LiveRunStepLike,
  type LiveRunStepReader,
} from './index.js';

// ── Stubs ────────────────────────────────────────────────────────

function makeEvent(partial: Partial<LiveRunEventLike> & { id: string; run_id: string; kind: string }): LiveRunEventLike {
  return {
    step_id: null,
    agent_id: null,
    tool_key: null,
    summary: null,
    payload_json: null,
    created_at: new Date().toISOString(),
    ...partial,
  };
}

function makeStep(partial: Partial<LiveRunStepLike> & { id: string; run_id: string }): LiveRunStepLike {
  return {
    mesh_id: 'mesh-1',
    agent_id: null,
    role_key: 'worker',
    status: 'COMPLETED',
    started_at: null,
    completed_at: null,
    summary: null,
    payload_json: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

function makeEventReader(events: LiveRunEventLike[]): LiveRunEventReader {
  return {
    async listEvents({ runId, afterId, limit }) {
      let out = events.filter((e) => e.run_id === runId);
      if (afterId) {
        const idx = out.findIndex((e) => e.id === afterId);
        if (idx >= 0) out = out.slice(idx + 1);
      }
      if (limit && limit > 0) out = out.slice(-limit);
      return out;
    },
    async getEvent(id) {
      return events.find((e) => e.id === id) ?? null;
    },
  };
}

function makeStepReader(steps: LiveRunStepLike[]): LiveRunStepReader {
  return {
    async listSteps({ runId }) {
      return steps.filter((s) => s.run_id === runId);
    },
    async getStep(id) {
      return steps.find((s) => s.id === id) ?? null;
    },
  };
}

const ctx = { tenantId: 't1', userId: 'u1', traceId: 'tr1' } as const;

async function callTool(reg: ReturnType<typeof createLiveTraceTools>, name: string, args: Record<string, unknown>) {
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  // ExecutionContext shape — minimal for these read-only tools.
  const result = await tool.invoke(ctx as never, { name, arguments: args });
  return JSON.parse(result.content);
}

// ── Tests ────────────────────────────────────────────────────────

describe('createLiveTraceTools — construction', () => {
  it('throws on missing runId', () => {
    expect(() =>
      createLiveTraceTools({
        runId: '',
        eventReader: makeEventReader([]),
      }),
    ).toThrow(/runId is required/);
  });

  it('registers 5 tools with read-only risk and configured tag prefix', () => {
    const reg = createLiveTraceTools({
      runId: 'run-1',
      eventReader: makeEventReader([]),
      tagPrefix: 'kaggle',
    });
    const names = reg.list().map((t) => t.schema.name);
    expect(names).toEqual([
      'live_get_run_timeline',
      'live_get_failed_attempts',
      'live_get_recent_events',
      'live_get_event_details',
      'live_get_step_artifact',
    ]);
    for (const t of reg.list()) {
      expect(t.schema.riskLevel).toBe('read-only');
      expect(t.schema.tags).toContain('kaggle');
      expect(t.schema.tags).toContain('trace');
    }
  });
});

describe('createLiveTraceTools — run isolation', () => {
  const events: LiveRunEventLike[] = [
    makeEvent({ id: 'e1', run_id: 'run-A', kind: 'tick.completed', summary: 'A1' }),
    makeEvent({ id: 'e2', run_id: 'run-B', kind: 'tick.completed', summary: 'B1' }),
    makeEvent({ id: 'e3', run_id: 'run-A', kind: 'tool.resolved', summary: 'A2' }),
  ];
  const reader = makeEventReader(events);

  it('listEvents returns only the closure run', async () => {
    const reg = createLiveTraceTools({ runId: 'run-A', eventReader: reader });
    const out = await callTool(reg, 'live_get_recent_events', {});
    expect(out.events).toHaveLength(2);
    expect(out.events.map((e: { id: string }) => e.id).sort()).toEqual(['e1', 'e3']);
  });

  it('getEvent refuses cross-run lookup with structured error', async () => {
    const reg = createLiveTraceTools({ runId: 'run-A', eventReader: reader });
    const out = await callTool(reg, 'live_get_event_details', { eventId: 'e2' });
    expect(out.error).toBe('event_not_in_current_run');
    expect(out.runId).toBe('run-A');
  });

  it('getEvent allows in-run lookup with full payload', async () => {
    const eventsWithPayload: LiveRunEventLike[] = [
      makeEvent({
        id: 'e1',
        run_id: 'run-A',
        kind: 'contract.changed',
        payload_json: JSON.stringify({ kind: 'finding', body: { ok: true } }),
      }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(eventsWithPayload),
    });
    const out = await callTool(reg, 'live_get_event_details', { eventId: 'e1' });
    expect(out.id).toBe('e1');
    expect(out.payload).toEqual({ kind: 'finding', body: { ok: true } });
  });

  it('returns missing-id error on unknown event', async () => {
    const reg = createLiveTraceTools({ runId: 'run-A', eventReader: reader });
    const out = await callTool(reg, 'live_get_event_details', { eventId: 'does-not-exist' });
    expect(out.error).toBe('event_not_in_current_run');
  });
});

describe('createLiveTraceTools — pagination + filters', () => {
  const events: LiveRunEventLike[] = Array.from({ length: 50 }, (_, i) =>
    makeEvent({
      id: `e${i}`,
      run_id: 'run-A',
      kind: i % 2 === 0 ? 'tool.resolved' : 'tick.completed',
      summary: `step ${i}`,
    }),
  );

  it('respects maxRowsPerCall cap', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(events),
      maxRowsPerCall: 5,
    });
    const out = await callTool(reg, 'live_get_recent_events', { limit: 9999 });
    expect(out.events).toHaveLength(5);
  });

  it('honours kind filter', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(events),
    });
    const out = await callTool(reg, 'live_get_recent_events', { kind: 'tool.resolved', limit: 10 });
    expect(out.events).toHaveLength(10);
    for (const e of out.events) expect(e.kind).toBe('tool.resolved');
  });

  it('uses afterId cursor', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(events.slice(0, 5)),
    });
    const out = await callTool(reg, 'live_get_recent_events', { afterId: 'e2', limit: 50 });
    expect(out.events.map((e: { id: string }) => e.id)).toEqual(['e3', 'e4']);
  });
});

describe('createLiveTraceTools — failed attempts', () => {
  const events: LiveRunEventLike[] = [
    makeEvent({ id: 'e1', run_id: 'run-A', kind: 'tick.completed' }),
    makeEvent({ id: 'e2', run_id: 'run-A', kind: 'tick.errored', summary: 'boom' }),
    makeEvent({ id: 'e3', run_id: 'run-A', kind: 'policy.decision', summary: 'allowed by default' }),
    makeEvent({ id: 'e4', run_id: 'run-A', kind: 'policy.decision', summary: 'DENY tool x' }),
  ];

  it('filters to only error-class events', async () => {
    const reg = createLiveTraceTools({ runId: 'run-A', eventReader: makeEventReader(events) });
    const out = await callTool(reg, 'live_get_failed_attempts', {});
    const ids = out.failures.map((f: { record: { id: string } }) => f.record.id).sort();
    expect(ids).toEqual(['e2', 'e4']);
  });

  it('includes failed steps when stepReader provided', async () => {
    const steps = [
      makeStep({ id: 's1', run_id: 'run-A', status: 'COMPLETED' }),
      makeStep({ id: 's2', run_id: 'run-A', status: 'FAILED', summary: 'kernel push failed' }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(events),
      stepReader: makeStepReader(steps),
    });
    const out = await callTool(reg, 'live_get_failed_attempts', {});
    expect(out.failedStepsCount).toBe(1);
    const stepRec = out.failures.find((f: { kind: string }) => f.kind === 'step');
    expect(stepRec.record.id).toBe('s2');
  });
});

describe('createLiveTraceTools — timeline + cost enrichment', () => {
  it('returns step artifacts when stepReader supplied', async () => {
    const steps = [
      makeStep({ id: 's1', run_id: 'run-A', role_key: 'planner', status: 'COMPLETED', summary: 'planned' }),
      makeStep({ id: 's2', run_id: 'run-A', role_key: 'worker', status: 'RUNNING' }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      stepReader: makeStepReader(steps),
    });
    const out = await callTool(reg, 'live_get_run_timeline', {});
    expect(out.totalSteps).toBe(2);
    expect(out.steps).toHaveLength(2);
    expect(out.costUsdSoFar).toBeUndefined();
  });

  it('honours statusFilter case-insensitively', async () => {
    const steps = [
      makeStep({ id: 's1', run_id: 'run-A', status: 'COMPLETED' }),
      makeStep({ id: 's2', run_id: 'run-A', status: 'FAILED' }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      stepReader: makeStepReader(steps),
    });
    const out = await callTool(reg, 'live_get_run_timeline', { statusFilter: 'failed' });
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0].id).toBe('s2');
  });

  it('falls back to events when stepReader omitted', async () => {
    const events = [
      makeEvent({ id: 'e1', run_id: 'run-A', kind: 'tick.started', summary: 'tick 1 start' }),
      makeEvent({ id: 'e2', run_id: 'run-A', kind: 'tick.completed', summary: 'tick 1 done' }),
      makeEvent({ id: 'e3', run_id: 'run-A', kind: 'tool.resolved', summary: 'irrelevant' }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader(events),
    });
    const out = await callTool(reg, 'live_get_run_timeline', {});
    expect(out.totalSteps).toBe(2);
    expect(out.steps.map((s: { id: string }) => s.id)).toEqual(['e1', 'e2']);
  });

  it('includes costUsdSoFar when costReader supplied', async () => {
    const costReader: CostSoFarReader = async (runId) => (runId === 'run-A' ? 0.42 : null);
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      costReader,
    });
    const out = await callTool(reg, 'live_get_run_timeline', {});
    expect(out.costUsdSoFar).toBe(0.42);
  });

  it('swallows costReader errors gracefully', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      costReader: async () => {
        throw new Error('ledger down');
      },
    });
    const out = await callTool(reg, 'live_get_run_timeline', {});
    expect(out.costUsdSoFar).toBeUndefined();
  });
});

describe('createLiveTraceTools — step artifact', () => {
  it('returns error when stepReader unavailable', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
    });
    const out = await callTool(reg, 'live_get_step_artifact', { stepId: 's1' });
    expect(out.error).toBe('step_reader_unavailable');
  });

  it('refuses cross-run step lookup', async () => {
    const steps = [
      makeStep({ id: 's1', run_id: 'run-A' }),
      makeStep({ id: 's2', run_id: 'run-B' }),
    ];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      stepReader: makeStepReader(steps),
    });
    const out = await callTool(reg, 'live_get_step_artifact', { stepId: 's2' });
    expect(out.error).toBe('step_not_in_current_run');
  });

  it('returns full artifact for in-run step', async () => {
    const steps = [makeStep({ id: 's1', run_id: 'run-A', summary: 'ok', payload_json: '{"k":"v"}' })];
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      stepReader: makeStepReader(steps),
    });
    const out = await callTool(reg, 'live_get_step_artifact', { stepId: 's1' });
    expect(out.id).toBe('s1');
    expect(out.summary).toBe('ok');
    expect(out.runId).toBe('run-A');
  });

  it('rejects empty stepId', async () => {
    const reg = createLiveTraceTools({
      runId: 'run-A',
      eventReader: makeEventReader([]),
      stepReader: makeStepReader([]),
    });
    const out = await callTool(reg, 'live_get_step_artifact', { stepId: '   ' });
    expect(out.error).toBe('stepId is required');
  });
});
