/**
 * The scoped task store port: the in-memory reference runs the shared contract, and a bound store (one scope
 * fixed) plugs into the existing dispatcher and agent server, which know only `A2ATaskStore`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { A2ATask, ExecutionContext } from '@weaveintel/core';
import {
  createInMemoryScopedA2ATaskStore,
  bindA2ATaskScope,
  newA2ATaskId,
  type A2ATaskScope,
} from './task-store-scoped.js';
import { a2aScopedTaskStoreContract } from './scoped-task-store-contract.js';
import { createA2ADispatcher } from './a2a-server.js';
import { createInMemoryPushNotificationStore } from './push-notification-store.js';

a2aScopedTaskStoreContract(() => createInMemoryScopedA2ATaskStore(), {
  describe,
  it,
  beforeEach,
  expect,
});

function task(id = newA2ATaskId()): A2ATask {
  return {
    id,
    contextId: 'c',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2026-11-14T00:00:00.000Z' },
    artifacts: [],
    history: [],
  };
}

describe('[R-A2A2] newA2ATaskId', () => {
  it('is a random (v4) UUID, so the id carries no time and no sequence', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newA2ATaskId()));
    expect(ids.size).toBe(200);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('[R-A2A2] bindA2ATaskScope', () => {
  it('refuses to bind a scope with no tenant', () => {
    const store = createInMemoryScopedA2ATaskStore();
    expect(() => bindA2ATaskScope(store, { tenantId: '' })).toThrow(/tenant/);
    expect(() => bindA2ATaskScope(store, {} as A2ATaskScope)).toThrow(/tenant/);
  });

  it('gives each scope its own view of one shared store', async () => {
    const shared = createInMemoryScopedA2ATaskStore();
    const a = bindA2ATaskScope(shared, { tenantId: 'tenant-a', principalId: 'p1' });
    const b = bindA2ATaskScope(shared, { tenantId: 'tenant-b', principalId: 'p1' });
    const t1 = task();
    await a.save(t1);
    expect(await a.load(t1.id)).toEqual(t1);
    expect(await b.load(t1.id)).toBeNull();
    expect((await b.list()).tasks).toHaveLength(0);
  });

  it('copies the scope, so changing the object later does not widen the view', async () => {
    const shared = createInMemoryScopedA2ATaskStore();
    const scope = { tenantId: 'tenant-a', principalId: 'p1' };
    const bound = bindA2ATaskScope(shared, scope);
    const other = bindA2ATaskScope(shared, { tenantId: 'tenant-b', principalId: 'p1' });
    const t1 = task();
    await other.save(t1);
    scope.tenantId = 'tenant-b';
    expect(await bound.load(t1.id)).toBeNull();
  });

  it('answers GetTask from another tenant with "task not found" through the dispatcher', async () => {
    const shared = createInMemoryScopedA2ATaskStore();
    const t1 = task();
    await bindA2ATaskScope(shared, {
      tenantId: 'tenant-a',
      principalId: 'p1',
      clientId: 'c1',
    }).save(t1);

    const impl = {
      card: {
        name: 'x',
        description: 'x',
        version: '1',
        skills: [],
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: false,
          stateTransitionHistory: false,
        },
        supportedInterfaces: [
          {
            url: 'https://agent.example.com/a2a',
            protocolBinding: 'JSONRPC' as const,
            protocolVersion: '1.0',
          },
        ],
      },
      async handleMessage(): Promise<A2ATask> {
        return t1;
      },
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: t1.id },
    });
    const ctx = { executionId: 'e' } as ExecutionContext;

    const forB = createA2ADispatcher(
      impl,
      bindA2ATaskScope(shared, { tenantId: 'tenant-b', principalId: 'p1', clientId: 'c1' }),
    );
    const resB = await forB(ctx, { method: 'POST', body, headers: {} });
    expect((resB as { data: { error?: { code: number } } }).data.error?.code).toBe(-32001);

    const forA = createA2ADispatcher(
      impl,
      bindA2ATaskScope(shared, { tenantId: 'tenant-a', principalId: 'p1', clientId: 'c1' }),
    );
    const resA = await forA(ctx, { method: 'POST', body, headers: {} });
    expect((resA as { data: { result?: { id: string } } }).data.result?.id).toBe(t1.id);

    // ListTasks through tenant B's view is empty.
    const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ListTasks', params: {} });
    const listB = await forB(ctx, { method: 'POST', body: listBody, headers: {} });
    expect((listB as { data: { result?: { tasks: unknown[] } } }).data.result?.tasks).toEqual([]);
  });

  it('does not show another tenant the push configs (and their tokens) of a task', async () => {
    const shared = createInMemoryScopedA2ATaskStore();
    const t1 = task();
    const scopeA = { tenantId: 'tenant-a', principalId: 'p1', clientId: 'c1' };
    await bindA2ATaskScope(shared, scopeA).save(t1);
    const pushStore = createInMemoryPushNotificationStore();
    const cfg = await pushStore.create(t1.id, {
      url: 'https://hooks.partner.example/p',
      token: 'secret-token',
    });

    const impl = {
      card: {
        name: 'x',
        description: 'x',
        version: '1',
        skills: [],
        capabilities: {
          streaming: false,
          pushNotifications: true,
          extendedAgentCard: false,
          stateTransitionHistory: false,
        },
        supportedInterfaces: [
          {
            url: 'https://agent.example.com/a2a',
            protocolBinding: 'JSONRPC' as const,
            protocolVersion: '1.0',
          },
        ],
      },
      async handleMessage(): Promise<A2ATask> {
        return t1;
      },
      async start(): Promise<void> {},
      async stop(): Promise<void> {},
    };
    const ctx = { executionId: 'e' } as ExecutionContext;
    const call = (scope: A2ATaskScope, method: string, params: unknown) =>
      createA2ADispatcher(
        impl,
        bindA2ATaskScope(shared, scope),
        pushStore,
      )(ctx, {
        method: 'POST',
        headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }) as Promise<{ data: { result?: unknown; error?: { code: number } } }>;

    const scopeB = { tenantId: 'tenant-b', principalId: 'p1', clientId: 'c1' };
    expect(
      (await call(scopeB, 'ListTaskPushNotificationConfigs', { taskId: t1.id })).data.error?.code,
    ).toBe(-32001);
    expect(
      (
        await call(scopeB, 'GetTaskPushNotificationConfig', {
          taskId: t1.id,
          pushConfigId: cfg.pushConfigId,
        })
      ).data.error?.code,
    ).toBe(-32001);
    expect(
      (
        await call(scopeB, 'DeleteTaskPushNotificationConfig', {
          taskId: t1.id,
          pushConfigId: cfg.pushConfigId,
        })
      ).data.error?.code,
    ).toBe(-32001);
    expect(await pushStore.list(t1.id)).toHaveLength(1);

    const own = await call(scopeA, 'ListTaskPushNotificationConfigs', { taskId: t1.id });
    expect((own.data.result as { configs: unknown[] }).configs).toHaveLength(1);
  });
});
