/**
 * @weaveintel/human-tasks — durable runtime-backed repository.
 *
 * `InMemoryHumanTaskRepository` discards every pending approval on restart.
 * `createDurableHumanTaskRepository({runtime?, namespace?})` persists tasks
 * via `runtime.persistence.kv` so approvals survive restarts.
 */
import type { HumanTask, HumanTaskFilter } from '@weaveintel/core';
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { HumanTaskRepository } from './repository.js';

export interface DurableHumanTaskRepositoryOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

export function createDurableHumanTaskRepository(
  opts: DurableHumanTaskRepositoryOptions = {},
): HumanTaskRepository {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'human-tasks';

  async function loadAll(): Promise<HumanTask[]> {
    const entries = await kv.list(`${ns}:`);
    const out: HumanTask[] = [];
    for (const e of entries) {
      try { out.push(JSON.parse(e.value) as HumanTask); } catch { /* skip */ }
    }
    return out;
  }

  return {
    async save(task) {
      await kv.set(`${ns}:${task.id}`, JSON.stringify(task));
    },
    async get(taskId) {
      const v = await kv.get(`${ns}:${taskId}`);
      if (!v) return null;
      try { return JSON.parse(v) as HumanTask; } catch { return null; }
    },
    async list(filter?: HumanTaskFilter) {
      let rows = await loadAll();
      if (filter) {
        if (filter.status?.length) rows = rows.filter((t) => filter.status!.includes(t.status));
        if (filter.type?.length) rows = rows.filter((t) => filter.type!.includes(t.type));
        if (filter.assignee) rows = rows.filter((t) => t.assignee === filter.assignee);
        if (filter.priority?.length) rows = rows.filter((t) => filter.priority!.includes(t.priority));
        if (filter.workflowRunId) rows = rows.filter((t) => t.workflowRunId === filter.workflowRunId);
      }
      return rows;
    },
    async delete(taskId) { await kv.delete(`${ns}:${taskId}`); },
    async claimNextPending(assignee) {
      const all = await loadAll();
      const pending = all
        .filter((t) => t.status === 'pending')
        .sort((a, b) => {
          const pa = PRIORITY_ORDER.indexOf(a.priority);
          const pb = PRIORITY_ORDER.indexOf(b.priority);
          if (pa !== pb) return pa - pb;
          return a.createdAt.localeCompare(b.createdAt);
        });
      const best = pending[0];
      if (!best) return null;
      const claimed: HumanTask = { ...best, status: 'assigned', assignee };
      await kv.set(`${ns}:${claimed.id}`, JSON.stringify(claimed));
      return claimed;
    },
    async listByAssignee(principalId, filter) {
      // Delegate to list with assignee filter merged
      const merged: HumanTaskFilter = { ...(filter ?? {}), assignee: principalId };
      const rows = await this.list(merged);
      return rows;
    },
  };
}
