/**
 * Redis-backed StepLockStore.
 *
 * Layout:
 *   wf_lock:s:<runId>:<stepId>   STRING JSON({state, lockedAt, doneAt?, output?})
 *   wf_lock:run:<runId>          SET of "<runId>:<stepId>" strings
 */
import type { RedisClientType } from 'redis';
import type { StepLockStore } from './step-lock-store.js';

export interface WeaveRedisStepLockStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

interface State {
  state: 'locked' | 'done';
  lockedAt: string;
  doneAt?: string;
  output?: unknown;
}

export function weaveRedisStepLockStore(opts: WeaveRedisStepLockStoreOptions): StepLockStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_lock';
  const sKey = (runId: string, stepId: string) => `${prefix}:s:${runId}:${stepId}`;
  const runKey = (runId: string) => `${prefix}:run:${runId}`;

  async function read(runId: string, stepId: string): Promise<State | null> {
    const raw = await c.get(sKey(runId, stepId));
    return raw ? (JSON.parse(raw) as State) : null;
  }

  return {
    async lock(runId, stepId) {
      const ok = await c.set(sKey(runId, stepId), JSON.stringify({ state: 'locked', lockedAt: new Date().toISOString() } satisfies State), { NX: true });
      if (ok) await c.sAdd(runKey(runId), `${runId}:${stepId}`);
    },
    async markDone(runId, stepId, output) {
      const existing = await read(runId, stepId);
      const next: State = {
        state: 'done',
        lockedAt: existing?.lockedAt ?? new Date().toISOString(),
        doneAt: new Date().toISOString(),
        output: output ?? null,
      };
      await c.set(sKey(runId, stepId), JSON.stringify(next));
      await c.sAdd(runKey(runId), `${runId}:${stepId}`);
    },
    async isDone(runId, stepId) {
      const s = await read(runId, stepId);
      if (s?.state === 'done') return { done: true, output: s.output };
      return { done: false };
    },
    async isLocked(runId, stepId) {
      const exists = await c.exists(sKey(runId, stepId));
      return exists > 0;
    },
    async clear(runId) {
      const members = await c.sMembers(runKey(runId));
      if (members.length) {
        const keys = members.map((m) => {
          const [r, s] = m.split(':', 2);
          return sKey(r ?? '', s ?? '');
        });
        await c.del(keys);
      }
      await c.del(runKey(runId));
    },
  };
}
