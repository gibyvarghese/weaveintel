import type { Server } from 'node:http';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';
import { createLiveAgentsDemoServer } from './app.js';
import {
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

export interface LiveAgentsDemoOptions {
  host?: string;
  port?: number;
  persistenceBackend?: 'in-memory' | 'postgres' | 'redis' | 'sqlite' | 'mongodb';
  databaseUrl?: string;
  redisUrl?: string;
  redisMode?: 'coordination-only' | 'durable-explicit';
  sqlitePath?: string;
  mongoUrl?: string;
  mongoDatabaseName?: string;
}

export interface LiveAgentsDemoHandle {
  server: Server;
  stateStore: StateStore;
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
      | undefined);

  const databaseUrl = options.databaseUrl ?? process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const redisUrl = options.redisUrl ?? process.env['LIVE_AGENTS_DEMO_REDIS_URL'];
  const sqlitePath = options.sqlitePath ?? process.env['LIVE_AGENTS_DEMO_SQLITE_PATH'];
  const mongoUrl = options.mongoUrl ?? process.env['LIVE_AGENTS_DEMO_MONGODB_URL'];
  const mongoDatabaseName = options.mongoDatabaseName ?? process.env['LIVE_AGENTS_DEMO_MONGODB_DATABASE'] ?? 'live_agents_demo';
  const redisMode =
    options.redisMode ??
    (process.env['LIVE_AGENTS_DEMO_REDIS_MODE'] as 'coordination-only' | 'durable-explicit' | undefined) ??
    'coordination-only';

  // Resolution order preserves backward compatibility while allowing explicit overrides.
  const resolvedBackend = configuredBackend ?? (databaseUrl ? 'postgres' : 'in-memory');

  let store: StateStore | PostgresStateStore | RedisStateStore | SqliteStateStore | MongoDbStateStore;
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

  const app = createLiveAgentsDemoServer({
    stateStore: store,
    host: options.host,
    port: options.port,
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
    async stop() {
      await app.stop();
      const close = (store as { close?: () => Promise<void> }).close;
      if (close) {
        await close.call(store);
      }
    },
  };
}
