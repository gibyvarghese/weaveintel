/**
 * MongoDB-backed TriggerStore. Two collections: `triggers` + `trigger_invocations`.
 */
import type { Db } from 'mongodb';
import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerInvocation,
  TriggerStore,
  ListInvocationsFilter,
} from './dispatcher.js';

interface TriggerDoc extends Omit<Trigger, 'id'> {
  _id: string;
}
interface InvocationDoc extends Omit<TriggerInvocation, 'id'> {
  _id: string;
}

function docToTrigger(d: TriggerDoc): Trigger {
  const { _id, ...rest } = d;
  return { id: _id, ...rest } as Trigger;
}
function docToInvocation(d: InvocationDoc): TriggerInvocation {
  const { _id, ...rest } = d;
  return { id: _id, ...rest } as TriggerInvocation;
}

export interface WeaveMongoDbTriggerStoreOptions {
  db: Db;
  triggersCollection?: string;
  invocationsCollection?: string;
  ensureIndexes?: boolean;
}

export async function weaveMongoDbTriggerStore(
  opts: WeaveMongoDbTriggerStoreOptions,
): Promise<TriggerStore> {
  const triggers = opts.db.collection<TriggerDoc>(opts.triggersCollection ?? 'triggers');
  const invocations = opts.db.collection<InvocationDoc>(
    opts.invocationsCollection ?? 'trigger_invocations',
  );
  if (opts.ensureIndexes !== false) {
    await triggers.createIndex({ key: 1 }, { unique: true });
    await invocations.createIndex({ triggerId: 1, firedAt: -1, _id: -1 });
    await invocations.createIndex({ status: 1, firedAt: -1, _id: -1 });
  }

  return {
    async list() {
      const docs = await triggers.find().sort({ key: 1 }).toArray();
      return docs.map(docToTrigger);
    },
    async get(id) {
      const d = await triggers.findOne({ _id: id });
      return d ? docToTrigger(d) : null;
    },
    async getByKey(key) {
      const d = await triggers.findOne({ key });
      return d ? docToTrigger(d) : null;
    },
    async save(t) {
      const { id, ...rest } = t;
      // _id only in filter — never in body
      await triggers.replaceOne({ _id: id }, rest as TriggerDoc, { upsert: true });
    },
    async delete(id) {
      await triggers.deleteOne({ _id: id });
    },
    async recordInvocation(inv) {
      const id = inv.id || newUUIDv7();
      const { id: _drop, ...rest } = inv;
      void _drop;
      await invocations.insertOne({ _id: id, ...rest } as InvocationDoc);
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const q: Record<string, unknown> = {};
      if (filter.triggerId) q['triggerId'] = filter.triggerId;
      if (filter.status) q['status'] = filter.status;
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      const docs = await invocations
        .find(q)
        .sort({ firedAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      return docs.map(docToInvocation);
    },
  };
}
