import { describe, it, expect } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { createInMemoryTemporalStore, createTimeTools } from './index.js';

function getTool(name: string) {
  const tools = createTimeTools({ defaultTimezone: 'UTC', store: createInMemoryTemporalStore() });
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return { tool, tools };
}

describe('@weaveintel/tools-time', () => {
  it('runs timer lifecycle end-to-end', async () => {
    const store = createInMemoryTemporalStore();
    const tools = createTimeTools({ defaultTimezone: 'UTC', store });
    const byName = new Map(tools.map((t) => [t.schema.name, t]));
    const ctx = weaveContext({ userId: 'u1', metadata: { chatId: 'c1' } });

    const start = await byName.get('timer_start')!.invoke(ctx, { name: 'timer_start', arguments: { label: 'tea', durationMs: 120000 } });
    const started = JSON.parse(start.content) as { id: string; state: string; durationMs: number };
    expect(started.state).toBe('running');

    const pause = await byName.get('timer_pause')!.invoke(ctx, { name: 'timer_pause', arguments: { timerId: started.id } });
    const paused = JSON.parse(pause.content) as { state: string; elapsedMs: number };
    expect(paused.state).toBe('paused');
    expect(paused.elapsedMs).toBeGreaterThanOrEqual(0);

    const resume = await byName.get('timer_resume')!.invoke(ctx, { name: 'timer_resume', arguments: { timerId: started.id } });
    const resumed = JSON.parse(resume.content) as { state: string };
    expect(resumed.state).toBe('running');

    const stop = await byName.get('timer_stop')!.invoke(ctx, { name: 'timer_stop', arguments: { timerId: started.id } });
    const stopped = JSON.parse(stop.content) as { state: string };
    expect(stopped.state).toBe('stopped');

    const list = await byName.get('timer_list')!.invoke(ctx, { name: 'timer_list', arguments: {} });
    const listed = JSON.parse(list.content) as { count: number };
    expect(listed.count).toBeGreaterThanOrEqual(1);
  });

  it('runs reminder lifecycle end-to-end', async () => {
    const store = createInMemoryTemporalStore();
    const tools = createTimeTools({ defaultTimezone: 'UTC', store });
    const byName = new Map(tools.map((t) => [t.schema.name, t]));
    const ctx = weaveContext({ userId: 'u2', metadata: { chatId: 'c2' } });

    const dueAt = new Date(Date.now() + 60_000).toISOString();
    const createdResp = await byName.get('reminder_create')!.invoke(ctx, {
      name: 'reminder_create',
      arguments: { text: 'Stand up meeting', dueAt, timezone: 'Pacific/Auckland' },
    });
    const created = JSON.parse(createdResp.content) as { id: string; status: string; timezone: string };
    expect(created.status).toBe('scheduled');
    expect(created.timezone).toBe('Pacific/Auckland');

    const listedResp = await byName.get('reminder_list')!.invoke(ctx, { name: 'reminder_list', arguments: {} });
    const listed = JSON.parse(listedResp.content) as { count: number };
    expect(listed.count).toBe(1);

    const cancelledResp = await byName.get('reminder_cancel')!.invoke(ctx, {
      name: 'reminder_cancel',
      arguments: { reminderId: created.id },
    });
    const cancelled = JSON.parse(cancelledResp.content) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });

  it('returns timezone snapshot', async () => {
    const { tool } = getTool('timezone_info');
    const ctx = weaveContext({ userId: 'u3', metadata: { chatId: 'c3' } });
    const result = await tool.invoke(ctx, { name: 'timezone_info', arguments: { timezone: 'UTC' } });
    const parsed = JSON.parse(result.content) as { timezone: string; nowIso: string };
    expect(parsed.timezone).toBe('UTC');
    expect(parsed.nowIso).toBeTruthy();
  });
});
