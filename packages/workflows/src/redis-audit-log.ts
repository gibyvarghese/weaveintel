/**
 * Redis-backed WorkflowAuditLog. Append-only.
 *
 * Layout:
 *   wf_au:e:<id>            STRING JSON event
 *   wf_au:run:<runId>       ZSET member=id score=timestamp_ms
 *   wf_au:wf:<workflowId>   ZSET member=id score=timestamp_ms
 *   wf_au:all               ZSET member=id score=timestamp_ms
 */
import type { RedisClientType } from 'redis';
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

export interface WeaveRedisAuditLogOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisAuditLog(opts: WeaveRedisAuditLogOptions): WorkflowAuditLog {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_au';
  const eKey = (id: string) => `${prefix}:e:${id}`;
  const runKey = (runId: string) => `${prefix}:run:${runId}`;
  const wfKey = (wfId: string) => `${prefix}:wf:${wfId}`;
  const allKey = `${prefix}:all`;

  async function loadEvents(ids: readonly string[]): Promise<WorkflowAuditEvent[]> {
    const out: WorkflowAuditEvent[] = [];
    for (const id of ids) {
      const raw = await c.get(eKey(id));
      if (raw) out.push(JSON.parse(raw) as WorkflowAuditEvent);
    }
    return out;
  }

  return {
    async append(event) {
      const id = newUUIDv7();
      const full = { id, ...event } as WorkflowAuditEvent;
      const score = Date.parse(full.timestamp);
      await c.set(eKey(id), JSON.stringify(full));
      await c.zAdd(runKey(full.runId), { score, value: id });
      await c.zAdd(wfKey(full.workflowId), { score, value: id });
      await c.zAdd(allKey, { score, value: id });
    },
    async list(runId) {
      const ids = await c.zRange(runKey(runId), 0, -1);
      return loadEvents(ids);
    },
    async listAll(o) {
      const z = o?.workflowId ? wfKey(o.workflowId) : allKey;
      const ids = await c.zRange(z, 0, -1);
      const all = await loadEvents(ids);
      return o?.limit ? all.slice(-o.limit) : all;
    },
  };
}
