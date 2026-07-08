// SPDX-License-Identifier: MIT
/**
 * Conformance contract for any `TenantHierarchyStore`. Framework-agnostic: it returns a list of
 * pass/fail results, so a Vitest/Jest/node:test file can assert `contractPassed(results)`. The
 * in-memory reference and the SQL store (on real SQLite *and* real Postgres) all run this exact suite,
 * which is how we guarantee they behave identically.
 */
import {
  DuplicateTenantError,
  TenantCycleError,
  TenantHasChildrenError,
  TenantNotFoundError,
  type TenantHierarchyStore,
} from './tenant-hierarchy.js';

export interface ContractCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface TenantHierarchyContractOptions {
  /** Make a fresh, empty store for each check. */
  readonly makeStore: () => Promise<TenantHierarchyStore> | TenantHierarchyStore;
  /** Optional teardown after each check (drop table, close pool, …). */
  readonly cleanup?: (store: TenantHierarchyStore) => Promise<void> | void;
}

export function contractPassed(results: ContractCheck[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}

/** Run the whole suite. Every check gets its own fresh store. */
export async function runTenantHierarchyContract(opts: TenantHierarchyContractOptions): Promise<ContractCheck[]> {
  const results: ContractCheck[] = [];
  const check = async (name: string, fn: (s: TenantHierarchyStore) => Promise<void>): Promise<void> => {
    let store: TenantHierarchyStore | undefined;
    try {
      store = await opts.makeStore();
      await fn(store);
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally {
      if (store && opts.cleanup) await opts.cleanup(store);
    }
  };

  const eq = (a: unknown, b: unknown, msg: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  };
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(msg);
  };
  const ids = (ts: { id: string }[]): string[] => ts.map((t) => t.id);
  const rejects = async (fn: () => Promise<unknown>, ErrType: new (...a: never[]) => Error, msg: string): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ErrType) return;
      throw new Error(`${msg} — threw ${e instanceof Error ? e.name : String(e)}, wanted ${ErrType.name}`);
    }
    throw new Error(`${msg} — did not throw`);
  };

  // ── positive: build a tree, check path/depth ─────────────────────────────────────────────────
  await check('create builds correct path + depth for root/child/grandchild', async (s) => {
    const acme = await s.create({ id: 'acme', name: 'Acme Corp' });
    eq([acme.path, acme.depth, acme.parentTenantId], ['/acme/', 0, null], 'root');
    const emea = await s.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    eq([emea.path, emea.depth, emea.parentTenantId], ['/acme/emea/', 1, 'acme'], 'child');
    const uk = await s.create({ id: 'uk', name: 'Acme UK', parentTenantId: 'emea' });
    eq([uk.path, uk.depth, uk.parentTenantId], ['/acme/emea/uk/', 2, 'emea'], 'grandchild');
  });

  await check('get / getByPath round-trip; get(missing)=null', async (s) => {
    const a = await s.create({ id: 'a', name: 'A' });
    eq((await s.get('a'))?.id, 'a', 'get by id');
    eq((await s.getByPath('/a/'))?.id, 'a', 'get by path');
    eq(await s.get('nope'), null, 'missing → null');
    eq(await s.getByPath('/nope/'), null, 'missing path → null');
    void a;
  });

  await check('roots / children', async (s) => {
    await s.create({ id: 'r1', name: 'R1' });
    await s.create({ id: 'r2', name: 'R2' });
    await s.create({ id: 'c1', name: 'C1', parentTenantId: 'r1' });
    await s.create({ id: 'c2', name: 'C2', parentTenantId: 'r1' });
    eq(ids(await s.roots()), ['r1', 'r2'], 'two roots');
    eq(ids(await s.children('r1')), ['c1', 'c2'], 'two children of r1');
    eq(ids(await s.children('r2')), [], 'r2 has no children');
  });

  await check('ancestors are root→parent, exclude self', async (s) => {
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await s.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    eq(ids(await s.ancestors('uk')), ['acme', 'emea'], 'uk ancestors');
    eq(ids(await s.ancestors('acme')), [], 'root has no ancestors');
  });

  await check('descendants are strict subtree; subtree includes self; ordered by depth', async (s) => {
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await s.create({ id: 'apac', name: 'APAC', parentTenantId: 'acme' });
    await s.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    // Ordering is deterministic: depth ASC, then path ASC (alphabetical). At depth 1, apac < emea.
    eq(ids(await s.descendants('acme')), ['apac', 'emea', 'uk'], 'descendants strict, depth-then-path ordered');
    eq(ids(await s.subtree('acme')), ['acme', 'apac', 'emea', 'uk'], 'subtree includes self');
    eq(ids(await s.descendants('acme', { maxDepth: 1 })), ['apac', 'emea'], 'maxDepth=1 → children only');
    eq(ids(await s.descendants('uk')), [], 'leaf has no descendants');
  });

  await check('descendants can filter by status', async (s) => {
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'a', name: 'A', parentTenantId: 'acme' });
    await s.create({ id: 'b', name: 'B', parentTenantId: 'acme' });
    await s.setStatus('b', 'archived');
    eq(ids(await s.descendants('acme', { statuses: ['active'] })), ['a'], 'only active');
    eq(ids(await s.descendants('acme', { statuses: ['archived'] })), ['b'], 'only archived');
  });

  // ── moves ────────────────────────────────────────────────────────────────────────────────────
  await check('reparent rebases the whole subtree (path + depth + parent pointer)', async (s) => {
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'globex', name: 'Globex' });
    await s.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await s.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    await s.reparent('emea', 'globex'); // acquisition: EMEA (and UK under it) moves to Globex
    const emea = await s.get('emea');
    const uk = await s.get('uk');
    eq([emea?.path, emea?.depth, emea?.parentTenantId], ['/globex/emea/', 1, 'globex'], 'moved node');
    eq([uk?.path, uk?.depth, uk?.parentTenantId], ['/globex/emea/uk/', 2, 'emea'], 'descendant rebased, parent unchanged');
    eq(ids(await s.descendants('acme')), [], 'old parent lost the subtree');
    eq(ids(await s.descendants('globex')), ['emea', 'uk'], 'new parent gained it');
  });

  await check('reparent to root (null parent)', async (s) => {
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await s.reparent('emea', null);
    const emea = await s.get('emea');
    eq([emea?.path, emea?.depth, emea?.parentTenantId], ['/emea/', 0, null], 'now a root');
    eq(ids(await s.roots()), ['acme', 'emea'], 'two roots');
  });

  await check('reparent does not disturb unrelated siblings', async (s) => {
    await s.create({ id: 'root', name: 'Root' });
    await s.create({ id: 'a', name: 'A', parentTenantId: 'root' });
    await s.create({ id: 'b', name: 'B', parentTenantId: 'root' });
    const bBefore = await s.get('b');
    await s.reparent('a', null);
    eq(await s.get('b'), bBefore, 'sibling b untouched');
  });

  // ── negative ───────────────────────────────────────────────────────────────────────────────────
  await check('create under missing parent throws NotFound', async (s) => {
    await rejects(() => s.create({ id: 'x', name: 'X', parentTenantId: 'ghost' }), TenantNotFoundError, 'missing parent');
  });
  await check('duplicate id throws', async (s) => {
    await s.create({ id: 'dup', name: 'One' });
    await rejects(() => s.create({ id: 'dup', name: 'Two' }), DuplicateTenantError, 'duplicate id');
  });
  await check('ops on a missing tenant throw NotFound', async (s) => {
    await rejects(() => s.rename('ghost', 'X'), TenantNotFoundError, 'rename missing');
    await rejects(() => s.children('ghost'), TenantNotFoundError, 'children missing');
    await rejects(() => s.reparent('ghost', null), TenantNotFoundError, 'reparent missing');
  });
  await check('cycle prevention: cannot move a node under its own descendant', async (s) => {
    await s.create({ id: 'a', name: 'A' });
    await s.create({ id: 'b', name: 'B', parentTenantId: 'a' });
    await s.create({ id: 'c', name: 'C', parentTenantId: 'b' });
    await rejects(() => s.reparent('a', 'c'), TenantCycleError, 'a under its descendant c');
    await rejects(() => s.reparent('a', 'a'), TenantCycleError, 'a under itself');
  });
  await check('delete: leaf ok; parent without cascade throws; cascade removes subtree', async (s) => {
    await s.create({ id: 'a', name: 'A' });
    await s.create({ id: 'b', name: 'B', parentTenantId: 'a' });
    await s.create({ id: 'c', name: 'C', parentTenantId: 'b' });
    await rejects(() => s.delete('a'), TenantHasChildrenError, 'parent without cascade');
    await s.delete('c'); // leaf ok
    eq(await s.get('c'), null, 'leaf gone');
    await s.delete('a', { cascade: true });
    eq([await s.get('a'), await s.get('b')], [null, null], 'cascade removed subtree');
  });
  await check('invalid id (contains "/") is rejected', async (s) => {
    await rejects(() => Promise.resolve(s.create({ id: 'a/b', name: 'bad' })), Error, 'slash in id');
  });

  // ── security / correctness of prefix matching ──────────────────────────────────────────────────
  await check('SECURITY: sibling name that is a string-prefix is NOT a descendant', async (s) => {
    // '/acme/' must not accidentally match '/acme-corp/' — leading+trailing separators prevent this.
    await s.create({ id: 'acme', name: 'Acme' });
    await s.create({ id: 'acme-corp', name: 'Acme Corp (different root)' });
    await s.create({ id: 'sub', name: 'Sub', parentTenantId: 'acme' });
    eq(ids(await s.descendants('acme')), ['sub'], 'acme has exactly one descendant, not acme-corp');
  });
  await check('SECURITY: id containing LIKE wildcards (% and _) is stored literally, not as a wildcard', async (s) => {
    // An attacker-crafted id must not let one tenant read another tenant's subtree via LIKE injection.
    await s.create({ id: 'a', name: 'A' });
    await s.create({ id: 'a_x', name: 'Underscore sibling' }); // '_' is a LIKE single-char wildcard
    await s.create({ id: 'apct', name: 'Percent-ish sibling' });
    await s.create({ id: 'kid', name: 'Kid', parentTenantId: 'a' });
    // descendants('a') must return ONLY '/a/kid/', never the '_'/'%' siblings.
    eq(ids(await s.descendants('a')), ['kid'], 'wildcards in ids do not leak sibling subtrees');
  });

  // ── convenience ────────────────────────────────────────────────────────────────────────────────
  await check('ensureDefault is idempotent', async (s) => {
    const d1 = await s.ensureDefault();
    const d2 = await s.ensureDefault();
    eq([d1.id, d2.id, d1.createdAt === d2.createdAt], ['default', 'default', true], 'same default tenant');
    eq(await s.count(), 1, 'no duplicate');
  });
  await check('count reflects the tree', async (s) => {
    await s.create({ id: 'a', name: 'A' });
    await s.create({ id: 'b', name: 'B', parentTenantId: 'a' });
    eq(await s.count(), 2, 'two tenants');
  });
  await check('rename / setStatus / setMetadata persist', async (s) => {
    await s.create({ id: 'a', name: 'Old', metadata: { plan: 'free' } });
    await s.rename('a', 'New');
    await s.setStatus('a', 'suspended');
    await s.setMetadata('a', { region: 'eu' });
    const a = await s.get('a');
    eq([a?.name, a?.status, a?.metadata], ['New', 'suspended', { plan: 'free', region: 'eu' }], 'mutations persisted + metadata merged');
  });

  return results;
}
