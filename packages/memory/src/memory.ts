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
  WeaveRuntime,
} from '@weaveintel/core';
import type { GraphRetriever } from '@weaveintel/graph';
import { weaveInMemoryPersistence } from '@weaveintel/core';
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
  // ── pgvector options ────────────────────────────────────────
  /** Connection URL for the pgvector backend. */
  pgvectorUrl?: string;
  /** Embedding vector dimensions. Must match your model. Defaults to 1536. */
  pgvectorDimensions?: number;
  /** Table name for the pgvector backend. Defaults to 'memory_vec'. */
  pgvectorTableName?: string;
  /** ANN index type. Defaults to 'hnsw'. */
  pgvectorIndexType?: 'hnsw' | 'ivfflat' | 'none';
  /** Distance metric. Defaults to 'cosine'. */
  pgvectorDistanceMetric?: 'cosine' | 'l2' | 'inner';
}

// ── pgvector store ────────────────────────────────────────────

/**
 * Options for the pgvector-backed memory store.
 */
export interface PgVectorMemoryStoreOptions {
  /** PostgreSQL connection URL. */
  url: string;
  /**
   * Embedding vector dimensions — must match the model you use.
   *   - OpenAI text-embedding-3-small / ada-002 → 1536
   *   - OpenAI text-embedding-3-large           → 3072
   *   - Cohere embed-v3                          → 1024
   * Defaults to 1536.
   */
  dimensions?: number;
  /**
   * Table name. Defaults to `'memory_vec'`.
   * Use a custom name to avoid clashing with the JSON-only `weavePostgresMemoryStore`
   * which creates a table called `memory_entries`.
   */
  tableName?: string;
  /**
   * ANN index type created on the embedding column.
   *  - `'hnsw'`    — recommended; best recall, no list-count tuning needed (pgvector ≥ 0.5.0)
   *  - `'ivfflat'` — faster to build; tune `ivfLists` to √(row count) for best performance
   *  - `'none'`    — exact KNN scan; fine for < 100 k vectors per partition
   * Defaults to `'hnsw'`.
   */
  indexType?: 'hnsw' | 'ivfflat' | 'none';
  /**
   * Number of IVFFlat lists. Only used when `indexType='ivfflat'`.
   * Rule of thumb: √(expected row count). Defaults to 100.
   */
  ivfLists?: number;
  /**
   * Distance / similarity metric. Determines the index operator class
   * and the SQL search operator.
   *  - `'cosine'` (`<=>`) — recommended for unit-normalised embeddings (OpenAI, Cohere, etc.)
   *  - `'l2'`     (`<->`) — Euclidean distance; good for non-normalised models
   *  - `'inner'`  (`<#>`) — inner-product / dot-product; equivalent to cosine on unit vectors
   * Defaults to `'cosine'`.
   */
  distanceMetric?: 'cosine' | 'l2' | 'inner';
  /**
   * Optional graph retriever. When supplied, `query()` runs an entity graph
   * traversal in parallel with vector + FTS passes and fuses the three result
   * sets via Reciprocal Rank Fusion (RRF).
   */
  graphRetriever?: GraphRetriever;
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

  // Bi-temporal asOf filter: exclude entries invalidated before asOf
  if (options.asOf) {
    const asOfTs = new Date(options.asOf).getTime();
    results = results.filter((entry) => {
      const validAt = entry.validAt ? new Date(entry.validAt).getTime() : new Date(entry.createdAt).getTime();
      if (validAt > asOfTs) return false;
      if (entry.invalidAt && new Date(entry.invalidAt).getTime() <= asOfTs) return false;
      return true;
    });
  } else {
    // Default: filter out currently-invalid entries
    results = results.filter((entry) => !entry.invalidAt);
  }

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

/** Heuristic importance score (0–1) for an entry at write time. */
function computeImportance(entry: MemoryEntry): number {
  if (entry.importance !== undefined) return entry.importance;
  let score = 0.4;
  const words = entry.content.trim().split(/\s+/).length;
  if (words >= 5 && words <= 60) score += 0.15;
  if (entry.type === 'semantic' || entry.type === 'procedural') score += 0.2;
  if (entry.type === 'episodic') score += 0.05;
  const src = entry.metadata['source'] as string | undefined;
  if (src === 'user') score += 0.15;
  if (/[A-Z][a-z]/.test(entry.content)) score += 0.05;
  if (/\d/.test(entry.content)) score += 0.05;
  return Math.min(1.0, Math.max(0.0, score));
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
    case 'runtime': {
      const store = weaveRuntimeMemoryStore({ runtime: options.runtime, namespace: options.runtimeNamespace });
      return { ...store, async close() { return Promise.resolve(); } };
    }
    case 'postgres':
      if (!options.postgresUrl) {
        throw new Error('postgresUrl is required when backend is postgres');
      }
      return weavePostgresMemoryStore({ url: options.postgresUrl });
    case 'pgvector':
      if (!options.pgvectorUrl) {
        throw new Error('pgvectorUrl is required when backend is pgvector');
      }
      return weavePgVectorMemoryStore({
        url: options.pgvectorUrl,
        dimensions: options.pgvectorDimensions,
        tableName: options.pgvectorTableName,
        indexType: options.pgvectorIndexType,
        distanceMetric: options.pgvectorDistanceMetric,
      });
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

// ─── pgvector memory store ────────────────────────────────────

/** Internal helpers for pgvector distance operators and index ops classes. */
function pgVectorMetricConfig(metric: 'cosine' | 'l2' | 'inner'): {
  operator: string;
  indexOps: string;
  toScore: (distanceExpr: string) => string;
} {
  switch (metric) {
    case 'cosine':
      // <=> returns cosine distance [0, 2]; similarity = 1 - distance
      return { operator: '<=>', indexOps: 'vector_cosine_ops', toScore: (d) => `(1.0 - ${d})` };
    case 'l2':
      // <-> returns L2 distance [0, ∞]; map to (0, 1] with 1/(1+d)
      return { operator: '<->', indexOps: 'vector_l2_ops', toScore: (d) => `(1.0 / (1.0 + ${d}))` };
    case 'inner':
      // <#> returns negative inner product; negate to get raw dot product
      return { operator: '<#>', indexOps: 'vector_ip_ops', toScore: (d) => `(-(${d}))` };
  }
}

/** Encode a JS number array as the PostgreSQL vector literal `[f1,f2,...,fn]`. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${Array.from(embedding).join(',')}]`;
}

/** Parse the PostgreSQL vector string `[f1,f2,...,fn]` back to a number array. */
function fromVectorLiteral(s: string): readonly number[] {
  return JSON.parse(s) as number[];
}

/** Build a SQL WHERE fragment and corresponding parameter values from a MemoryQuery. */
function buildFilterSQL(
  query: MemoryQuery,
  startIdx: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())'];
  const params: unknown[] = [];
  let idx = startIdx;

  if (query.type) {
    conditions.push(`type = $${idx++}`);
    params.push(query.type);
  }
  const f = query.filter;
  if (f?.tenantId) { conditions.push(`tenant_id = $${idx++}`); params.push(f.tenantId); }
  if (f?.userId)   { conditions.push(`user_id = $${idx++}`);   params.push(f.userId); }
  if (f?.sessionId){ conditions.push(`session_id = $${idx++}`); params.push(f.sessionId); }
  if (f?.types && f.types.length > 0) {
    conditions.push(`type = ANY($${idx++}::text[])`);
    params.push(f.types);
  }
  if (f?.after)  { conditions.push(`created_at > $${idx++}`); params.push(f.after); }
  if (f?.before) { conditions.push(`created_at < $${idx++}`); params.push(f.before); }

  // Bi-temporal asOf: entries valid at the given timestamp
  if (query.asOf) {
    conditions.push(`(valid_at IS NULL OR valid_at <= $${idx++})`);
    params.push(query.asOf);
    conditions.push(`(invalid_at IS NULL OR invalid_at > $${idx++})`);
    params.push(query.asOf);
  } else {
    // Default: exclude invalidated entries
    conditions.push('invalid_at IS NULL');
  }

  return { sql: conditions.join(' AND '), params };
}

/** Map a raw postgres query row to a MemoryEntry. */
function pgRowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row['id'] as string,
    type: row['type'] as MemoryType,
    content: row['content'] as string,
    metadata: row['metadata'] as Record<string, unknown>,
    embedding: row['embedding'] != null ? fromVectorLiteral(row['embedding'] as string) : undefined,
    createdAt: (row['created_at'] instanceof Date
      ? (row['created_at'] as Date).toISOString()
      : String(row['created_at'])),
    expiresAt: row['expires_at'] != null
      ? (row['expires_at'] instanceof Date
        ? (row['expires_at'] as Date).toISOString()
        : String(row['expires_at']))
      : undefined,
    tenantId:  row['tenant_id']  as string | undefined,
    userId:    row['user_id']    as string | undefined,
    sessionId: row['session_id'] as string | undefined,
    score:     row['_score']     as number | undefined,
    importance: row['importance'] != null ? Number(row['importance']) : undefined,
    validAt:   row['valid_at'] != null
      ? (row['valid_at'] instanceof Date
        ? (row['valid_at'] as Date).toISOString()
        : String(row['valid_at']))
      : undefined,
    invalidAt: row['invalid_at'] != null
      ? (row['invalid_at'] instanceof Date
        ? (row['invalid_at'] as Date).toISOString()
        : String(row['invalid_at']))
      : undefined,
  };
}

/**
 * A `MemoryStore` backed by PostgreSQL + pgvector.
 *
 * Delegates vector similarity search to the database using the `<=>` / `<->` /
 * `<#>` operators so cosine (or L2 / inner-product) ranking never leaves the DB.
 * All filter predicates (type, userId, tenantId, before/after) are pushed down
 * to SQL WHERE clauses — only the final `topK` rows are transferred.
 *
 * Prerequisites
 * -------------
 * 1. PostgreSQL 12+ with the `pgvector` extension installed:
 *    ```sql
 *    CREATE EXTENSION IF NOT EXISTS vector;
 *    ```
 *    Or via Docker: `ankane/pgvector` / `pgvector/pgvector` images include it.
 *
 * 2. The `pg` package is already a dependency of `@weaveintel/memory`; no extra
 *    package is needed.
 *
 * Schema
 * ------
 * On first use the store creates:
 * - Table `memory_vec` (configurable via `tableName`)
 * - Optional HNSW or IVFFlat index on the `embedding` column
 *
 * Adopting in geneWeave
 * ---------------------
 * Pass `weavePgVectorMemoryStore` as the `store` argument to `weaveSemanticMemory`:
 * ```typescript
 * const pgVec = weavePgVectorMemoryStore({ url: process.env.PG_URL! });
 * const semanticMem = weaveSemanticMemory(embeddingModel, pgVec);
 * ```
 * Or use the configured factory:
 * ```typescript
 * const store = createConfiguredMemoryStore({
 *   backend: 'pgvector',
 *   pgvectorUrl: process.env.PG_URL!,
 *   pgvectorDimensions: 1536,
 * });
 * ```
 */
export function weavePgVectorMemoryStore(opts: PgVectorMemoryStoreOptions): DurableMemoryStore {
  const pool = new Pool({ connectionString: opts.url });
  const dims   = opts.dimensions     ?? 1536;
  const table  = opts.tableName      ?? 'memory_vec';
  const metric = opts.distanceMetric ?? 'cosine';
  const idxType = opts.indexType     ?? 'hnsw';
  const graphRetriever = opts.graphRetriever;
  const { operator, indexOps, toScore } = pgVectorMetricConfig(metric);

  let schemaReady = false;

  async function ensureSchema(): Promise<void> {
    if (schemaReady) return;
    const client = await pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          content     TEXT NOT NULL,
          metadata    JSONB NOT NULL DEFAULT '{}',
          embedding   vector(${dims}),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at  TIMESTAMPTZ,
          tenant_id   TEXT,
          user_id     TEXT,
          session_id  TEXT,
          importance  REAL,
          valid_at    TIMESTAMPTZ,
          invalid_at  TIMESTAMPTZ
        )
      `);

      // Idempotent column migrations — adds new columns to pre-existing tables
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS importance  REAL`);
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS valid_at    TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS invalid_at  TIMESTAMPTZ`);

      // GIN full-text index on content
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_content_idx
          ON ${table} USING gin(to_tsvector('english', content))
      `);

      // Index on invalid_at for fast "currently valid" scans
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_invalid_at_idx
          ON ${table} (invalid_at)
          WHERE invalid_at IS NULL
      `);

      if (idxType === 'hnsw') {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
            ON ${table}
            USING hnsw (embedding ${indexOps})
        `);
      } else if (idxType === 'ivfflat') {
        const lists = opts.ivfLists ?? 100;
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${table}_embedding_ivfflat_idx
            ON ${table}
            USING ivfflat (embedding ${indexOps})
            WITH (lists = ${lists})
        `);
      }

      schemaReady = true;
    } finally {
      client.release();
    }
  }

  return {
    // ── write ──────────────────────────────────────────────────────────────
    async write(_ctx, entries): Promise<void> {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of entries) {
          const embLiteral = entry.embedding ? toVectorLiteral(entry.embedding) : null;
          const importance = computeImportance(entry);
          await client.query(
            `INSERT INTO ${table}
               (id, type, content, metadata, embedding,
                created_at, expires_at, tenant_id, user_id, session_id,
                importance, valid_at, invalid_at)
             VALUES ($1, $2, $3, $4::jsonb,
                     $5::vector,
                     $6, $7, $8, $9, $10,
                     $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               type       = EXCLUDED.type,
               content    = EXCLUDED.content,
               metadata   = EXCLUDED.metadata,
               embedding  = EXCLUDED.embedding,
               expires_at = EXCLUDED.expires_at,
               tenant_id  = EXCLUDED.tenant_id,
               user_id    = EXCLUDED.user_id,
               session_id = EXCLUDED.session_id,
               importance = EXCLUDED.importance,
               valid_at   = EXCLUDED.valid_at,
               invalid_at = EXCLUDED.invalid_at`,
            [
              entry.id,
              entry.type,
              entry.content,
              JSON.stringify(entry.metadata ?? {}),
              embLiteral,
              entry.createdAt,
              entry.expiresAt  ?? null,
              entry.tenantId   ?? null,
              entry.userId     ?? null,
              entry.sessionId  ?? null,
              importance,
              entry.validAt    ?? null,
              entry.invalidAt  ?? null,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // ── query ──────────────────────────────────────────────────────────────
    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureSchema();
      const topK = options.topK ?? 10;
      const candidate = topK * 3; // over-fetch before RRF re-ranking
      const client = await pool.connect();

      try {
        const hasVector = options.embedding && options.embedding.length > 0;
        const hasText   = !!options.query;

        // ── Recency / filter-only scan (no signals) ───────────────────────
        if (!hasVector && !hasText) {
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 2);
          const result = await client.query(
            `SELECT * FROM ${table}
             WHERE ${filterSQL}
             ORDER BY created_at DESC LIMIT $1`,
            [topK, ...filterParams],
          );
          return result.rows.map(pgRowToMemoryEntry);
        }

        // ── RRF fusion: run vector + FTS in parallel, merge scores ────────
        const RRF_K = 60;

        // Collect ranked id lists from each retrieval pass
        const vectorIds: string[] = [];
        const ftsIds:    string[] = [];

        if (hasVector) {
          const qVec = toVectorLiteral(options.embedding!);
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 3);
          const scoreExpr = toScore(`(embedding ${operator} $1::vector)`);
          let sql = `
            SELECT id, ${scoreExpr} AS _score
            FROM ${table}
            WHERE embedding IS NOT NULL
              AND ${filterSQL}
          `;
          const params: unknown[] = [qVec, candidate, ...filterParams];
          if (options.minScore !== undefined) {
            sql += ` AND ${scoreExpr} >= ${options.minScore}`;
          }
          sql += ` ORDER BY embedding ${operator} $1::vector LIMIT $2`;
          const vRes = await client.query<{ id: string }>(sql, params);
          for (const row of vRes.rows) vectorIds.push(row.id);
        }

        if (hasText) {
          const queryText = options.query!;
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 3);
          // Try FTS first; fall back to ILIKE if tsquery parse fails
          const ftsSQL = `
            SELECT id
            FROM ${table}
            WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
              AND ${filterSQL}
            ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) DESC
            LIMIT $2
          `;
          try {
            const fRes = await client.query<{ id: string }>(
              ftsSQL,
              [queryText, candidate, ...filterParams],
            );
            for (const row of fRes.rows) ftsIds.push(row.id);
          } catch {
            // Fallback: ILIKE
            const { sql: f2SQL, params: f2Params } = buildFilterSQL(options, 3);
            const ilikeRes = await client.query<{ id: string }>(
              `SELECT id FROM ${table}
               WHERE LOWER(content) LIKE LOWER($1) AND ${f2SQL}
               ORDER BY created_at DESC LIMIT $2`,
              [`%${queryText}%`, candidate, ...f2Params],
            );
            for (const row of ilikeRes.rows) ftsIds.push(row.id);
          }
        }

        // ── Graph entity-match pass (optional third signal) ───────────────
        const graphIds: string[] = [];
        if (graphRetriever && hasText) {
          try {
            const graphResults = graphRetriever.retrieve(options.query!, candidate);
            for (const gr of graphResults) {
              // Map graph node name to memory content via a keyword search
              const { sql: gFilterSQL, params: gFilterParams } = buildFilterSQL(options, 3);
              const gRes = await client.query<{ id: string }>(
                `SELECT id FROM ${table}
                 WHERE LOWER(content) LIKE LOWER($1) AND ${gFilterSQL}
                 ORDER BY created_at DESC LIMIT $2`,
                [`%${gr.node.name}%`, 5, ...gFilterParams],
              );
              for (const row of gRes.rows) graphIds.push(row.id);
            }
          } catch {
            // Graph retrieval is best-effort
          }
        }

        // ── RRF scoring ───────────────────────────────────────────────────
        const rrfScores = new Map<string, number>();

        for (const [rank, id] of vectorIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        }
        for (const [rank, id] of ftsIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        }
        for (const [rank, id] of graphIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 0.5 / (RRF_K + rank + 1));
        }

        // Sort by RRF score descending; take top topK IDs
        const ranked = [...rrfScores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, topK)
          .map(([id]) => id);

        if (ranked.length === 0) return [];

        // ── Fetch full rows for ranked IDs ────────────────────────────────
        const placeholders = ranked.map((_, i) => `$${i + 1}`).join(', ');
        const fullRows = await client.query(
          `SELECT * FROM ${table} WHERE id = ANY(ARRAY[${placeholders}])`,
          ranked,
        );

        // Rehydrate and attach RRF score
        const byId = new Map(fullRows.rows.map((r: Record<string, unknown>) => [r['id'] as string, r]));
        const ranked_entries: MemoryEntry[] = [];
        for (const id of ranked) {
          const row = byId.get(id);
          if (!row) continue;
          ranked_entries.push({ ...pgRowToMemoryEntry(row), score: rrfScores.get(id) ?? 0 });
        }
        return ranked_entries;
      } finally {
        client.release();
      }
    },

    // ── delete ─────────────────────────────────────────────────────────────
    async delete(_ctx, ids): Promise<void> {
      if (ids.length === 0) return;
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]);
      } finally {
        client.release();
      }
    },

    // ── clear ──────────────────────────────────────────────────────────────
    async clear(_ctx, filter): Promise<void> {
      await ensureSchema();
      const client = await pool.connect();
      try {
        if (!filter) {
          await client.query(`DELETE FROM ${table}`);
          return;
        }
        // Build filter without asOf / expiry guard — we want to delete all matching rows
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (filter.tenantId)  { conditions.push(`tenant_id = $${idx++}`);  params.push(filter.tenantId); }
        if (filter.userId)    { conditions.push(`user_id = $${idx++}`);    params.push(filter.userId); }
        if (filter.sessionId) { conditions.push(`session_id = $${idx++}`); params.push(filter.sessionId); }
        if (filter.types && filter.types.length > 0) {
          conditions.push(`type = ANY($${idx++}::text[])`);
          params.push(filter.types);
        }
        if (filter.after)  { conditions.push(`created_at > $${idx++}`); params.push(filter.after); }
        if (filter.before) { conditions.push(`created_at < $${idx++}`); params.push(filter.before); }
        if (conditions.length === 0) {
          await client.query(`DELETE FROM ${table}`);
        } else {
          await client.query(`DELETE FROM ${table} WHERE ${conditions.join(' AND ')}`, params);
        }
      } finally {
        client.release();
      }
    },

    // ── close ──────────────────────────────────────────────────────────────
    async close(): Promise<void> {
      await pool.end();
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

// ─── Phase 4: runtime-backed memory store ────────────────────────────────────

export interface RuntimeMemoryStoreOptions {
  /** When supplied and `runtime.persistence` is configured, entries survive
   *  process restarts. Falls back to `weaveInMemoryPersistence()` otherwise. */
  runtime?: WeaveRuntime;
  /** KV key namespace. Defaults to `'mem'`. */
  namespace?: string;
}

/**
 * Durable memory store backed by `runtime.persistence.kv` (Phase 4).
 *
 * Key layout: `${namespace}:entry:${entry.id}` → JSON(MemoryEntry).
 * All entries are loaded via a prefix scan and filtered / ranked in-memory,
 * matching the approach used by `createDurableDeadLetterQueue`.
 *
 * This is the recommended durable path for memory. The existing per-backend
 * factories (`weaveSqliteMemoryStore`, `weaveRedisMemoryStore`, …) remain
 * available but are superseded for runtime-integrated deployments.
 */
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
