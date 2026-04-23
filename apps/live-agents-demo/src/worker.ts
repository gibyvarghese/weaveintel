import {
  createActionExecutor,
  createHeartbeat,
  type StateStore,
  weaveCloudNoSqlStateStore,
  weaveMongoDbStateStore,
  weaveRedisStateStore,
  weavePostgresStateStore,
  weaveSqliteStateStore,
} from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';

async function main() {
  const configuredBackend = process.env['LIVE_AGENTS_DEMO_PERSISTENCE_BACKEND'] as
    | 'in-memory'
    | 'postgres'
    | 'redis'
    | 'sqlite'
    | 'mongodb'
    | 'cloud-nosql'
    | undefined;
  const databaseUrl = process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const redisUrl = process.env['LIVE_AGENTS_DEMO_REDIS_URL'];
  const sqlitePath = process.env['LIVE_AGENTS_DEMO_SQLITE_PATH'];
  const mongoUrl = process.env['LIVE_AGENTS_DEMO_MONGODB_URL'];
  const mongoDatabaseName = process.env['LIVE_AGENTS_DEMO_MONGODB_DATABASE'] ?? 'live_agents_demo';
  const cloudNoSqlProvider =
    (process.env['LIVE_AGENTS_DEMO_CLOUD_NOSQL_PROVIDER'] as 'dynamodb' | undefined) ?? 'dynamodb';
  const dynamoDbEndpoint = process.env['LIVE_AGENTS_DEMO_DYNAMODB_ENDPOINT'];
  const dynamoDbRegion = process.env['LIVE_AGENTS_DEMO_DYNAMODB_REGION'] ?? 'us-east-1';
  const dynamoDbTableName = process.env['LIVE_AGENTS_DEMO_DYNAMODB_TABLE'] ?? 'la_entities';
  const redisMode =
    (process.env['LIVE_AGENTS_DEMO_REDIS_MODE'] as 'coordination-only' | 'durable-explicit' | undefined) ??
    'coordination-only';

  const resolvedBackend = configuredBackend ?? (databaseUrl ? 'postgres' : 'in-memory');

  let stateStore: StateStore;
  if (resolvedBackend === 'postgres') {
    if (!databaseUrl) {
      throw new Error('LIVE_AGENTS_DEMO_DATABASE_URL is required when persistence backend is postgres');
    }
    stateStore = await weavePostgresStateStore({ url: databaseUrl });
  } else if (resolvedBackend === 'sqlite') {
    if (!sqlitePath) {
      throw new Error('LIVE_AGENTS_DEMO_SQLITE_PATH is required when persistence backend is sqlite');
    }
    stateStore = await weaveSqliteStateStore({ path: sqlitePath });
  } else if (resolvedBackend === 'mongodb') {
    if (!mongoUrl) {
      throw new Error('LIVE_AGENTS_DEMO_MONGODB_URL is required when persistence backend is mongodb');
    }
    stateStore = await weaveMongoDbStateStore({
      url: mongoUrl,
      databaseName: mongoDatabaseName,
      collectionName: 'la_entities',
    });
  } else if (resolvedBackend === 'cloud-nosql') {
    stateStore = await weaveCloudNoSqlStateStore({
      provider: cloudNoSqlProvider,
      dynamodb: {
        endpoint: dynamoDbEndpoint,
        region: dynamoDbRegion,
        tableName: dynamoDbTableName,
      },
    });
  } else if (resolvedBackend === 'redis') {
    if (!redisUrl) {
      throw new Error('LIVE_AGENTS_DEMO_REDIS_URL is required when persistence backend is redis');
    }
    stateStore = weaveRedisStateStore({
      url: redisUrl,
      mode: redisMode,
      keyPrefix: 'weave:live-agents-demo',
    });
  } else {
    stateStore = await createInMemoryDemoStateStore();
  }

  const maybeInit = (stateStore as { initialize?: () => Promise<void> }).initialize;
  if (maybeInit) {
    await maybeInit.call(stateStore);
  }

  const heartbeat = createHeartbeat({
    stateStore,
    workerId: process.env['LIVE_AGENTS_DEMO_WORKER_ID'] ?? 'live-agents-demo-worker',
    concurrency: Number.parseInt(process.env['LIVE_AGENTS_DEMO_WORKER_CONCURRENCY'] ?? '4', 10),
    actionExecutor: createActionExecutor(),
  });

  const result = await heartbeat.tick(weaveContext({ userId: 'human:ops-admin-1' }));
  console.log(`live-agents-demo worker processed ${result.processed} ticks`);

  await heartbeat.stop();
  const close = (stateStore as { close?: () => Promise<void> }).close;
  if (close) {
    await close.call(stateStore);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
