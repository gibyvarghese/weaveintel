/**
 * @weaveintel/tools-browser — durable pending-handoff store.
 *
 * The module-level `pendingHandoffs` Map in `mcp-auth.ts` loses every
 * in-flight interactive auth on restart. `createDurableBrowserHandoffStore`
 * keeps the same semantics (taskId-keyed) on top of `runtime.persistence.kv`.
 *
 * Apps that want durable handoffs construct the store at boot and use it
 * directly — the in-memory module map remains for tools whose call sites
 * never see a runtime.
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { HandoffRequest } from './auth-types.js';

export interface DurableBrowserHandoffStore {
  set(taskId: string, request: HandoffRequest): Promise<void>;
  get(taskId: string): Promise<HandoffRequest | undefined>;
  resolve(taskId: string): Promise<boolean>;
  list(): Promise<readonly HandoffRequest[]>;
}

export interface DurableBrowserHandoffStoreOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

export function createDurableBrowserHandoffStore(
  opts: DurableBrowserHandoffStoreOptions = {},
): DurableBrowserHandoffStore {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'browser-handoff';

  return {
    async set(taskId, request) {
      await kv.set(`${ns}:${taskId}`, JSON.stringify(request));
    },
    async get(taskId) {
      const v = await kv.get(`${ns}:${taskId}`);
      if (!v) return undefined;
      try { return JSON.parse(v) as HandoffRequest; } catch { return undefined; }
    },
    async resolve(taskId) {
      return kv.delete(`${ns}:${taskId}`);
    },
    async list() {
      const entries = await kv.list(`${ns}:`);
      const out: HandoffRequest[] = [];
      for (const e of entries) {
        try { out.push(JSON.parse(e.value) as HandoffRequest); } catch { /* skip */ }
      }
      return out;
    },
  };
}
