import type { Server } from 'node:http';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';
import { createPostgresStateStore, type PostgresStateStore } from './postgres-state-store.js';
import { createLiveAgentsDemoServer } from './app.js';
import type { StateStore } from '@weaveintel/live-agents';

export interface LiveAgentsDemoOptions {
  host?: string;
  port?: number;
  databaseUrl?: string;
}

export interface LiveAgentsDemoHandle {
  server: Server;
  stateStore: StateStore;
  stop(): Promise<void>;
}

export async function createLiveAgentsDemo(options: LiveAgentsDemoOptions = {}): Promise<LiveAgentsDemoHandle> {
  const databaseUrl = options.databaseUrl ?? process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const store: StateStore | PostgresStateStore = databaseUrl
    ? await createPostgresStateStore(databaseUrl)
    : await createInMemoryDemoStateStore();

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
