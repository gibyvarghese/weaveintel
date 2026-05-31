/**
 * Redis-backed WorkflowDefinitionStore.
 *
 * Layout:
 *   wf_def:<id>          STRING JSON payload
 *   wf_def:by_name:<n>   STRING id pointer
 *   wf_def:all           ZSET   member=id score=updatedAt_ms (for list ordered)
 */
import type { RedisClientType } from 'redis';
import type { WorkflowDefinition } from '@weaveintel/core';
import type { WorkflowDefinitionStore } from './definition-store.js';

export interface WeaveRedisDefinitionStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisWorkflowDefinitionStore(
  opts: WeaveRedisDefinitionStoreOptions,
): WorkflowDefinitionStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_def';
  const defKey = (id: string) => `${prefix}:${id}`;
  const nameKey = (n: string) => `${prefix}:by_name:${n}`;
  const allKey = `${prefix}:all`;

  return {
    async list() {
      const ids = await c.zRange(allKey, 0, -1, { REV: true });
      const out: WorkflowDefinition[] = [];
      for (const id of ids) {
        const raw = await c.get(defKey(id));
        if (raw) out.push(JSON.parse(raw) as WorkflowDefinition);
      }
      return out;
    },
    async get(idOrKey) {
      let raw = await c.get(defKey(idOrKey));
      if (!raw) {
        const id = await c.get(nameKey(idOrKey));
        if (id) raw = await c.get(defKey(id));
      }
      return raw ? (JSON.parse(raw) as WorkflowDefinition) : null;
    },
    async save(def) {
      const now = new Date().toISOString();
      const saved: WorkflowDefinition = {
        ...def,
        updatedAt: now,
        createdAt: def.createdAt ?? now,
      };
      const existingRaw = await c.get(defKey(saved.id));
      if (existingRaw) {
        const prev = JSON.parse(existingRaw) as WorkflowDefinition;
        if (prev.name && prev.name !== saved.name) await c.del(nameKey(prev.name));
      }
      await c.set(defKey(saved.id), JSON.stringify(saved));
      await c.set(nameKey(saved.name), saved.id);
      await c.zAdd(allKey, { score: Date.parse(saved.updatedAt!), value: saved.id });
      return saved;
    },
    async delete(id) {
      const raw = await c.get(defKey(id));
      if (raw) {
        const def = JSON.parse(raw) as WorkflowDefinition;
        if (def.name) await c.del(nameKey(def.name));
      }
      await c.del(defKey(id));
      await c.zRem(allKey, id);
    },
  };
}
