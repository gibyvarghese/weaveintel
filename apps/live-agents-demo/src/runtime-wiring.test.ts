import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveAgentsDemo } from './index.js';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { RuntimeCapabilities } from '@weaveintel/core';

let handle: Awaited<ReturnType<typeof createLiveAgentsDemo>> | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

describe('Phase H — runtime wiring in live-agents-demo', () => {
  it('builds an in-memory runtime by default and exposes it on the handle', async () => {
    handle = await createLiveAgentsDemo({ port: 3621 });
    expect(handle.runtime).toBeDefined();
    expect(handle.runtime.has(RuntimeCapabilities.Persistence)).toBe(true);
    expect(handle.runtime.has(RuntimeCapabilities.Secrets)).toBe(true);
    expect(handle.runtime.has(RuntimeCapabilities.Observability)).toBe(true);
  });

  it('wires durable SQLite persistence when a path is provided', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'la-demo-phaseH-'));
    const dbPath = path.join(dir, 'runtime.sqlite');
    handle = await createLiveAgentsDemo({ port: 3622, runtimePersistencePath: dbPath });
    const slot = handle.runtime.persistence;
    expect(slot).toBeDefined();
    expect(slot?.kind).toBe('sqlite');

    // Direct round-trip on the slot KV
    await slot!.kv.set('phaseH:test', 'wired');
    expect(await slot!.kv.get('phaseH:test')).toBe('wired');

    // Survives a reconstruction of the same backend
    const reopened = weaveSqlitePersistence({ path: dbPath });
    expect(await reopened.kv.get('phaseH:test')).toBe('wired');
  });

  it('runs a heartbeat tick with runtime-propagated context', async () => {
    handle = await createLiveAgentsDemo({ port: 3623 });
    const res = await fetch(`http://127.0.0.1:3623/api/heartbeat/run-once`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processedAgents?: unknown };
    expect(body).toBeDefined();
  });
});
