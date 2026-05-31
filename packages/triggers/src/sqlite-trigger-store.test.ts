/**
 * Contract tests for the SQLite-backed TriggerStore adapter.
 *
 * Postgres / MongoDB / Redis / DynamoDB adapters mirror the same shape and are
 * exercised at compile time + by app integration tests. A live test for those
 * stores requires running services; CI runs SQLite only.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';
import type { Trigger, TriggerInvocation } from './dispatcher.js';
import { weaveSqliteTriggerStore } from './index.js';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: newUUIDv7(),
    key: 'demo-trigger',
    enabled: true,
    source: { kind: 'manual', config: { foo: 1 } },
    target: { kind: 'workflow', config: { workflowId: 'wf-1' } },
    filter: { expression: { '==': [{ var: 'payload.kind' }, 'x'] } },
    inputMap: { foo: 'payload.foo' },
    rateLimit: { perMinute: 10 },
    metadata: { owner: 'alice' },
    ...overrides,
  } as Trigger;
}

function makeInvocation(triggerId: string, overrides: Partial<TriggerInvocation> = {}): TriggerInvocation {
  return {
    id: newUUIDv7(),
    triggerId,
    firedAt: Date.now(),
    sourceKind: 'manual',
    status: 'dispatched',
    targetRef: 'wf:run:abc',
    sourceEvent: { payload: { foo: 1 } },
    ...overrides,
  } as TriggerInvocation;
}

describe('weaveSqliteTriggerStore', () => {
  it('saves and retrieves triggers with all JSON fields intact', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t = makeTrigger();
    await store.save(t);
    const got = await store.get(t.id);
    expect(got).not.toBeNull();
    expect(got?.id).toBe(t.id);
    expect(got?.key).toBe('demo-trigger');
    expect(got?.enabled).toBe(true);
    expect(got?.source).toEqual(t.source);
    expect(got?.target).toEqual(t.target);
    expect(got?.filter).toEqual(t.filter);
    expect(got?.inputMap).toEqual(t.inputMap);
    expect(got?.rateLimit).toEqual({ perMinute: 10 });
    expect(got?.metadata).toEqual({ owner: 'alice' });
  });

  it('looks up by key', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t = makeTrigger({ key: 'lookup-me' });
    await store.save(t);
    const got = await store.getByKey('lookup-me');
    expect(got?.id).toBe(t.id);
    expect(await store.getByKey('missing')).toBeNull();
  });

  it('upserts on save (id collision)', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t = makeTrigger();
    await store.save(t);
    await store.save({ ...t, enabled: false, metadata: { owner: 'bob' } });
    const got = await store.get(t.id);
    expect(got?.enabled).toBe(false);
    expect(got?.metadata).toEqual({ owner: 'bob' });
  });

  it('lists triggers and deletes by id', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t1 = makeTrigger({ key: 'a' });
    const t2 = makeTrigger({ key: 'b' });
    await store.save(t1);
    await store.save(t2);
    expect((await store.list()).map((t) => t.key).sort()).toEqual(['a', 'b']);
    await store.delete(t1.id);
    expect(await store.get(t1.id)).toBeNull();
    expect((await store.list()).length).toBe(1);
  });

  it('records and lists invocations with filters', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t1 = makeTrigger({ key: 'k1' });
    const t2 = makeTrigger({ key: 'k2' });
    await store.save(t1);
    await store.save(t2);
    const base = Date.now();
    const i1 = makeInvocation(t1.id, { firedAt: base + 10, status: 'dispatched' });
    const i2 = makeInvocation(t1.id, { firedAt: base + 20, status: 'filtered' });
    const i3 = makeInvocation(t2.id, { firedAt: base + 30, status: 'dispatched' });
    await store.recordInvocation(i1);
    await store.recordInvocation(i2);
    await store.recordInvocation(i3);

    const all = await store.listInvocations();
    expect(all.length).toBe(3);
    // ordered desc by firedAt
    expect(all[0]!.id).toBe(i3.id);

    const t1Only = await store.listInvocations({ triggerId: t1.id });
    expect(t1Only.map((x) => x.id)).toEqual([i2.id, i1.id]);

    const dispatchedOnly = await store.listInvocations({ status: 'dispatched' });
    expect(dispatchedOnly.map((x) => x.id)).toEqual([i3.id, i1.id]);

    const t1Dispatched = await store.listInvocations({ triggerId: t1.id, status: 'dispatched' });
    expect(t1Dispatched.map((x) => x.id)).toEqual([i1.id]);

    const paged = await store.listInvocations({ limit: 1, offset: 1 });
    expect(paged.length).toBe(1);
    expect(paged[0]!.id).toBe(i2.id);

    // firedAt round-trips as number
    expect(typeof all[0]!.firedAt).toBe('number');
    // sourceEvent JSON round-trips
    expect(all[0]!.sourceEvent).toEqual({ payload: { foo: 1 } });
  });

  it('auto-assigns invocation id when omitted', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteTriggerStore({ database: db });
    const t = makeTrigger();
    await store.save(t);
    const inv = makeInvocation(t.id);
    // simulate caller forgetting id by blanking it
    await store.recordInvocation({ ...inv, id: '' });
    const list = await store.listInvocations();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBeTruthy();
    expect(list[0]!.id.length).toBeGreaterThan(10);
  });
});
