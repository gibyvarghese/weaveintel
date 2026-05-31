/**
 * MongoDB-backed WorkflowDefinitionStore.
 */
import type { Db } from 'mongodb';
import type { WorkflowDefinition } from '@weaveintel/core';
import type { WorkflowDefinitionStore } from './definition-store.js';

interface Doc {
  _id: string;
  name: string;
  payload: WorkflowDefinition;
  updatedAt: string;
}

export interface WeaveMongoDbDefinitionStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

export async function weaveMongoDbWorkflowDefinitionStore(
  opts: WeaveMongoDbDefinitionStoreOptions,
): Promise<WorkflowDefinitionStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_definitions');
  if (opts.ensureIndexes !== false) await col.createIndex({ name: 1 });

  return {
    async list() {
      const docs = await col.find({}).sort({ updatedAt: -1 }).toArray();
      return docs.map((d) => d.payload);
    },
    async get(idOrKey) {
      const byId = await col.findOne({ _id: idOrKey });
      if (byId) return byId.payload;
      const byName = await col.findOne({ name: idOrKey });
      return byName?.payload ?? null;
    },
    async save(def) {
      const now = new Date().toISOString();
      const saved: WorkflowDefinition = {
        ...def,
        updatedAt: now,
        createdAt: def.createdAt ?? now,
      };
      await col.replaceOne(
        { _id: saved.id },
        { name: saved.name, payload: saved, updatedAt: saved.updatedAt ?? now },
        { upsert: true },
      );
      return saved;
    },
    async delete(id) {
      await col.deleteOne({ _id: id });
    },
  };
}
