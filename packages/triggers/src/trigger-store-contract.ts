// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link TriggerStore} adapter.
 *
 * A trigger store is where automation rules ("when X happens, do Y") and their firing history live. The
 * package ships an in-memory version and — after Phase 4 — one Drizzle-backed version that serves both
 * Postgres and SQLite. This single battery runs against all of them, proving they behave identically
 * behind the one port. It's framework-agnostic: it just calls the `describe`/`it`/`expect` you pass in.
 */
import type { Trigger, TriggerStore } from './dispatcher.js';

export interface TriggerContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toHaveLength(n: number): void;
    [k: string]: unknown;
  };
}

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

function mkTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: uid('trg'),
    key: uid('key'),
    enabled: true,
    source: { kind: 'manual', config: {} },
    target: { kind: 'workflow', config: { workflowId: 'wf-1' } },
    ...over,
  } as Trigger;
}

export function triggerStoreContract(make: () => Promise<TriggerStore> | TriggerStore, t: TriggerContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('TriggerStore contract', () => {
    let store: TriggerStore;
    beforeEach(async () => { store = await make(); });

    it('save → get / getByKey round-trips a rich trigger (JSON config, filter, inputMap, rateLimit, metadata)', async () => {
      const trg = mkTrigger({
        source: { kind: 'webhook', config: { path: '/hook', secret: 's' } },
        target: { kind: 'workflow', config: { workflowId: 'wf-42' } },
        filter: { expression: { '==': [{ var: 'type' }, 'order'] } },
        inputMap: { orderId: '$.id' },
        rateLimit: { perMinute: 10 },
        metadata: { label: 'orders' },
      });
      await store.save(trg);
      expect(await store.get(trg.id)).toEqual(trg);
      expect(await store.getByKey(trg.key)).toEqual(trg);
    });

    it('a minimal trigger round-trips with no phantom optional fields', async () => {
      const trg = mkTrigger();
      await store.save(trg);
      expect(await store.get(trg.id)).toEqual(trg);
    });

    it('save is an upsert on id — the enabled flag and config can be flipped', async () => {
      const trg = mkTrigger({ enabled: true });
      await store.save(trg);
      await store.save({ ...trg, enabled: false, source: { kind: 'manual', config: { changed: true } } });
      const got = await store.get(trg.id);
      expect(got?.enabled).toBe(false);
      expect((got?.source.config as { changed: boolean }).changed).toBe(true);
    });

    it('list returns saved triggers; delete removes just that one', async () => {
      const a = mkTrigger();
      const b = mkTrigger();
      await store.save(a);
      await store.save(b);
      const ids = (await store.list()).map((x) => x.id);
      expect(ids.includes(a.id) && ids.includes(b.id)).toBe(true);
      await store.delete(a.id);
      const after = (await store.list()).map((x) => x.id);
      expect(after.includes(a.id)).toBe(false);
      expect(await store.get(b.id)).toEqual(b);
    });

    it('owner / tenant / provenance round-trip; listByOwner is scoped', async () => {
      const owner = uid('owner');
      const mine = mkTrigger({ ownerPrincipalId: owner, tenantId: 'acme', provenance: { sourceRunId: 'run-1' } });
      const theirs = mkTrigger({ ownerPrincipalId: uid('other') });
      await store.save(mine);
      await store.save(theirs);
      const got = await store.get(mine.id);
      expect(got?.ownerPrincipalId).toBe(owner);
      expect(got?.tenantId).toBe('acme');
      expect(got?.provenance).toEqual({ sourceRunId: 'run-1' });
      expect((await store.listByOwner(owner)).map((x) => x.id)).toEqual([mine.id]);
    });

    it('recordInvocation + listInvocations: newest-first, filter by trigger/status, limit + offset', async () => {
      const trg = mkTrigger();
      await store.save(trg);
      for (let i = 0; i < 3; i++) {
        await store.recordInvocation({ id: `inv-${trg.id}-${i}`, triggerId: trg.id, firedAt: 1000 + i, sourceKind: 'manual', status: i === 2 ? 'filtered' : 'dispatched' });
      }
      const all = await store.listInvocations({ triggerId: trg.id });
      expect(all.map((x) => x.firedAt)).toEqual([1002, 1001, 1000]); // newest first
      expect((await store.listInvocations({ triggerId: trg.id, status: 'filtered' })).map((x) => x.firedAt)).toEqual([1002]);
      expect((await store.listInvocations({ triggerId: trg.id, limit: 2 })).map((x) => x.firedAt)).toEqual([1002, 1001]);
      expect((await store.listInvocations({ triggerId: trg.id, limit: 2, offset: 1 })).map((x) => x.firedAt)).toEqual([1001, 1000]);
    });

    it('get / getByKey on unknown ids return null', async () => {
      expect(await store.get('nope')).toBeNull();
      expect(await store.getByKey('nope')).toBeNull();
    });
  });
}
