import type { Server } from 'node:http';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';
import { createLiveAgentsDemoServer } from './app.js';
import {
  weaveRedisStateStore,
  weavePostgresStateStore,
  type PostgresStateStore,
  type RedisStateStore,
  type StateStore,
} from '@weaveintel/live-agents';

export interface LiveAgentsDemoOptions {
  host?: string;
  port?: number;
  persistenceBackend?: 'in-memory' | 'postgres' | 'redis';
  databaseUrl?: string;
  redisUrl?: string;
  redisMode?: 'coordination-only' | 'durable-explicit';
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
      | undefined);

  const databaseUrl = options.databaseUrl ?? process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const redisUrl = options.redisUrl ?? process.env['LIVE_AGENTS_DEMO_REDIS_URL'];
  const redisMode =
    options.redisMode ??
    (process.env['LIVE_AGENTS_DEMO_REDIS_MODE'] as 'coordination-only' | 'durable-explicit' | undefined) ??
    'coordination-only';

  // Resolution order preserves backward compatibility while allowing explicit overrides.
  const resolvedBackend = configuredBackend ?? (databaseUrl ? 'postgres' : 'in-memory');

  let store: StateStore | PostgresStateStore | RedisStateStore;
  if (resolvedBackend === 'postgres') {
    if (!databaseUrl) {
      throw new Error('LIVE_AGENTS_DEMO_DATABASE_URL is required when persistence backend is postgres');
    }
    store = await weavePostgresStateStore({ url: databaseUrl });
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
