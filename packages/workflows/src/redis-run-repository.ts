/**
 * Redis-backed WorkflowRunRepository.
 *
 * Layout:
 *   wf_run:<id>                    STRING JSON payload
 *   wf_run:by_wf:<wfId>            ZSET   member=id score=startedAt_ms
 *   wf_run:by_parent:<parentId>    ZSET   member=id score=startedAt_ms
 *   wf_run:active:<wfId>           SET    members=ids with status running|paused
 *   wf_run:all                     ZSET   member=id score=startedAt_ms
 */
import type { RedisClientType } from 'redis';
import type { WorkflowRun } from '@weaveintel/core';
import type { RunFilterOpts, WorkflowRunRepository } from './run-repository.js';

export interface WeaveRedisRunRepositoryOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisWorkflowRunRepository(
  opts: WeaveRedisRunRepositoryOptions,
): WorkflowRunRepository {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_run';
  const runKey = (id: string) => `${prefix}:${id}`;
  const byWf = (wf: string) => `${prefix}:by_wf:${wf}`;
  const byParent = (p: string) => `${prefix}:by_parent:${p}`;
  const active = (wf: string) => `${prefix}:active:${wf}`;
  const allKey = `${prefix}:all`;

  function isActive(s: WorkflowRun['status']): boolean {
    return s === 'running' || s === 'paused';
  }

  async function loadMany(ids: string[]): Promise<WorkflowRun[]> {
    if (!ids.length) return [];
    const raws = await c.mGet(ids.map(runKey));
    const out: WorkflowRun[] = [];
    for (const raw of raws) if (raw) out.push(JSON.parse(raw) as WorkflowRun);
    return out;
  }

  return {
    async save(run) {
      const score = Date.parse(run.startedAt);
      const existingRaw = await c.get(runKey(run.id));
      if (existingRaw) {
        const prev = JSON.parse(existingRaw) as WorkflowRun;
        if (prev.parentRunId && prev.parentRunId !== run.parentRunId) {
          await c.zRem(byParent(prev.parentRunId), run.id);
        }
        if (isActive(prev.status) && !isActive(run.status)) {
          await c.sRem(active(prev.workflowId), run.id);
        }
      }
      await c.set(runKey(run.id), JSON.stringify(run));
      await c.zAdd(byWf(run.workflowId), { score, value: run.id });
      await c.zAdd(allKey, { score, value: run.id });
      if (run.parentRunId) await c.zAdd(byParent(run.parentRunId), { score, value: run.id });
      if (isActive(run.status)) await c.sAdd(active(run.workflowId), run.id);
      else await c.sRem(active(run.workflowId), run.id);
    },
    async get(runId) {
      const raw = await c.get(runKey(runId));
      return raw ? (JSON.parse(raw) as WorkflowRun) : null;
    },
    async list(workflowId) {
      const ids = workflowId
        ? await c.zRange(byWf(workflowId), 0, -1, { REV: true })
        : await c.zRange(allKey, 0, -1, { REV: true });
      return loadMany(ids);
    },
    async listByParent(parentRunId) {
      const ids = await c.zRange(byParent(parentRunId), 0, -1, { REV: true });
      return loadMany(ids);
    },
    async listFiltered(opts: RunFilterOpts) {
      const ids = opts.workflowId
        ? await c.zRange(byWf(opts.workflowId), 0, -1, { REV: true })
        : await c.zRange(allKey, 0, -1, { REV: true });
      let runs = await loadMany(ids);
      if (opts.status) runs = runs.filter((r) => r.status === opts.status);
      if (opts.tenantId) runs = runs.filter((r) => r.tenantId === opts.tenantId);
      if (opts.before) runs = runs.filter((r) => r.startedAt < opts.before!);
      if (opts.after) runs = runs.filter((r) => r.startedAt > opts.after!);
      if (opts.limit) runs = runs.slice(0, opts.limit);
      return runs;
    },
    async countActive(workflowId) {
      return c.sCard(active(workflowId));
    },
    async delete(runId) {
      const raw = await c.get(runKey(runId));
      if (raw) {
        const run = JSON.parse(raw) as WorkflowRun;
        await c.zRem(byWf(run.workflowId), runId);
        if (run.parentRunId) await c.zRem(byParent(run.parentRunId), runId);
        await c.sRem(active(run.workflowId), runId);
      }
      await c.del(runKey(runId));
      await c.zRem(allKey, runId);
    },
  };
}
