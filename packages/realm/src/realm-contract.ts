// SPDX-License-Identifier: MIT
/**
 * Conformance contract for any `RealmConfigStore` + the resolver on top of it. Framework-agnostic:
 * returns pass/fail results. The in-memory store and the SQL store (SQLite + Postgres) all run this
 * exact suite. Contexts are supplied by the caller (built from a tenant tree) so the store stays
 * decoupled from identity.
 */
import { createRealmResolver, type Payload, type RealmConfigStore } from './realm-store.js';
import type { RealmContext } from './context.js';
import { driftState } from './realm-record.js';

export interface ContractCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}
export function realmContractPassed(r: ContractCheck[]): boolean {
  return r.length > 0 && r.every((x) => x.ok);
}

/**
 * The fixed tenant tree the contract resolves against:
 *   acme (root, d0) → emea (d1) → uk (d2)
 *   acme → apac (d1)
 * Contexts are hand-built so no identity dependency is needed.
 */
export const CTX = {
  global: { tenantId: null, depth: -1, lineage: [] } as RealmContext,
  acme: { tenantId: 'acme', depth: 0, lineage: [{ tenantId: 'acme', depth: 0 }] } as RealmContext,
  emea: {
    tenantId: 'emea',
    depth: 1,
    lineage: [{ tenantId: 'acme', depth: 0 }, { tenantId: 'emea', depth: 1 }],
  } as RealmContext,
  uk: {
    tenantId: 'uk',
    depth: 2,
    lineage: [{ tenantId: 'acme', depth: 0 }, { tenantId: 'emea', depth: 1 }, { tenantId: 'uk', depth: 2 }],
  } as RealmContext,
  apac: {
    tenantId: 'apac',
    depth: 1,
    lineage: [{ tenantId: 'acme', depth: 0 }, { tenantId: 'apac', depth: 1 }],
  } as RealmContext,
};

export interface RealmContractOptions {
  readonly makeStore: () => Promise<RealmConfigStore> | RealmConfigStore;
  readonly cleanup?: (s: RealmConfigStore) => Promise<void> | void;
}

export async function runRealmContract(opts: RealmContractOptions): Promise<ContractCheck[]> {
  const results: ContractCheck[] = [];
  const check = async (name: string, fn: (s: RealmConfigStore) => Promise<void>): Promise<void> => {
    let s: RealmConfigStore | undefined;
    try {
      s = await opts.makeStore();
      await fn(s);
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally {
      if (s && opts.cleanup) await opts.cleanup(s);
    }
  };
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  };
  const rejects = async (fn: () => Promise<unknown>, m: string): Promise<void> => {
    try {
      await fn();
    } catch {
      return;
    }
    throw new Error(`${m} — did not throw`);
  };

  // ── global-only world (single-org / community): everyone gets the default ────────────────────────
  await check('global default resolves for every tenant when nobody has customized', async (s) => {
    await s.publishGlobal('assistant.general', { template: 'You are helpful.' });
    const r = createRealmResolver({ store: s });
    for (const ctx of [CTX.global, CTX.acme, CTX.emea, CTX.uk]) {
      const eff = await r.resolve('assistant.general', ctx);
      eq([eff?.['template'], eff?.realmProvenance.kind], ['You are helpful.', 'global'], `resolve for ${ctx.tenantId}`);
    }
  });

  // ── own override wins over global, only for its owner ────────────────────────────────────────────
  await check("a tenant's own customization wins for it — and nobody else sees it", async (s) => {
    await s.publishGlobal('assistant.general', { template: 'GLOBAL' });
    await s.customize('assistant.general', CTX.uk, { template: 'UK EDIT' });
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('assistant.general', CTX.uk))?.['template'], 'UK EDIT', 'uk sees its edit');
    eq((await r.resolve('assistant.general', CTX.uk))?.realmProvenance.kind, 'own_override', 'provenance own_override');
    eq((await r.resolve('assistant.general', CTX.emea))?.['template'], 'GLOBAL', 'sibling/parent still global');
    eq((await r.resolve('assistant.general', CTX.apac))?.['template'], 'GLOBAL', 'unrelated tenant still global');
  });

  // ── nearest owner wins, and privacy hides the parent's copy ──────────────────────────────────────
  await check('nearest owner wins; a parent PRIVATE override is invisible to children', async (s) => {
    await s.publishGlobal('k', { v: 'GLOBAL' });
    await s.customize('k', CTX.emea, { v: 'EMEA EDIT' }); // private by default
    const r = createRealmResolver({ store: s });
    // uk is emea's child, but emea's edit is private → uk falls through to global.
    eq((await r.resolve('k', CTX.uk))?.['v'], 'GLOBAL', 'private parent override hidden → global');
    eq((await r.resolve('k', CTX.emea))?.['v'], 'EMEA EDIT', 'emea sees its own');
  });

  await check("a parent's SHARED override is inherited by descendants (nearest wins over global)", async (s) => {
    await s.publishGlobal('k', { v: 'GLOBAL' });
    const emeaEdit = await s.customize('k', CTX.emea, { v: 'EMEA SHARED' });
    await s.setShareMode(emeaEdit.id, 'subtree');
    const r = createRealmResolver({ store: s });
    const uk = await r.resolve('k', CTX.uk);
    eq(uk?.['v'], 'EMEA SHARED', 'uk inherits the shared parent override');
    eq(uk?.realmProvenance.kind, 'inherited', 'provenance inherited');
    eq((uk?.realmProvenance as { distance: number }).distance, 1, 'distance = 1 level up');
    // apac is not under emea → still global.
    eq((await r.resolve('k', CTX.apac))?.['v'], 'GLOBAL', 'cousin unaffected');
  });

  await check("'children' share reaches only direct children, not grandchildren", async (s) => {
    await s.publishGlobal('k', { v: 'GLOBAL' });
    const acmeEdit = await s.customize('k', CTX.acme, { v: 'ACME CHILDREN' });
    await s.setShareMode(acmeEdit.id, 'children');
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('k', CTX.emea))?.['v'], 'ACME CHILDREN', 'direct child inherits');
    eq((await r.resolve('k', CTX.uk))?.['v'], 'GLOBAL', 'grandchild does NOT (children-only)');
  });

  // ── own override closer than a shared ancestor override ──────────────────────────────────────────
  await check('own override beats an inherited shared override', async (s) => {
    await s.publishGlobal('k', { v: 'GLOBAL' });
    const acmeEdit = await s.customize('k', CTX.acme, { v: 'ACME' });
    await s.setShareMode(acmeEdit.id, 'subtree');
    await s.customize('k', CTX.uk, { v: 'UK' });
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('k', CTX.uk))?.['v'], 'UK', "uk's own beats acme's shared");
    eq((await r.resolve('k', CTX.emea))?.['v'], 'ACME', 'emea (no own) inherits acme shared');
  });

  // ── native records (no global equivalent) ────────────────────────────────────────────────────────
  await check('a tenant-native record (no global) resolves as native', async (s) => {
    await s.putNative('tenant.only', 'uk', { v: 'UK ONLY' });
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('tenant.only', CTX.uk))?.realmProvenance.kind, 'native', 'native provenance');
    eq(await r.resolve('tenant.only', CTX.apac), null, 'invisible to others (no global)');
  });

  // ── drift (Base / Local / Remote) ────────────────────────────────────────────────────────────────
  await check('drift: in_sync → customized → stale → diverged', async (s) => {
    await s.publishGlobal('k', { v: 'V1' }); // base
    await s.customize('k', CTX.uk, { v: 'V1' }); // fork with identical content → in_sync
    const r = createRealmResolver({ store: s });
    const prov = async () => ((await r.resolve('k', CTX.uk))!.realmProvenance as { drift: string }).drift;
    eq(await prov(), 'in_sync', 'fork identical to base');
    await s.customize('k', CTX.uk, { v: 'V1-uk' }); // local edit
    eq(await prov(), 'customized', 'local edit, source unchanged');
    await s.customize('k', CTX.uk, { v: 'V1' }); // revert local to base
    await s.publishGlobal('k', { v: 'V2' }); // source moves on
    eq(await prov(), 'stale', 'local unchanged, source moved');
    await s.customize('k', CTX.uk, { v: 'V2-uk' }); // and now local edits too
    eq(await prov(), 'diverged', 'both changed');
  });

  await check('listEffective returns exactly one record per logical key', async (s) => {
    await s.publishGlobal('a', { v: 'A' });
    await s.publishGlobal('b', { v: 'B' });
    await s.customize('a', CTX.uk, { v: 'A-uk' });
    const r = createRealmResolver({ store: s });
    const eff = await r.listEffective(CTX.uk);
    eq(eff.map((e) => e.logicalKey), ['a', 'b'], 'one per key, sorted');
    eq(eff.map((e) => e.realmProvenance.kind), ['own_override', 'global'], 'a=own, b=global');
  });

  // ── negative ─────────────────────────────────────────────────────────────────────────────────────
  await check('customize with nothing to fork throws', async (s) => {
    await rejects(() => s.customize('missing.key', CTX.uk, { v: 'x' }), 'no base');
  });
  await check('global caller sees only global records', async (s) => {
    await s.publishGlobal('k', { v: 'G' });
    await s.putNative('k2', 'uk', { v: 'UK' });
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('k', CTX.global))?.['v'], 'G', 'global visible');
    eq(await r.resolve('k2', CTX.global), null, 'tenant-native invisible to global');
  });

  // ── security / isolation ─────────────────────────────────────────────────────────────────────────
  await check('SECURITY: sibling tenants cannot read each other’s private overrides', async (s) => {
    await s.publishGlobal('secret.prompt', { v: 'GLOBAL' });
    await s.customize('secret.prompt', CTX.emea, { v: 'EMEA CONFIDENTIAL' });
    await s.customize('secret.prompt', CTX.apac, { v: 'APAC CONFIDENTIAL' });
    const r = createRealmResolver({ store: s });
    eq((await r.resolve('secret.prompt', CTX.emea))?.['v'], 'EMEA CONFIDENTIAL', 'emea sees own');
    eq((await r.resolve('secret.prompt', CTX.apac))?.['v'], 'APAC CONFIDENTIAL', 'apac sees own');
    // Neither leaks to the other; a child of emea never sees apac's, and vice-versa.
    eq((await r.resolve('secret.prompt', CTX.uk))?.['v'], 'GLOBAL', "emea's child sees neither sibling's secret");
    const visForApac = await s.listVisible(CTX.apac, ['secret.prompt']);
    eq(visForApac.some((x) => (x as unknown as { v: string }).v === 'EMEA CONFIDENTIAL'), false, 'apac candidate set excludes emea secret');
  });

  await check('drift helper matches the state table', () => {
    eq(driftState('B', 'B', 'B'), 'in_sync', 'in_sync');
    eq(driftState('B', 'L', 'B'), 'customized', 'customized');
    eq(driftState('B', 'B', 'R'), 'stale', 'stale');
    eq(driftState('B', 'L', 'R'), 'diverged', 'diverged');
    eq(driftState(null, 'L', 'R'), 'not_a_fork', 'no base');
    return Promise.resolve();
  });

  return results;
}
