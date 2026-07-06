/**
 * @weaveintel/memory — In-memory implementations and store factory.
 *
 * Per-backend modules (each in their own file for tree-shaking / lazy loading):
 *   memory-postgres.ts    — weavePostgresMemoryStore
 *   memory-redis.ts       — weaveRedisMemoryStore
 *   memory-sqlite.ts      — weaveSqliteMemoryStore
 *   memory-mongodb.ts     — weaveMongoDbMemoryStore
 *   memory-cloudnosql.ts  — weaveCloudNoSqlMemoryStore (DynamoDB)
 *   memory-pgvector.ts    — weavePgVectorMemoryStore
 *
 * `createConfiguredMemoryStore` uses dynamic import() so only the selected
 * backend's driver package is loaded at runtime.
 */

import type {
  MemoryEntry,
  MemoryType,
  MemoryStore,
  MemoryQuery,
  MemoryFilter,
  ConversationMemory,
  SemanticMemory,
  EntityMemory,
  ExecutionContext,
  EmbeddingModel,
  AgentMemory,
  Message,
  WeaveRuntime,
} from '@weaveintel/core';
import { weaveInMemoryPersistence } from '@weaveintel/core';
import {
  type DurableMemoryStore,
  matchesFilter,
  applyMemoryQuery,
  sessionScopeFromContext,
} from './memory-internal.js';

// ── Per-backend imports for the synchronous factory ───────────────────────────
// These are static imports so createConfiguredMemoryStore() remains synchronous.
// Use createConfiguredMemoryStoreAsync() with dynamic import() for true lazy loading.
import { weavePostgresMemoryStore as _weavePostgresMemoryStore } from './memory-postgres.js';
import { weaveRedisMemoryStore as _weaveRedisMemoryStore } from './memory-redis.js';
import { weaveSqliteMemoryStore as _weaveSqliteMemoryStore } from './memory-sqlite.js';
import { weaveMongoDbMemoryStore as _weaveMongoDbMemoryStore } from './memory-mongodb.js';
import { weaveCloudNoSqlMemoryStore as _weaveCloudNoSqlMemoryStore } from './memory-cloudnosql.js';
import { weavePgVectorMemoryStore as _weavePgVectorMemoryStore } from './memory-pgvector.js';

// ── Re-export per-backend factories ──────────────────────────────────────────
// Backward-compatible named re-exports so callers continue to work unchanged.
export { weavePostgresMemoryStore, type PostgresMemoryStoreOptions } from './memory-postgres.js';
export { weaveRedisMemoryStore } from './memory-redis.js';
export { weaveSqliteMemoryStore } from './memory-sqlite.js';
export { weaveMongoDbMemoryStore } from './memory-mongodb.js';
export { weaveCloudNoSqlMemoryStore } from './memory-cloudnosql.js';
export { weavePgVectorMemoryStore, type PgVectorMemoryStoreOptions } from './memory-pgvector.js';

export type ConfiguredConversationMemory = AgentMemory & {
  getHistory(ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]>;
  close(): Promise<void>;
};

export interface ConfiguredMemoryStoreOptions {
  backend: 'in-memory' | 'runtime' | 'postgres' | 'pgvector' | 'redis' | 'sqlite' | 'mongodb' | 'cloud-nosql';
  /** Phase 4 — when `backend: 'runtime'`, entries are stored via
   *  `runtime.persistence.kv`. Falls back to in-memory when omitted. */
  runtime?: WeaveRuntime;
  /** Namespace prefix for KV keys when `backend: 'runtime'`. Defaults to `'mem'`. */
  runtimeNamespace?: string;
  postgresUrl?: string;
  redisUrl?: string;
  redisKeyPrefix?: string;
  sqlitePath?: string;
  mongoUrl?: string;
  mongoDatabaseName?: string;
  mongoCollectionName?: string;
  cloudNoSqlProvider?: 'dynamodb';
  dynamoDbEndpoint?: string;
  dynamoDbRegion?: string;
  dynamoDbTableName?: string;
  pgvectorUrl?: string;
  pgvectorDimensions?: number;
  pgvectorTableName?: string;
  pgvectorIndexType?: 'hnsw' | 'ivfflat' | 'none';
  pgvectorDistanceMetric?: 'cosine' | 'l2' | 'inner';
}

export interface RuntimeMemoryStoreOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

// ─── In-memory store ─────────────────────────────────────────

export function weaveMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();

  return {
    async write(_ctx: ExecutionContext, newEntries: MemoryEntry[]): Promise<void> {
      for (const entry of newEntries) {
        entries.set(entry.id, entry);
      }
    },

    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      return applyMemoryQuery([...entries.values()], options);
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      for (const id of ids) {
        entries.delete(id);
      }
    },

    async clear(_ctx: ExecutionContext, filter?: MemoryFilter): Promise<void> {
      if (!filter) {
        entries.clear();
        return;
      }
      for (const [id, entry] of entries) {
        if (matchesFilter(entry, filter)) {
          entries.delete(id);
        }
      }
    },
  };
}

// ─── Conversation memory ─────────────────────────────────────

export function weaveConversationMemory(opts?: {
  maxHistory?: number;
}): ConversationMemory & AgentMemory {
  const messages: Message[] = [];
  const maxHistory = opts?.maxHistory ?? 100;

  return {
    async addMessage(_ctx: ExecutionContext, msg: Message | string, content?: string, metadata?: Record<string, unknown>): Promise<void> {
      if (typeof msg === 'string') {
        messages.push({ role: msg as Message['role'], content: content! });
      } else {
        messages.push(msg);
      }
      while (messages.length > maxHistory) {
        messages.shift();
      }
    },

    async getMessages(_ctx: ExecutionContext, limit?: number): Promise<Message[]> {
      if (limit) return messages.slice(-limit);
      return [...messages];
    },

    async getHistory(_ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]> {
      const slice = limit ? messages.slice(-limit) : messages;
      return slice.map((m, i) => ({
        id: `msg_${i}`,
        type: 'conversation' as MemoryType,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        metadata: { role: m.role },
        createdAt: new Date().toISOString(),
      }));
    },

    async clear(_ctx: ExecutionContext): Promise<void> {
      messages.length = 0;
    },
  };
}

export function createConfiguredConversationMemory(
  options: ConfiguredMemoryStoreOptions,
  conversationOptions?: { maxHistory?: number },
): ConfiguredConversationMemory {
  const maxHistory = conversationOptions?.maxHistory ?? 100;
  const store = createConfiguredMemoryStore(options);

  return {
    async addMessage(ctx: ExecutionContext, message: Message): Promise<void> {
      const sessionScope = sessionScopeFromContext(ctx);
      const entry: MemoryEntry = {
        id: `conversation:${sessionScope}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        type: 'conversation',
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        metadata: { role: message.role },
        createdAt: new Date().toISOString(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: sessionScope,
      };
      await store.write(ctx, [entry]);
      const history = await store.query(ctx, {
        type: 'conversation',
        filter: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: sessionScope,
        },
        topK: maxHistory + 1,
      });
      if (history.length > maxHistory) {
        const overflow = history.slice(0, history.length - maxHistory);
        await store.delete(ctx, overflow.map((entry) => entry.id));
      }
    },
    async getMessages(ctx: ExecutionContext, limit?: number): Promise<Message[]> {
      const sessionScope = sessionScopeFromContext(ctx);
      const rows = await store.query(ctx, {
        type: 'conversation',
        filter: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: sessionScope,
        },
        topK: limit ?? maxHistory,
      });
      return rows.map((row) => ({
        role: String(row.metadata['role'] ?? 'user') as Message['role'],
        content: row.content,
      }));
    },
    async getHistory(ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]> {
      const sessionScope = sessionScopeFromContext(ctx);
      return store.query(ctx, {
        type: 'conversation',
        filter: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: sessionScope,
        },
        topK: limit ?? maxHistory,
      });
    },
    async clear(ctx: ExecutionContext): Promise<void> {
      const sessionScope = sessionScopeFromContext(ctx);
      await store.clear(ctx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: sessionScope,
        types: ['conversation'],
      });
    },
    async close(): Promise<void> {
      await store.close();
    },
  };
}

/**
 * Synchronous factory — retained for backward compatibility.
 * Drivers load at module startup via static imports above.
 * For new call sites that can be async, prefer createConfiguredMemoryStoreAsync().
 */
export function createConfiguredMemoryStore(options: ConfiguredMemoryStoreOptions): DurableMemoryStore {
  switch (options.backend) {
    case 'in-memory': {
      const store = weaveMemoryStore();
      return { ...store, async close() { return Promise.resolve(); } };
    }
    case 'runtime': {
      const store = weaveRuntimeMemoryStore({ runtime: options.runtime, namespace: options.runtimeNamespace });
      return { ...store, async close() { return Promise.resolve(); } };
    }
    case 'postgres':
      if (!options.postgresUrl) throw new Error('postgresUrl is required when backend is postgres');
      return _weavePostgresMemoryStore({ url: options.postgresUrl });
    case 'pgvector':
      if (!options.pgvectorUrl) throw new Error('pgvectorUrl is required when backend is pgvector');
      return _weavePgVectorMemoryStore({
        url: options.pgvectorUrl,
        dimensions: options.pgvectorDimensions,
        tableName: options.pgvectorTableName,
        indexType: options.pgvectorIndexType,
        distanceMetric: options.pgvectorDistanceMetric,
      });
    case 'redis':
      if (!options.redisUrl) throw new Error('redisUrl is required when backend is redis');
      return _weaveRedisMemoryStore({ url: options.redisUrl, keyPrefix: options.redisKeyPrefix });
    case 'sqlite':
      if (!options.sqlitePath) throw new Error('sqlitePath is required when backend is sqlite');
      return _weaveSqliteMemoryStore({ path: options.sqlitePath });
    case 'mongodb':
      if (!options.mongoUrl) throw new Error('mongoUrl is required when backend is mongodb');
      return _weaveMongoDbMemoryStore({
        url: options.mongoUrl,
        databaseName: options.mongoDatabaseName,
        collectionName: options.mongoCollectionName,
      });
    case 'cloud-nosql':
      return _weaveCloudNoSqlMemoryStore({
        provider: options.cloudNoSqlProvider ?? 'dynamodb',
        dynamodb: {
          endpoint: options.dynamoDbEndpoint,
          region: options.dynamoDbRegion,
          tableName: options.dynamoDbTableName,
        },
      });
    default:
      throw new Error(`Unsupported configured memory backend: ${String(options.backend)}`);
  }
}

/**
 * Async factory that uses dynamic import() so only the selected backend's
 * driver package is loaded. Prefer this over createConfiguredMemoryStore for
 * new code where the call site can be async.
 */
export async function createConfiguredMemoryStoreAsync(options: ConfiguredMemoryStoreOptions): Promise<DurableMemoryStore> {
  switch (options.backend) {
    case 'in-memory': {
      const store = weaveMemoryStore();
      return { ...store, async close() { return Promise.resolve(); } };
    }
    case 'runtime': {
      const store = weaveRuntimeMemoryStore({ runtime: options.runtime, namespace: options.runtimeNamespace });
      return { ...store, async close() { return Promise.resolve(); } };
    }
    case 'postgres': {
      if (!options.postgresUrl) throw new Error('postgresUrl is required when backend is postgres');
      const { weavePostgresMemoryStore } = await import('./memory-postgres.js');
      return weavePostgresMemoryStore({ url: options.postgresUrl });
    }
    case 'pgvector': {
      if (!options.pgvectorUrl) throw new Error('pgvectorUrl is required when backend is pgvector');
      const { weavePgVectorMemoryStore } = await import('./memory-pgvector.js');
      return weavePgVectorMemoryStore({
        url: options.pgvectorUrl,
        dimensions: options.pgvectorDimensions,
        tableName: options.pgvectorTableName,
        indexType: options.pgvectorIndexType,
        distanceMetric: options.pgvectorDistanceMetric,
      });
    }
    case 'redis': {
      if (!options.redisUrl) throw new Error('redisUrl is required when backend is redis');
      const { weaveRedisMemoryStore } = await import('./memory-redis.js');
      return weaveRedisMemoryStore({ url: options.redisUrl, keyPrefix: options.redisKeyPrefix });
    }
    case 'sqlite': {
      if (!options.sqlitePath) throw new Error('sqlitePath is required when backend is sqlite');
      const { weaveSqliteMemoryStore } = await import('./memory-sqlite.js');
      return weaveSqliteMemoryStore({ path: options.sqlitePath });
    }
    case 'mongodb': {
      if (!options.mongoUrl) throw new Error('mongoUrl is required when backend is mongodb');
      const { weaveMongoDbMemoryStore } = await import('./memory-mongodb.js');
      return weaveMongoDbMemoryStore({
        url: options.mongoUrl,
        databaseName: options.mongoDatabaseName,
        collectionName: options.mongoCollectionName,
      });
    }
    case 'cloud-nosql': {
      const { weaveCloudNoSqlMemoryStore } = await import('./memory-cloudnosql.js');
      return weaveCloudNoSqlMemoryStore({
        provider: options.cloudNoSqlProvider ?? 'dynamodb',
        dynamodb: {
          endpoint: options.dynamoDbEndpoint,
          region: options.dynamoDbRegion,
          tableName: options.dynamoDbTableName,
        },
      });
    }
    default:
      throw new Error(`Unsupported configured memory backend: ${String(options.backend)}`);
  }
}

// ─── Semantic memory ─────────────────────────────────────────

export function weaveSemanticMemory(
  embeddingModel: EmbeddingModel,
  store?: MemoryStore,
): SemanticMemory {
  const memStore = store ?? weaveMemoryStore();
  let idCounter = 0;

  return {
    async store(ctx: ExecutionContext, content: string, metadata?: Record<string, unknown>): Promise<void> {
      const embeddingResponse = await embeddingModel.embed(ctx, { input: [content] });
      const entry: MemoryEntry = {
        id: `sem_${++idCounter}`,
        type: 'semantic',
        content,
        metadata: metadata ?? {},
        embedding: embeddingResponse.embeddings[0],
        createdAt: new Date().toISOString(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      };
      await memStore.write(ctx, [entry]);
    },

    async recall(ctx: ExecutionContext, query: string, topK?: number): Promise<MemoryEntry[]> {
      const embeddingResponse = await embeddingModel.embed(ctx, { input: [query] });
      return memStore.query(ctx, {
        type: 'semantic',
        embedding: embeddingResponse.embeddings[0],
        topK: topK ?? 5,
      });
    },
  };
}

// ─── Entity memory ───────────────────────────────────────────

export function weaveEntityMemory(store?: MemoryStore): EntityMemory {
  const memStore = store ?? weaveMemoryStore();

  return {
    async upsertEntity(ctx: ExecutionContext, name: string, facts: Record<string, unknown>): Promise<void> {
      const existing = await memStore.query(ctx, {
        type: 'entity',
        query: name,
        topK: 1,
      });
      const entityEntry: MemoryEntry = {
        id: existing[0]?.id ?? `entity_${name}`,
        type: 'entity',
        content: name,
        metadata: { ...existing[0]?.metadata, ...facts },
        createdAt: existing[0]?.createdAt ?? new Date().toISOString(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      };
      await memStore.write(ctx, [entityEntry]);
    },

    async getEntity(ctx: ExecutionContext, name: string): Promise<MemoryEntry | undefined> {
      const results = await memStore.query(ctx, {
        type: 'entity',
        query: name,
        topK: 1,
      });
      return results.find((e) => e.content === name);
    },

    async searchEntities(ctx: ExecutionContext, query: string): Promise<MemoryEntry[]> {
      return memStore.query(ctx, {
        type: 'entity',
        query,
        topK: 10,
      });
    },
  };
}

// ─── Phase 4: runtime-backed memory store ────────────────────────────────────

export function weaveRuntimeMemoryStore(opts: RuntimeMemoryStoreOptions = {}): MemoryStore {
  const ns = opts.namespace ?? 'mem';
  const slot = opts.runtime?.persistence ?? weaveInMemoryPersistence();
  const kv = slot.kv;

  const entryKey = (id: string) => `${ns}:entry:${id}`;
  const prefix = `${ns}:entry:`;

  async function loadAll(): Promise<MemoryEntry[]> {
    const entries = await kv.list(prefix);
    const out: MemoryEntry[] = [];
    for (const e of entries) {
      try { out.push(JSON.parse(e.value) as MemoryEntry); } catch { /* skip malformed */ }
    }
    return out;
  }

  return {
    async write(_ctx: ExecutionContext, newEntries: MemoryEntry[]): Promise<void> {
      await Promise.all(newEntries.map((entry) => kv.set(entryKey(entry.id), JSON.stringify(entry))));
    },

    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      return applyMemoryQuery(await loadAll(), options);
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      await Promise.all(ids.map((id) => kv.delete(entryKey(id))));
    },

    async clear(_ctx: ExecutionContext, filter?: MemoryFilter): Promise<void> {
      if (!filter) {
        const all = await kv.list(prefix);
        await Promise.all(all.map((e) => kv.delete(e.key)));
        return;
      }
      const all = await loadAll();
      const toDelete = all.filter((e) => matchesFilter(e, filter)).map((e) => e.id);
      await Promise.all(toDelete.map((id) => kv.delete(entryKey(id))));
    },
  };
}

