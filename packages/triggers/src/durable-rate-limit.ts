/**
 * @weaveintel/triggers — durable per-trigger rate-limit windows.
 *
 * The in-process `RateLimiter` in `dispatcher.ts` resets every per-trigger
 * 1-minute window on restart, allowing bursts. `createDurableTriggerRateLimiter`
 * persists windows via `runtime.persistence.kv` so a restart cannot reset
 * a quota mid-window.
 *
 * Pass into `createTriggerDispatcher` via the `rateLimiter` option (see
 * `dispatcher.ts` for the interface; the durable variant is structurally
 * compatible — `check(triggerId, perMinute)` returning a Promise<boolean>).
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';

interface PersistedWindow {
  startedAt: number;
  count: number;
}

export interface DurableTriggerRateLimiter {
  check(triggerId: string, perMinute: number): Promise<boolean>;
  reset(triggerId: string): Promise<void>;
}

export interface DurableTriggerRateLimiterOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

export function createDurableTriggerRateLimiter(
  opts: DurableTriggerRateLimiterOptions = {},
): DurableTriggerRateLimiter {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'trigger-rate';

  return {
    async check(triggerId, perMinute) {
      if (!Number.isFinite(perMinute) || perMinute <= 0) return true;
      const now = Date.now();
      const raw = await kv.get(`${ns}:${triggerId}`);
      let cur: PersistedWindow | undefined;
      if (raw) {
        try { cur = JSON.parse(raw) as PersistedWindow; } catch { /* malformed */ }
      }
      if (!cur || now - cur.startedAt >= 60_000) {
        await kv.set(`${ns}:${triggerId}`, JSON.stringify({ startedAt: now, count: 1 }));
        return true;
      }
      if (cur.count >= perMinute) return false;
      cur.count += 1;
      await kv.set(`${ns}:${triggerId}`, JSON.stringify(cur));
      return true;
    },
    async reset(triggerId) { await kv.delete(`${ns}:${triggerId}`); },
  };
}
