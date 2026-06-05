import type { Server } from 'node:http';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';
import { createLiveAgentsDemoServer } from './app.js';
import {
  type CloudNoSqlStateStore,
  weaveCloudNoSqlStateStore,
  type MongoDbStateStore,
  weaveRedisStateStore,
  weaveMongoDbStateStore,
  weavePostgresStateStore,
  type PostgresStateStore,
  type RedisStateStore,
  type StateStore,
  type SqliteStateStore,
  weaveSqliteStateStore,
} from '@weaveintel/live-agents';
import {
  weaveRuntime,
  weaveInMemoryPersistence,
  envSecretResolver,
  type RuntimePersistenceSlot,
  type WeaveRuntime,
} from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';

export interface LiveAgentsDemoOptions {
  host?: string;
  port?: number;
  persistenceBackend?: 'in-memory' | 'postgres' | 'redis' | 'sqlite' | 'mongodb' | 'cloud-nosql';
  databaseUrl?: string;
  redisUrl?: string;
  redisMode?: 'coordination-only' | 'durable-explicit';
  sqlitePath?: string;
  mongoUrl?: string;
  mongoDatabaseName?: string;
  cloudNoSqlProvider?: 'dynamodb';
  dynamoDbEndpoint?: string;
  dynamoDbRegion?: string;
  dynamoDbTableName?: string;
  /**
   * Phase H — caller-supplied ambient runtime. When omitted, the demo
   * builds one with `weaveSqlitePersistence` (when
   * `LIVE_AGENTS_DEMO_RUNTIME_SQLITE_PATH` is set) or
   * `weaveInMemoryPersistence`, plus `envSecretResolver()` and
   * `weaveConsoleTracer()`. The runtime is propagated to every
   * `ExecutionContext` the server constructs (e.g. heartbeat ticks).
   */
  runtime?: WeaveRuntime;
  /** Override the default runtime persistence path. Falls back to
   * `LIVE_AGENTS_DEMO_RUNTIME_SQLITE_PATH`; in-memory when neither set. */
  runtimePersistencePath?: string;
}

export interface LiveAgentsDemoHandle {
  server: Server;
  stateStore: StateStore;
  runtime: WeaveRuntime;
  stop(): Promise<void>;
}

export async function createLiveAgentsDemo(options: LiveAgentsDemoOptions = {}): Promise<LiveAgentsDemoHandle> {
  const configuredBackend =
    options.persistenceBackend ??
    (process.env['LIVE_AGENTS_DEMO_PERSISTENCE_BACKEND'] as
      | 'in-memory'
      | 'postgres'
      | 'redis'
      | 'sqlite'
      | 'mongodb'
      | 'cloud-nosql'
      | undefined);

  const databaseUrl = options.databaseUrl ?? process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const redisUrl = options.redisUrl ?? process.env['LIVE_AGENTS_DEMO_REDIS_URL'];
  const sqlitePath = options.sqlitePath ?? process.env['LIVE_AGENTS_DEMO_SQLITE_PATH'];
  const mongoUrl = options.mongoUrl ?? process.env['LIVE_AGENTS_DEMO_MONGODB_URL'];
  const mongoDatabaseName = options.mongoDatabaseName ?? process.env['LIVE_AGENTS_DEMO_MONGODB_DATABASE'] ?? 'live_agents_demo';
  const cloudNoSqlProvider =
    options.cloudNoSqlProvider ??
    (process.env['LIVE_AGENTS_DEMO_CLOUD_NOSQL_PROVIDER'] as 'dynamodb' | undefined) ??
    'dynamodb';
  const dynamoDbEndpoint = options.dynamoDbEndpoint ?? process.env['LIVE_AGENTS_DEMO_DYNAMODB_ENDPOINT'];
  const dynamoDbRegion = options.dynamoDbRegion ?? process.env['LIVE_AGENTS_DEMO_DYNAMODB_REGION'] ?? 'us-east-1';
  const dynamoDbTableName = options.dynamoDbTableName ?? process.env['LIVE_AGENTS_DEMO_DYNAMODB_TABLE'] ?? 'la_entities';
  const redisMode =
    options.redisMode ??
    (process.env['LIVE_AGENTS_DEMO_REDIS_MODE'] as 'coordination-only' | 'durable-explicit' | undefined) ??
    'coordination-only';

  // Resolution order preserves backward compatibility while allowing explicit overrides.
  const resolvedBackend = configuredBackend ?? (databaseUrl ? 'postgres' : 'in-memory');

  let store:
    | StateStore
    | PostgresStateStore
    | RedisStateStore
    | SqliteStateStore
    | MongoDbStateStore
    | CloudNoSqlStateStore;
  if (resolvedBackend === 'postgres') {
    if (!databaseUrl) {
      throw new Error('LIVE_AGENTS_DEMO_DATABASE_URL is required when persistence backend is postgres');
    }
    store = await weavePostgresStateStore({ url: databaseUrl });
  } else if (resolvedBackend === 'sqlite') {
    if (!sqlitePath) {
      throw new Error('LIVE_AGENTS_DEMO_SQLITE_PATH is required when persistence backend is sqlite');
    }
    store = await weaveSqliteStateStore({ path: sqlitePath });
  } else if (resolvedBackend === 'mongodb') {
    if (!mongoUrl) {
      throw new Error('LIVE_AGENTS_DEMO_MONGODB_URL is required when persistence backend is mongodb');
    }
    store = await weaveMongoDbStateStore({
      url: mongoUrl,
      databaseName: mongoDatabaseName,
      collectionName: 'la_entities',
    });
  } else if (resolvedBackend === 'cloud-nosql') {
    store = await weaveCloudNoSqlStateStore({
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
    store = weaveRedisStateStore({
      url: redisUrl,
      mode: redisMode,
      keyPrefix: 'weave:live-agents-demo',
    });
    const initialize = (store as { initialize?: () => Promise<void> }).initialize;
    if (initialize) {
      await initialize.call(store);
    }
  } else {
    store = await createInMemoryDemoStateStore();
  }

  // Phase H — ambient runtime. Default: durable SQLite KV when a path is
  // configured (env or option), in-memory KV otherwise. Caller can pass a
  // fully-built `runtime` for full control.
  const runtime: WeaveRuntime = options.runtime ?? (() => {
    const persistencePath =
      options.runtimePersistencePath ?? process.env['LIVE_AGENTS_DEMO_RUNTIME_SQLITE_PATH'];
    const persistence: RuntimePersistenceSlot = persistencePath
      ? weaveSqlitePersistence({ path: persistencePath })
      : weaveInMemoryPersistence();
    return weaveRuntime({
      tracer: 'noop',
      secrets: envSecretResolver(),
      persistence,
      installDefaultTracer: false,
    });
  })();

  const app = createLiveAgentsDemoServer({
    stateStore: store,
    host: options.host,
    port: options.port,
    runtime,
  });

  if (!app.server.listening) {
    await new Promise<void>((resolve, reject) => {
      app.server.once('listening', () => resolve());
      app.server.once('error', (error) => reject(error));
    });
  }

  return {
    server: app.server,
    stateStore: app.stateStore,
    runtime,
    async stop() {
      await app.stop();
      const close = (store as { close?: () => Promise<void> }).close;
      if (close) {
        await close.call(store);
      }
    },
  };
}
