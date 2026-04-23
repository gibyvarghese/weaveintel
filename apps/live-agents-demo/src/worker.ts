import {
  createActionExecutor,
  createHeartbeat,
  weavePostgresStateStore,
} from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';
import { createInMemoryDemoStateStore } from './inmemory-state-store.js';

async function main() {
  const databaseUrl = process.env['LIVE_AGENTS_DEMO_DATABASE_URL'];
  const stateStore = databaseUrl
    ? await weavePostgresStateStore({ url: databaseUrl })
    : await createInMemoryDemoStateStore();

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
