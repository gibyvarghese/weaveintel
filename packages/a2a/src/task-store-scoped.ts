/**
 * @weaveintel/a2a — the scoped task store port.
 *
 * A task belongs to a scope: the tenant it was created in, and (optionally) the principal it acts for and the
 * client it came through. Every method takes the scope, and a task is visible only to the scope that wrote it:
 * same tenant, same principal, same client (an absent principal or client is a value too, and matches only an
 * absent one). A task id from another scope is "not found", never "forbidden", so the answer reveals nothing.
 *
 * Bindings: `createInMemoryScopedA2ATaskStore()` (the reference, for tests and single-process use) and
 * `createPostgresA2ATaskStore()` (`task-store-postgres.ts`). Every binding passes
 * `a2aScopedTaskStoreContract` (`scoped-task-store-contract.ts`).
 *
 * The dispatcher and the agent server take the unscoped `A2ATaskStore`; `bindA2ATaskScope(store, scope)` gives
 * them one scope's view, built per request from the verified caller.
 *
 * Task ids should come from `newA2ATaskId()` (a random v4 UUID): isolation does not rest on the id being hard
 * to guess, but a random id gives nothing away either.
 */

import type { A2ATask, A2AListTasksFilter, A2ATaskPage } from '@weaveintel/core';
import type { A2ATaskStore, A2ATaskStorePatch } from './task-store.js';

/** Who a task belongs to. `tenantId` is required; the others narrow it. */
export interface A2ATaskScope {
  readonly tenantId: string;
  /** The person the task acts for (delegated), or the agent itself (autonomous). */
  readonly principalId?: string;
  /** The registered client the task came through. */
  readonly clientId?: string;
}

export interface A2AScopedTaskStore {
  /** Create, or overwrite a task the same scope owns. Refuses (as "not found") a task another principal or client owns. */
  save(scope: A2ATaskScope, task: A2ATask): Promise<void>;
  /** The task, or null when this scope holds no task with that id. */
  load(scope: A2ATaskScope, taskId: string): Promise<A2ATask | null>;
  /** This scope's tasks, newest status first. */
  list(scope: A2ATaskScope, filter?: A2AListTasksFilter): Promise<A2ATaskPage>;
  /** Replace status, artifacts or history; merge metadata. Throws "not found" when this scope holds no such task. */
  update(scope: A2ATaskScope, taskId: string, patch: A2ATaskStorePatch): Promise<A2ATask>;
  /** True when this scope held the task. */
  delete(scope: A2ATaskScope, taskId: string): Promise<boolean>;
}

export const A2A_TASK_ID_MAX_LENGTH = 200;
export const A2A_LIST_DEFAULT_PAGE_SIZE = 50;
export const A2A_LIST_MAX_PAGE_SIZE = 100;

/** A random (v4) UUID for a new task. */
export function newA2ATaskId(): string {
  return crypto.randomUUID();
}

/** A normalised copy of the scope; throws when it has no tenant. */
export function checkA2ATaskScope(
  scope: A2ATaskScope,
): Required<{ tenantId: string }> & { principalId: string | null; clientId: string | null } {
  const s = (scope ?? {}) as Partial<Record<keyof A2ATaskScope, unknown>>;
  if (typeof s.tenantId !== 'string' || s.tenantId.trim() === '') {
    throw new Error('A2A task store: a scope needs a tenant (tenantId is missing or empty)');
  }
  for (const f of ['principalId', 'clientId'] as const) {
    if (s[f] !== undefined && s[f] !== null && typeof s[f] !== 'string')
      throw new Error(`A2A task store: scope ${f} must be a string`);
  }
  return {
    tenantId: s.tenantId,
    principalId: typeof s.principalId === 'string' ? s.principalId : null,
    clientId: typeof s.clientId === 'string' ? s.clientId : null,
  };
}

export function checkA2ATaskId(id: unknown): string {
  if (typeof id !== 'string' || id === '' || id.length > A2A_TASK_ID_MAX_LENGTH) {
    throw new Error(
      `A2A task store: a task id must be a non-empty string of at most ${A2A_TASK_ID_MAX_LENGTH} characters`,
    );
  }
  return id;
}

/** Page size within [1, 100]; 50 when absent. */
export function a2aPageSize(filter?: A2AListTasksFilter): number {
  const n = filter?.pageSize;
  if (n === undefined || n === null || !Number.isFinite(n)) return A2A_LIST_DEFAULT_PAGE_SIZE;
  return Math.min(A2A_LIST_MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

/** The offset a page token stands for; throws on a token this store did not issue. */
export function a2aPageOffset(filter?: A2AListTasksFilter): number {
  const token = filter?.pageToken;
  if (token === undefined || token === null || token === '') return 0;
  if (typeof token !== 'string' || !/^\d{1,9}$/.test(token))
    throw new Error('A2A task store: invalid page token');
  return Number(token);
}

export function notFound(taskId: string): Error {
  return new Error(`A2A task store: task not found: ${taskId}`);
}

export function applyA2APatch(existing: A2ATask, patch: A2ATaskStorePatch): A2ATask {
  return {
    ...existing,
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.artifacts !== undefined && { artifacts: patch.artifacts }),
    ...(patch.history !== undefined && { history: patch.history }),
    ...(patch.metadata !== undefined && { metadata: { ...existing.metadata, ...patch.metadata } }),
  };
}

// ─── In-memory reference ─────────────────────────────────────────────────────

interface Held {
  readonly principalId: string | null;
  readonly clientId: string | null;
  task: A2ATask;
}

/** The in-memory reference binding. Tasks are deep-copied in and out, so callers cannot change stored state. */
export function createInMemoryScopedA2ATaskStore(): A2AScopedTaskStore {
  // tenant → (task id → held)
  const tenants = new Map<string, Map<string, Held>>();
  const copy = (t: A2ATask): A2ATask => structuredClone(t);

  function find(scope: A2ATaskScope, taskId: string): Held | undefined {
    const s = checkA2ATaskScope(scope);
    const held = tenants.get(s.tenantId)?.get(taskId);
    if (!held || held.principalId !== s.principalId || held.clientId !== s.clientId)
      return undefined;
    return held;
  }

  return {
    async save(scope, task) {
      const s = checkA2ATaskScope(scope);
      checkA2ATaskId(task?.id);
      let byId = tenants.get(s.tenantId);
      if (!byId) tenants.set(s.tenantId, (byId = new Map()));
      const held = byId.get(task.id);
      if (held && (held.principalId !== s.principalId || held.clientId !== s.clientId))
        throw notFound(task.id);
      byId.set(task.id, { principalId: s.principalId, clientId: s.clientId, task: copy(task) });
    },

    async load(scope, taskId) {
      const held = find(scope, taskId);
      return held ? copy(held.task) : null;
    },

    async list(scope, filter) {
      const s = checkA2ATaskScope(scope);
      const size = a2aPageSize(filter);
      const offset = a2aPageOffset(filter);
      let items = [...(tenants.get(s.tenantId)?.values() ?? [])]
        .filter((h) => h.principalId === s.principalId && h.clientId === s.clientId)
        .map((h) => h.task);
      if (filter?.contextId !== undefined)
        items = items.filter((t) => t.contextId === filter.contextId);
      if (filter?.state !== undefined) items = items.filter((t) => t.status.state === filter.state);
      if (filter?.statusTimestampAfter !== undefined)
        items = items.filter((t) => t.status.timestamp > filter.statusTimestampAfter!);
      items.sort((a, b) =>
        a.status.timestamp < b.status.timestamp
          ? 1
          : a.status.timestamp > b.status.timestamp
            ? -1
            : a.id < b.id
              ? 1
              : a.id > b.id
                ? -1
                : 0,
      );
      const page = items.slice(offset, offset + size);
      const next = offset + page.length;
      return {
        tasks: page.map(copy),
        ...(next < items.length ? { nextPageToken: String(next) } : {}),
        totalSize: items.length,
      };
    },

    async update(scope, taskId, patch) {
      const held = find(scope, taskId);
      if (!held) throw notFound(taskId);
      held.task = copy(applyA2APatch(held.task, patch));
      return copy(held.task);
    },

    async delete(scope, taskId) {
      const held = find(scope, taskId);
      if (!held) return false;
      tenants.get(checkA2ATaskScope(scope).tenantId)!.delete(taskId);
      return true;
    },
  };
}

// ─── One scope's view ────────────────────────────────────────────────────────

/**
 * One scope's view of a scoped store, as the unscoped `A2ATaskStore` the dispatcher and agent server take.
 * Throws when the scope has no tenant. The scope is copied, so changing the object afterwards changes nothing.
 * The view has no `subscribe` (SubscribeToTask answers "unsupported" through it).
 */
export function bindA2ATaskScope(store: A2AScopedTaskStore, scope: A2ATaskScope): A2ATaskStore {
  const s = checkA2ATaskScope(scope);
  const fixed: A2ATaskScope = Object.freeze({
    tenantId: s.tenantId,
    ...(s.principalId !== null ? { principalId: s.principalId } : {}),
    ...(s.clientId !== null ? { clientId: s.clientId } : {}),
  });
  return {
    save: (task) => store.save(fixed, task),
    load: (taskId) => store.load(fixed, taskId),
    list: (filter) => store.list(fixed, filter),
    update: (taskId, patch) => store.update(fixed, taskId, patch),
    delete: (taskId) => store.delete(fixed, taskId),
  };
}
