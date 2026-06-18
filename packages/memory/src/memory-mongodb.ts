/** MongoDB-backed durable memory store. */

import type { MemoryEntry } from '@weaveintel/core';
import { MongoClient } from 'mongodb';
import { type DurableMemoryStore, type StoredMemoryDocument, applyMemoryQuery } from './memory-internal.js';

export function weaveMongoDbMemoryStore(opts: {
  url: string;
  databaseName?: string;
  collectionName?: string;
}): DurableMemoryStore {
  const client = new MongoClient(opts.url);
  const databaseName = opts.databaseName ?? 'weave_memory';
  const collectionName = opts.collectionName ?? 'memory_entries';
  let connected = false;

  async function collection() {
    if (!connected) {
      await client.connect();
      connected = true;
    }
    return client.db(databaseName).collection<StoredMemoryDocument>(collectionName);
  }

  return {
    async write(_ctx, entries): Promise<void> {
      const col = await collection();
      for (const entry of entries) {
        await col.updateOne(
          { _id: entry.id },
          { $set: { ...entry, _id: entry.id, updatedAt: new Date() } },
          { upsert: true },
        );
      }
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      const col = await collection();
      const rows = await col.find().sort({ updatedAt: 1 }).toArray();
      return applyMemoryQuery(rows.map((row) => ({
        id: row._id,
        type: row.type,
        content: row.content,
        metadata: row.metadata,
        embedding: row.embedding,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        tenantId: row.tenantId,
        userId: row.userId,
        sessionId: row.sessionId,
      })), options);
    },
    async delete(_ctx, ids): Promise<void> {
      if (ids.length === 0) return;
      const col = await collection();
      await col.deleteMany({ _id: { $in: ids } });
    },
    async clear(_ctx, filter): Promise<void> {
      // L-25: server-side filtered deleteMany — build a MongoDB query object
      // from the MemoryFilter so no documents are loaded into memory.
      const col = await collection();
      const query: Record<string, unknown> = {};
      if (filter?.tenantId)      query['tenantId'] = filter.tenantId;
      if (filter?.userId)        query['userId'] = filter.userId;
      if (filter?.sessionId)     query['sessionId'] = filter.sessionId;
      if (filter?.types?.length) query['type'] = { $in: filter.types };
      if (filter?.after || filter?.before) {
        const range: Record<string, string> = {};
        if (filter?.after)  range['$gt'] = filter.after;
        if (filter?.before) range['$lt'] = filter.before;
        query['createdAt'] = range;
      }
      await col.deleteMany(query);
    },
    async close(): Promise<void> {
      await client.close();
      connected = false;
    },
  };
}
