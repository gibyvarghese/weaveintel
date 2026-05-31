/**
 * Redis-backed WorkflowRunQueue.
 *
 * Layout:
 *   wf_q:wf:<workflowId>     ZSET  member=entryId score=composite(priority,queuedAt)
 *   wf_q:e:<entryId>         STRING JSON entry
 *
 * Composite score: high priority → low score (so ascending zRange returns highest priority first).
 * score = -priority * 1e13 + queuedAt_ms (priority dominates; older first within same priority).
 */
import type { RedisClientType } from 'redis';
import { newUUIDv7 } from '@weaveintel/core';
import type { RunQueueEntry, WorkflowRunQueue } from './run-queue.js';

export interface WeaveRedisRunQueueOptions {
  client: RedisClientType;
  prefix?: string;
}

function score(entry: Pick<RunQueueEntry, 'priority' | 'queuedAt'>): number {
  return -entry.priority * 1e13 + Date.parse(entry.queuedAt);
}

export function weaveRedisRunQueue(opts: WeaveRedisRunQueueOptions): WorkflowRunQueue {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_q';
  const wfKey = (id: string) => `${prefix}:wf:${id}`;
  const eKey = (id: string) => `${prefix}:e:${id}`;
  const allKey = `${prefix}:all`;

  async function loadEntry(id: string): Promise<RunQueueEntry | null> {
    const raw = await c.get(eKey(id));
    return raw ? (JSON.parse(raw) as RunQueueEntry) : null;
  }

  return {
    async enqueue(entry) {
      const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
      const s = score(full);
      await c.set(eKey(full.id), JSON.stringify(full));
      await c.zAdd(wfKey(full.workflowId), { score: s, value: full.id });
      await c.zAdd(allKey, { score: s, value: full.id });
      return full;
    },
    async dequeue(workflowId) {
      const ids = await c.zRange(wfKey(workflowId), 0, 0);
      if (!ids.length) return null;
      const id = ids[0]!;
      const entry = await loadEntry(id);
      await c.zRem(wfKey(workflowId), id);
      await c.zRem(allKey, id);
      await c.del(eKey(id));
      return entry;
    },
    async remove(entryId) {
      const entry = await loadEntry(entryId);
      if (entry) {
        await c.zRem(wfKey(entry.workflowId), entryId);
      }
      await c.zRem(allKey, entryId);
      await c.del(eKey(entryId));
    },
    async size() {
      return c.zCard(allKey);
    },
    async sizeFor(workflowId) {
      return c.zCard(wfKey(workflowId));
    },
    async listFor(workflowId) {
      const ids = await c.zRange(wfKey(workflowId), 0, -1);
      const out: RunQueueEntry[] = [];
      for (const id of ids) {
        const e = await loadEntry(id);
        if (e) out.push(e);
      }
      return out;
    },
    async listAll() {
      const ids = await c.zRange(allKey, 0, -1);
      const out: RunQueueEntry[] = [];
      for (const id of ids) {
        const e = await loadEntry(id);
        if (e) out.push(e);
      }
      return out;
    },
  };
}
