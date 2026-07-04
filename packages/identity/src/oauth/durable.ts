/**
 * @weaveintel/identity/oauth — durable OAuth flow-state store.
 *
 * `InMemoryOAuthStateStore` (in `oauth.ts`) loses every pending
 * authorization-code exchange on restart — users see "invalid state".
 * `createDurableOAuthStateStore({runtime?, namespace?})` writes flow state
 * to `runtime.persistence.kv` (Phase 4) so the callback survives restarts.
 *
 * The async surface mirrors the sync `OAuthStateStore` but every method
 * returns a `Promise`. Callers using the async store must `await`.
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { OAuthFlowState } from './oauth.js';

export interface AsyncOAuthStateStore {
  set(key: string, data: OAuthFlowState): Promise<void>;
  get(key: string): Promise<OAuthFlowState | null>;
  delete(key: string): Promise<void>;
}

export interface DurableOAuthStateStoreOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

export function createDurableOAuthStateStore(
  opts: DurableOAuthStateStoreOptions = {},
): AsyncOAuthStateStore {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'oauth-flow';

  return {
    async set(key, data) {
      const ttlMs = Math.max(0, data.expiresAt - Date.now());
      await kv.set(`${ns}:${key}`, JSON.stringify(data), ttlMs > 0 ? { ttlMs } : undefined);
    },
    async get(key) {
      const v = await kv.get(`${ns}:${key}`);
      if (!v) return null;
      try {
        const data = JSON.parse(v) as OAuthFlowState;
        if (Date.now() > data.expiresAt) {
          await kv.delete(`${ns}:${key}`);
          return null;
        }
        return data;
      } catch {
        return null;
      }
    },
    async delete(key) { await kv.delete(`${ns}:${key}`); },
  };
}
