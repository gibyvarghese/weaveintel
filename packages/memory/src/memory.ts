/**
 * @weaveintel/memory — In-memory implementations
 *
 * Provides conversation memory (message history with optional summarization),
 * semantic memory (embedding-based recall), and entity memory (named facts).
 * All backed by in-memory storage. Production deployments can use the same
 * interfaces with persistent stores (Redis, Postgres, etc.).
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
} from '@weaveintel/core';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { MongoClient } from 'mongodb';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

type DurableMemoryStore = MemoryStore & { close(): Promise<void> };

interface StoredMemoryDocument {
  _id: string;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: readonly number[];
  createdAt: string;
  expiresAt?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  updatedAt: Date;
}

export type ConfiguredConversationMemory = AgentMemory & {
  getHistory(ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]>;
  close(): Promise<void>;
};

export interface ConfiguredMemoryStoreOptions {
  backend: 'in-memory' | 'postgres' | 'redis' | 'sqlite' | 'mongodb' | 'cloud-nosql';
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
}

function matchesFilter(entry: MemoryEntry, filter?: MemoryFilter): boolean {
  if (!filter) return true;
  if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
  if (filter.userId && entry.userId !== filter.userId) return false;
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.types && !filter.types.includes(entry.type)) return false;
  if (filter.after && entry.createdAt < filter.after) return false;
  if (filter.before && entry.createdAt > filter.before) return false;
  return true;
}

function applyMemoryQuery(entries: MemoryEntry[], options: MemoryQuery): MemoryEntry[] {
  let results = [...entries];
  if (options.type) {
    results = results.filter((entry) => entry.type === options.type);
  }
  results = results.filter((entry) => matchesFilter(entry, options.filter));

  if (options.embedding) {
    const queryEmb = options.embedding;
    results = results
      .filter((entry) => entry.embedding)
      .map((entry) => ({ entry, score: cosineSimilarity(queryEmb, entry.embedding!) }))
      .filter((row) => !options.minScore || row.score >= options.minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK ?? 10)
      .map((row) => ({ ...row.entry, score: row.score }));
    return results;
  }

  if (options.query) {
    const lower = options.query.toLowerCase();
    results = results.filter((entry) => entry.content.toLowerCase().includes(lower));
  }

  return results.slice(0, options.topK ?? 10);
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
        // Called as addMessage(ctx, role, content, metadata)
        messages.push({ role: msg as Message['role'], content: content! });
      } else {
        messages.push(msg);
      }
      // Trim if too long
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

export function createConfiguredMemoryStore(options: ConfiguredMemoryStoreOptions): DurableMemoryStore {
  switch (options.backend) {
    case 'in-memory': {
      const store = weaveMemoryStore();
      return {
        ...store,
        async close(): Promise<void> {
          return Promise.resolve();
        },
      };
    }
    case 'postgres':
      if (!options.postgresUrl) {
        throw new Error('postgresUrl is required when backend is postgres');
      }
      return weavePostgresMemoryStore({ url: options.postgresUrl });
    case 'redis':
      if (!options.redisUrl) {
        throw new Error('redisUrl is required when backend is redis');
      }
      return weaveRedisMemoryStore({ url: options.redisUrl, keyPrefix: options.redisKeyPrefix });
    case 'sqlite':
      if (!options.sqlitePath) {
        throw new Error('sqlitePath is required when backend is sqlite');
      }
      return weaveSqliteMemoryStore({ path: options.sqlitePath });
    case 'mongodb':
      if (!options.mongoUrl) {
        throw new Error('mongoUrl is required when backend is mongodb');
      }
      return weaveMongoDbMemoryStore({
        url: options.mongoUrl,
        databaseName: options.mongoDatabaseName,
        collectionName: options.mongoCollectionName,
      });
    case 'cloud-nosql':
      return weaveCloudNoSqlMemoryStore({
        provider: options.cloudNoSqlProvider ?? 'dynamodb',
        dynamodb: {
          endpoint: options.dynamoDbEndpoint,
          region: options.dynamoDbRegion,
          tableName: options.dynamoDbTableName,
        },
      });
    default:
      return assertNever(options.backend);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported configured memory backend: ${String(value)}`);
}

function parseStoredMemoryRow(value: string): MemoryEntry {
  return JSON.parse(value) as MemoryEntry;
}

function sessionScopeFromContext(ctx: ExecutionContext): string {
  const scopedSessionId = ctx.metadata['sessionId'];
  if (typeof scopedSessionId === 'string' && scopedSessionId.length > 0) {
    return scopedSessionId;
  }
  return ctx.executionId;
}

export function weavePostgresMemoryStore(opts: { url: string }): DurableMemoryStore {
  const pool = new Pool({ connectionString: opts.url });

  return {
    async write(_ctx, entries): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS memory_entries (
            id TEXT PRIMARY KEY,
            payload_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('BEGIN');
        for (const entry of entries) {
          await client.query(
            `
            INSERT INTO memory_entries (id, payload_json, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (id)
            DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW()
            `,
            [entry.id, JSON.stringify(entry)],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS memory_entries (
            id TEXT PRIMARY KEY,
            payload_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        const result = await client.query<{ payload_json: string }>(
          'SELECT payload_json::text AS payload_json FROM memory_entries ORDER BY updated_at ASC',
        );
        return applyMemoryQuery(result.rows.map((row) => parseStoredMemoryRow(row.payload_json)), options);
      } finally {
        client.release();
      }
    },
    async delete(_ctx, ids): Promise<void> {
      if (ids.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM memory_entries WHERE id = ANY($1)', [ids]);
      } finally {
        client.release();
      }
    },
    async clear(ctx, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function weaveRedisMemoryStore(opts: { url: string; keyPrefix?: string }): DurableMemoryStore {
  const client = createClient({ url: opts.url });
  const keyPrefix = opts.keyPrefix ?? 'weave:memory';

  async function ensureOpen(): Promise<void> {
    if (!client.isOpen) {
      await client.connect();
    }
  }

  function entryKey(id: string): string {
    return `${keyPrefix}:entry:${id}`;
  }

  return {
    async write(_ctx, entries): Promise<void> {
      await ensureOpen();
      const multi = client.multi();
      for (const entry of entries) {
        multi.set(entryKey(entry.id), JSON.stringify(entry));
      }
      await multi.exec();
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureOpen();
      const keys = await client.keys(`${keyPrefix}:entry:*`);
      if (keys.length === 0) {
        return [];
      }
      const values = await client.mGet(keys);
      const rows = values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => parseStoredMemoryRow(value));
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      await ensureOpen();
      if (ids.length === 0) return;
      await client.del(ids.map((id) => entryKey(id)));
    },
    async clear(ctx, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
}

export function weaveSqliteMemoryStore(opts: { path: string }): DurableMemoryStore {
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const upsert = db.prepare(`
    INSERT INTO memory_entries (id, payload_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id)
    DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP
  `);
  const selectAll = db.prepare('SELECT payload_json FROM memory_entries ORDER BY updated_at ASC');
  const deleteById = db.prepare('DELETE FROM memory_entries WHERE id = ?');

  return {
    async write(_ctx, entries): Promise<void> {
      const transaction = db.transaction((rows: MemoryEntry[]) => {
        for (const row of rows) {
          upsert.run(row.id, JSON.stringify(row));
        }
      });
      transaction(entries);
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      const rows = (selectAll.all() as Array<{ payload_json: string }>).map((row) => parseStoredMemoryRow(row.payload_json));
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      const transaction = db.transaction((keys: string[]) => {
        for (const id of keys) {
          deleteById.run(id);
        }
      });
      transaction(ids);
    },
    async clear(ctx, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

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
    async clear(ctx, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      await client.close();
      connected = false;
    },
  };
}

export function weaveCloudNoSqlMemoryStore(opts: {
  provider: 'dynamodb';
  dynamodb: {
    endpoint?: string;
    region?: string;
    tableName?: string;
  };
}): DurableMemoryStore {
  const region = opts.dynamodb.region ?? 'us-east-1';
  const tableName = opts.dynamodb.tableName ?? 'memory_entries';
  const client = new DynamoDBClient({
    endpoint: opts.dynamodb.endpoint,
    region,
    credentials: opts.dynamodb.endpoint ? { accessKeyId: 'local', secretAccessKey: 'local' } : undefined,
  });
  const docClient = DynamoDBDocumentClient.from(client);

  async function ensureTable(): Promise<void> {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      return;
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) {
        throw error;
      }
    }
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  }

  return {
    async write(_ctx, entries): Promise<void> {
      await ensureTable();
      for (const entry of entries) {
        await docClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: 'memory',
            sk: entry.id,
            entry,
            updatedAt: new Date().toISOString(),
          },
        }));
      }
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureTable();
      const result = await docClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'memory' },
      }));
      const rows = (result.Items ?? []).map((item) => item['entry'] as MemoryEntry);
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      await ensureTable();
      for (const id of ids) {
        await docClient.send(new DeleteCommand({
          TableName: tableName,
          Key: { pk: 'memory', sk: id },
        }));
      }
    },
    async clear(ctx, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      await client.destroy();
    },
  };
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

// ─── Cosine similarity utility ───────────────────────────────

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
