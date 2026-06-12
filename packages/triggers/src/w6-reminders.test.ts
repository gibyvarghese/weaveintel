/**
 * W6 — @weaveintel/triggers reminders ergonomics tests
 *
 * Covers:
 *  - createReminderTrigger: creates correct Trigger, stores ownerPrincipalId/tenantId/provenance
 *  - one-shot: fireAt stored in source.config, metadata.oneShot=true
 *  - recurring: rrule stored in source.config, metadata.oneShot=false
 *  - must provide fireAt or rrule (throws otherwise)
 *  - listByOwner: InMemoryTriggerStore + SQLite store
 *  - rescheduleReminder: updates fireAt, re-enables trigger
 *  - ReminderBusTargetAdapter: emits reminder.due, auto-disables one-shot
 */

import { describe, it, expect } from 'vitest';
import {
  createReminderTrigger,
  rescheduleReminder,
  ReminderBusTargetAdapter,
  InMemoryTriggerStore,
  weaveSqliteTriggerStore,
} from './index.js';
import type { Trigger } from './dispatcher.js';

// ---------------------------------------------------------------------------
// createReminderTrigger
// ---------------------------------------------------------------------------

describe('createReminderTrigger', () => {
  it('creates a trigger with reminder_bus target', () => {
    const t = createReminderTrigger({
      ownerPrincipalId: 'user-1',
      label: 'Daily standup',
      fireAt: '2025-12-01T09:00:00.000Z',
    });
    expect(t.target.kind).toBe('reminder_bus');
    expect(t.source.kind).toBe('cron');
    expect(t.ownerPrincipalId).toBe('user-1');
    expect(t.enabled).toBe(true);
  });

  it('stores fireAt in source.config and sets oneShot=true', () => {
    const t = createReminderTrigger({
      ownerPrincipalId: 'u1',
      label: 'One shot',
      fireAt: '2025-12-01T00:00:00.000Z',
    });
    expect(t.source.config['fireAt']).toBe('2025-12-01T00:00:00.000Z');
    expect(t.metadata?.['oneShot']).toBe(true);
  });

  it('stores rrule and sets oneShot=false', () => {
    const t = createReminderTrigger({
      ownerPrincipalId: 'u1',
      label: 'Daily',
      rrule: 'FREQ=DAILY;BYHOUR=9',
    });
    expect(t.source.config['rrule']).toBe('FREQ=DAILY;BYHOUR=9');
    expect(t.metadata?.['oneShot']).toBe(false);
  });

  it('stores tenantId and provenance', () => {
    const t = createReminderTrigger({
      ownerPrincipalId: 'u1',
      tenantId: 'tenant-a',
      label: 'Reminder',
      fireAt: '2025-12-01T00:00:00.000Z',
      provenance: { sourceRunId: 'run-42', sourceRef: 'step-1' },
    });
    expect(t.tenantId).toBe('tenant-a');
    expect(t.provenance?.sourceRunId).toBe('run-42');
  });

  it('throws when neither fireAt nor rrule provided', () => {
    expect(() => createReminderTrigger({ ownerPrincipalId: 'u1', label: 'X' })).toThrow('fireAt or rrule');
  });
});

// ---------------------------------------------------------------------------
// listByOwner — InMemoryTriggerStore
// ---------------------------------------------------------------------------

describe('InMemoryTriggerStore.listByOwner', () => {
  it('returns only triggers owned by the principal', async () => {
    const store = new InMemoryTriggerStore();
    const t1 = createReminderTrigger({ ownerPrincipalId: 'alice', label: 'R1', fireAt: '2025-01-01T00:00:00Z' });
    const t2 = createReminderTrigger({ ownerPrincipalId: 'bob', label: 'R2', fireAt: '2025-01-02T00:00:00Z' });
    const t3 = createReminderTrigger({ ownerPrincipalId: 'alice', label: 'R3', fireAt: '2025-01-03T00:00:00Z' });
    await store.save(t1); await store.save(t2); await store.save(t3);
    const results = await store.listByOwner('alice');
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.ownerPrincipalId === 'alice')).toBe(true);
  });

  it('returns empty when principal has no triggers', async () => {
    const store = new InMemoryTriggerStore();
    expect(await store.listByOwner('nobody')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listByOwner — SQLite store (round-trip)
// ---------------------------------------------------------------------------

describe('SQLite TriggerStore.listByOwner', () => {
  it('persists and lists by owner', async () => {
    const store = weaveSqliteTriggerStore({ databasePath: ':memory:' });
    const t = createReminderTrigger({
      ownerPrincipalId: 'user-sqlite',
      tenantId: 'tenant-1',
      label: 'Meeting',
      fireAt: '2025-06-01T10:00:00.000Z',
      provenance: { sourceRunId: 'run-1' },
    });
    await store.save(t);
    const results = await store.listByOwner('user-sqlite');
    expect(results).toHaveLength(1);
    expect(results[0]?.ownerPrincipalId).toBe('user-sqlite');
    expect(results[0]?.tenantId).toBe('tenant-1');
    expect(results[0]?.provenance?.sourceRunId).toBe('run-1');
  });
});

// ---------------------------------------------------------------------------
// rescheduleReminder
// ---------------------------------------------------------------------------

describe('rescheduleReminder', () => {
  it('updates fireAt and re-enables trigger', async () => {
    const store = new InMemoryTriggerStore();
    const t = createReminderTrigger({ ownerPrincipalId: 'u1', label: 'R', fireAt: '2025-01-01T00:00:00Z' });
    // Simulate auto-disabled after firing
    await store.save({ ...t, enabled: false });

    const newFireAt = '2025-06-01T00:00:00.000Z';
    const updated = await rescheduleReminder(t.id, newFireAt, store);
    expect(updated.source.config['fireAt']).toBe(newFireAt);
    expect(updated.enabled).toBe(true);
  });

  it('throws if trigger not found', async () => {
    const store = new InMemoryTriggerStore();
    await expect(rescheduleReminder('nonexistent', '2025-01-01T00:00:00Z', store)).rejects.toThrow('not found');
  });

  it('throws if trigger is not a reminder_bus target', async () => {
    const store = new InMemoryTriggerStore();
    const t: Trigger = {
      id: 'non-reminder', key: 'some:key', enabled: true,
      source: { kind: 'manual', config: {} },
      target: { kind: 'webhook_out', config: { url: 'https://example.com' } },
    };
    await store.save(t);
    await expect(rescheduleReminder(t.id, '2025-01-01T00:00:00Z', store)).rejects.toThrow('not a reminder_bus');
  });
});

// ---------------------------------------------------------------------------
// ReminderBusTargetAdapter
// ---------------------------------------------------------------------------

describe('ReminderBusTargetAdapter', () => {
  it('emits reminder.due event', async () => {
    const emitted: { type: string; data: Record<string, unknown> }[] = [];
    const bus = { emit: (e: { type: string; data: Record<string, unknown> }) => { emitted.push(e); } };
    const adapter = new ReminderBusTargetAdapter(bus);
    await adapter.dispatch(
      { kind: 'reminder_bus', config: { label: 'Standup' } },
      {},
      { triggerId: 'tid', triggerKey: 'reminder:u:standup:abc', firedAt: Date.now() },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('reminder.due');
    expect(emitted[0]?.data?.['label']).toBe('Standup');
  });

  it('auto-disables one-shot trigger after firing', async () => {
    const store = new InMemoryTriggerStore();
    const t = createReminderTrigger({ ownerPrincipalId: 'u1', label: 'Once', fireAt: '2025-01-01T00:00:00Z' });
    await store.save(t);
    const emitted: unknown[] = [];
    const bus = { emit: (e: unknown) => { emitted.push(e); } };
    const adapter = new ReminderBusTargetAdapter(bus as never, store);
    await adapter.dispatch(
      { kind: 'reminder_bus', config: { label: 'Once' } },
      {},
      { triggerId: t.id, triggerKey: t.key, firedAt: Date.now() },
    );
    const saved = await store.get(t.id);
    expect(saved?.enabled).toBe(false);
  });
});
