// SPDX-License-Identifier: MIT
/**
 * Realm propose → review → promote (GAPS G-WI-14; platform-architecture §7.4 item 8).
 * Before this, realm had no propose step: anyone who could call `promoteFork` changed the global
 * default for every tenant on their own say-so.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryTaskQueue } from '@weaveintel/human-tasks';
import * as realm from './index.js';
import { createInMemoryRealmStore, createRealmResolver } from './realm-store.js';
import { createInMemoryVersionLog } from './realm-version.js';
import { blastRadius } from './realm-share.js';
import type { RealmContext } from './context.js';

const rootCtx = (id: string): RealmContext => ({ tenantId: id, depth: 0, lineage: [{ tenantId: id, depth: 0 }] });

async function setup() {
  const store = createInMemoryRealmStore<{ tone: string }>();
  const versionLog = createInMemoryVersionLog<{ tone: string }>();
  const queue = new InMemoryTaskQueue();
  const resolver = createRealmResolver({ store });
  await store.publishGlobal('brand.tone', { tone: 'neutral' });
  const fork = await store.customize('brand.tone', rootCtx('acme'), { tone: 'warm' });
  return { store, versionLog, queue, resolver, fork };
}

describe('proposeFork', () => {
  it('is exported by the package', () => {
    expect(typeof (realm as Record<string, unknown>)['proposeFork']).toBe('function');
    expect(typeof (realm as Record<string, unknown>)['decideForkProposal']).toBe('function');
  });

  it('opens a review task carrying base, fork and blast radius, and changes nothing yet', async () => {
    const { store, queue, resolver, fork } = await setup();
    const radius = blastRadius(0, [{ tenantId: 'acme-nz', depth: 1 }], 'children', new Set());
    const taskId = await realm.proposeFork(store, 'brand', fork, {
      queue,
      reviewer: 'platform-curators',
      proposedBy: 'alice',
      blastRadius: radius,
    });
    const task = await queue.get(taskId);
    expect(task?.type).toBe('approval');
    expect(task?.assignee).toBe('platform-curators');
    const ctx = (task?.data as { context: realm.ForkProposalData }).context;
    expect(ctx.base?.payload).toEqual({ tone: 'neutral' });
    expect(ctx.fork.payload).toEqual({ tone: 'warm' });
    expect(ctx.blastRadius?.inheriting).toEqual(['acme-nz']);
    expect((await resolver.resolve('brand.tone', rootCtx('globex')))?.tone).toBe('neutral');
  });

  it('promotes on approval by a second person and records a version', async () => {
    const { store, versionLog, queue, resolver, fork } = await setup();
    const taskId = await realm.proposeFork(store, 'brand', fork.id, { queue, reviewer: 'bob', proposedBy: 'alice' });
    const out = await realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'bob', approved: true });
    expect(out.outcome).toBe('promoted');
    expect((await resolver.resolve('brand.tone', rootCtx('globex')))?.tone).toBe('warm');
    expect((await versionLog.latest('brand', 'brand.tone'))?.publishedBy).toBe('bob');
    expect((await queue.get(taskId))?.status).toBe('completed');
  });

  it('refuses self-approval', async () => {
    const { store, versionLog, queue, fork } = await setup();
    const taskId = await realm.proposeFork(store, 'brand', fork, { queue, reviewer: 'alice', proposedBy: 'alice' });
    await expect(
      realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'alice', approved: true }),
    ).rejects.toMatchObject({ code: 'self_approval' });
    expect((await queue.get(taskId))?.status).toBe('pending');
  });

  it('closes a proposal as stale when the fork changed after it was proposed', async () => {
    const { store, versionLog, queue, resolver, fork } = await setup();
    const taskId = await realm.proposeFork(store, 'brand', fork, { queue, reviewer: 'bob', proposedBy: 'alice' });
    await store.customize('brand.tone', rootCtx('acme'), { tone: 'something the reviewer never saw' });
    const out = await realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'bob', approved: true });
    expect(out.outcome).toBe('stale');
    expect((await resolver.resolve('brand.tone', rootCtx('globex')))?.tone).toBe('neutral');
  });

  it('closes a promotion as stale when the global default moved after it was proposed', async () => {
    const { store, versionLog, queue, fork } = await setup();
    const taskId = await realm.proposeFork(store, 'brand', fork, { queue, reviewer: 'bob', proposedBy: 'alice' });
    await store.publishGlobal('brand.tone', { tone: 'corporate' });
    const out = await realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'bob', approved: true });
    expect(out).toMatchObject({ outcome: 'stale', reason: 'the global default changed after the proposal' });
  });

  it('a rejection applies nothing', async () => {
    const { store, versionLog, queue, resolver, fork } = await setup();
    const taskId = await realm.proposeFork(store, 'brand', fork, { queue, reviewer: 'bob', proposedBy: 'alice' });
    const out = await realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'bob', approved: false, reason: 'off-brand' });
    expect(out.outcome).toBe('rejected');
    expect((await queue.get(taskId))?.status).toBe('rejected');
    expect((await resolver.resolve('brand.tone', rootCtx('globex')))?.tone).toBe('neutral');
  });

  it('shares down the tree on approval, and a share needs its blast radius', async () => {
    const { store, versionLog, queue, fork } = await setup();
    await expect(
      realm.proposeFork(store, 'brand', fork, { queue, reviewer: 'bob', proposedBy: 'alice', change: { kind: 'share', shareMode: 'subtree' } }),
    ).rejects.toMatchObject({ code: 'blast_radius_required' });
    const radius = blastRadius(0, [], 'subtree', new Set());
    const taskId = await realm.proposeFork(store, 'brand', fork, {
      queue, reviewer: 'bob', proposedBy: 'alice', change: { kind: 'share', shareMode: 'subtree' }, blastRadius: radius,
    });
    const out = await realm.decideForkProposal({ store, versionLog, queue }, taskId, { decidedBy: 'bob', approved: true });
    expect(out).toMatchObject({ outcome: 'shared', shareMode: 'subtree' });
    expect((await store.get(fork.id))?.shareMode).toBe('subtree');
  });

  it('refuses a global record and a decision on a task that is not a proposal', async () => {
    const { store, versionLog, queue } = await setup();
    const global = (await store.listAll(['brand.tone'])).find((r) => r.realm === 'global')!;
    await expect(realm.proposeFork(store, 'brand', global, { queue, reviewer: 'bob', proposedBy: 'alice' })).rejects.toMatchObject({ code: 'not_a_fork' });
    const other = await queue.enqueue({ type: 'approval', title: 'x', status: 'pending', priority: 'normal', data: { action: 'x', context: {} } });
    await expect(realm.decideForkProposal({ store, versionLog, queue }, other.id, { decidedBy: 'bob', approved: true })).rejects.toMatchObject({ code: 'not_a_proposal' });
  });
});
