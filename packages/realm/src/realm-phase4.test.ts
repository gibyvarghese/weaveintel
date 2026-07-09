// SPDX-License-Identifier: MIT
/**
 * Phase 4 — sharing down the tree (blast radius) + promoting a fork up to the global default, hermetic.
 */
import { describe, it, expect } from 'vitest';
import { blastRadius, promoteFork, payloadOf, type DescendantNode } from './realm-share.js';
import { createInMemoryRealmStore, createRealmResolver } from './realm-store.js';
import { createInMemoryVersionLog } from './realm-version.js';
import type { RealmContext } from './context.js';

const rootCtx = (id: string): RealmContext => ({ tenantId: id, depth: 0, lineage: [{ tenantId: id, depth: 0 }] });

describe('blastRadius (pure) — who a Share reaches', () => {
  // emea (owner, depth 1) → uk, de (depth 2) → uk-london (depth 3)
  const desc: DescendantNode[] = [
    { tenantId: 'uk', depth: 2 }, { tenantId: 'de', depth: 2 }, { tenantId: 'uk-london', depth: 3 },
  ];
  it('private reaches nobody', () => {
    expect(blastRadius(1, desc, 'private', new Set())).toMatchObject({ inheriting: [], shadowed: [], outOfScope: 3, total: 3 });
  });
  it('children reaches direct children only; a forked child is shadowed', () => {
    expect(blastRadius(1, desc, 'children', new Set())).toMatchObject({ inheriting: ['de', 'uk'], outOfScope: 1 }); // uk-london out of scope
    expect(blastRadius(1, desc, 'children', new Set(['uk']))).toMatchObject({ inheriting: ['de'], shadowed: ['uk'], outOfScope: 1 });
  });
  it('subtree reaches the whole branch; forked descendants are shadowed', () => {
    expect(blastRadius(1, desc, 'subtree', new Set())).toMatchObject({ inheriting: ['de', 'uk', 'uk-london'], shadowed: [], outOfScope: 0 });
    expect(blastRadius(1, desc, 'subtree', new Set(['uk-london']))).toMatchObject({ inheriting: ['de', 'uk'], shadowed: ['uk-london'], outOfScope: 0 });
  });
});

describe('payloadOf — recover the app payload from a stored realm record', () => {
  it('drops the realm bookkeeping fields', () => {
    const rec = { id: 'x', realm: 'tenant', ownerTenantId: 'acme', logicalKey: 'k', originId: 'g', originHash: 'h', contentHash: 'c', trackMode: 'pin', shareMode: 'private', tone: 'formal', title: 'Hi' };
    expect(payloadOf(rec)).toEqual({ tone: 'formal', title: 'Hi' });
  });
});

describe('promoteFork — a good customization becomes everyone’s default', () => {
  it('publishes the fork content as the new global; other tenants get it; a version is recorded', async () => {
    const store = createInMemoryRealmStore<{ tone: string }>();
    const log = createInMemoryVersionLog<{ tone: string }>();
    const resolver = createRealmResolver({ store });

    await store.publishGlobal('brand.tone', { tone: 'neutral' });
    // Acme forks its own tone.
    const fork = await store.customize('brand.tone', rootCtx('acme'), { tone: 'warm-and-formal' });
    expect(fork.realm).toBe('tenant');

    // A curator promotes Acme's fork to the shared global default.
    await promoteFork(store, log, 'brand.tone', fork as unknown as Record<string, unknown> & { logicalKey: string });

    // An unrelated tenant now gets the promoted content from the global (no fork of its own).
    const forGlobex = await resolver.resolve('brand.tone', rootCtx('globex'));
    expect(forGlobex?.tone).toBe('warm-and-formal');
    expect(forGlobex?.realmProvenance.kind).toBe('global');

    // The promotion was versioned.
    expect((await log.latest('brand.tone', 'brand.tone'))?.payload.tone).toBe('warm-and-formal');

    // Acme still has its own fork (unchanged); promotion doesn't delete it.
    const forAcme = await resolver.resolve('brand.tone', rootCtx('acme'));
    expect(forAcme?.realmProvenance.kind).toBe('own_override');
  });
});
