import { describe, expect, it } from 'vitest';
import { weaveContext, type Message } from '@weaveintel/core';
import {
  createConfiguredConversationMemory,
  weaveCloudNoSqlMemoryStore,
  weaveMongoDbMemoryStore,
  weavePostgresMemoryStore,
  weaveRedisMemoryStore,
  weaveSqliteMemoryStore,
} from './memory.js';

const REDIS_URL = process.env['WEAVE_MEMORY_TEST_REDIS_URL'];
const POSTGRES_URL = process.env['WEAVE_MEMORY_TEST_POSTGRES_URL'];
const MONGODB_URL = process.env['WEAVE_MEMORY_TEST_MONGODB_URL'];
const DYNAMODB_ENDPOINT = process.env['WEAVE_MEMORY_TEST_DYNAMODB_ENDPOINT'];

function createMessages(prefix: string): Message[] {
  return [
    { role: 'user', content: `${prefix} user message` },
    { role: 'assistant', content: `${prefix} assistant message` },
  ];
}

async function exerciseConversationMemory(memory: {
  addMessage: (ctx: ReturnType<typeof weaveContext>, message: Message) => Promise<void>;
  getMessages: (ctx: ReturnType<typeof weaveContext>, limit?: number) => Promise<Message[]>;
  clear: (ctx: ReturnType<typeof weaveContext>) => Promise<void>;
}, prefix: string): Promise<void> {
  const ctx = weaveContext({
    tenantId: `${prefix}:tenant`,
    userId: `${prefix}:user`,
    metadata: { sessionId: `${prefix}:session` },
  });
  for (const message of createMessages(prefix)) {
    await memory.addMessage(ctx, message);
  }
  const history = await memory.getMessages(ctx);
  expect(history.map((message) => message.content)).toEqual([
    `${prefix} user message`,
    `${prefix} assistant message`,
  ]);
  await memory.clear(ctx);
  expect(await memory.getMessages(ctx)).toHaveLength(0);
}

describe('configured conversation memory', () => {
  it('supports in-memory mode by default', async () => {
    const memory = createConfiguredConversationMemory({ backend: 'in-memory' });
    await exerciseConversationMemory(memory, 'memory-default');
  });

  it('supports sqlite durable mode', async () => {
    const memory = createConfiguredConversationMemory({
      backend: 'sqlite',
      sqlitePath: `/tmp/weave-memory-${Date.now()}.db`,
    });
    await exerciseConversationMemory(memory, 'memory-sqlite');
  });
});

describe.runIf(Boolean(POSTGRES_URL))('postgres memory store', () => {
  it('persists and queries memory entries', async () => {
    const store = await weavePostgresMemoryStore({ url: POSTGRES_URL! });
    const ctx = weaveContext({ tenantId: 'pg-tenant', userId: 'pg-user', metadata: { sessionId: 'pg-session' } });
    await store.write(ctx, [{
      id: `pg:${Date.now()}`,
      type: 'conversation',
      content: 'postgres memory',
      metadata: {},
      createdAt: new Date().toISOString(),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: String(ctx.metadata['sessionId']),
    }]);
    const rows = await store.query(ctx, { type: 'conversation', query: 'postgres', topK: 5 });
    expect(rows.some((row) => row.content === 'postgres memory')).toBe(true);
    await store.close();
  });
});

describe.runIf(Boolean(REDIS_URL))('redis memory store', () => {
  it('persists and queries memory entries', async () => {
    const store = weaveRedisMemoryStore({ url: REDIS_URL!, keyPrefix: `weave:memory:test:${Date.now()}` });
    const ctx = weaveContext({ tenantId: 'redis-tenant', userId: 'redis-user', metadata: { sessionId: 'redis-session' } });
    await store.write(ctx, [{
      id: `redis:${Date.now()}`,
      type: 'conversation',
      content: 'redis memory',
      metadata: {},
      createdAt: new Date().toISOString(),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: String(ctx.metadata['sessionId']),
    }]);
    const rows = await store.query(ctx, { type: 'conversation', query: 'redis', topK: 5 });
    expect(rows.some((row) => row.content === 'redis memory')).toBe(true);
    await store.close();
  });
});

describe.runIf(Boolean(MONGODB_URL))('mongodb memory store', () => {
  it('persists and queries memory entries', async () => {
    const store = await weaveMongoDbMemoryStore({
      url: MONGODB_URL!,
      databaseName: 'weave_memory_test',
      collectionName: 'entries',
    });
    const ctx = weaveContext({ tenantId: 'mongo-tenant', userId: 'mongo-user', metadata: { sessionId: 'mongo-session' } });
    await store.write(ctx, [{
      id: `mongo:${Date.now()}`,
      type: 'conversation',
      content: 'mongodb memory',
      metadata: {},
      createdAt: new Date().toISOString(),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: String(ctx.metadata['sessionId']),
    }]);
    const rows = await store.query(ctx, { type: 'conversation', query: 'mongodb', topK: 5 });
    expect(rows.some((row) => row.content === 'mongodb memory')).toBe(true);
    await store.close();
  });
});

describe.runIf(Boolean(DYNAMODB_ENDPOINT))('cloud-nosql memory store', () => {
  it('persists and queries memory entries', async () => {
    const store = await weaveCloudNoSqlMemoryStore({
      provider: 'dynamodb',
      dynamodb: {
        endpoint: DYNAMODB_ENDPOINT!,
        region: 'us-east-1',
        tableName: 'weave_memory_entries',
      },
    });
    const ctx = weaveContext({ tenantId: 'ddb-tenant', userId: 'ddb-user', metadata: { sessionId: 'ddb-session' } });
    await store.write(ctx, [{
      id: `ddb:${Date.now()}`,
      type: 'conversation',
      content: 'dynamodb memory',
      metadata: {},
      createdAt: new Date().toISOString(),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: String(ctx.metadata['sessionId']),
    }]);
    const rows = await store.query(ctx, { type: 'conversation', query: 'dynamodb', topK: 5 });
    expect(rows.some((row) => row.content === 'dynamodb memory')).toBe(true);
    await store.close();
  });
});