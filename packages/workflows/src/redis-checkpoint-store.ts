/**
 * Redis-backed CheckpointStore.
 *
 * Layout:
 *   wf_cp:cp:<id>            HASH  full checkpoint JSON payload
 *   wf_cp:run:<runId>        ZSET  member=cp_id score=createdAt_ms (for ORDER + latest + delete-by-run)
 */
import type { RedisClientType } from 'redis';
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

export interface WeaveRedisCheckpointStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisCheckpointStore(opts: WeaveRedisCheckpointStoreOptions): CheckpointStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_cp';
  const cpKey = (id: string) => `${prefix}:cp:${id}`;
  const runKey = (runId: string) => `${prefix}:run:${runId}`;

  async function loadById(id: string): Promise<WorkflowCheckpoint | null> {
    const raw = await c.get(cpKey(id));
    return raw ? (JSON.parse(raw) as WorkflowCheckpoint) : null;
  }

  return {
    async save(runId, stepId, state, workflowId) {
      const cp: WorkflowCheckpoint = {
        id: newUUIDv7(),
        runId,
        stepId,
        state: structuredClone(state),
        createdAt: new Date().toISOString(),
        ...(workflowId ? { workflowId } : {}),
      };
      const score = Date.parse(cp.createdAt);
      await c.set(cpKey(cp.id), JSON.stringify(cp));
      await c.zAdd(runKey(runId), { score, value: cp.id });
      return cp;
    },
    async load(checkpointId) {
      return loadById(checkpointId);
    },
    async latest(runId) {
      const ids = await c.zRange(runKey(runId), 0, 0, { REV: true });
      if (!ids.length) return null;
      return loadById(ids[0]!);
    },
    async list(runId) {
      const ids = await c.zRange(runKey(runId), 0, -1);
      const out: WorkflowCheckpoint[] = [];
      for (const id of ids) {
        const cp = await loadById(id);
        if (cp) out.push(cp);
      }
      return out;
    },
    async delete(runId) {
      const ids = await c.zRange(runKey(runId), 0, -1);
      if (ids.length) {
        await c.del(ids.map(cpKey));
      }
      await c.del(runKey(runId));
    },
  };
}
