// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link CommentManager} adapter (Phase 4).
 * The in-memory reference adapter and a consuming application's SQL adapter must both pass it.
 */
import type { CommentManager, CommentAnchor } from './run-comment.js';
import type { ContractTestApi } from './shared-session-contract.js';

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }
const anchor = (partId = 'tool-1', seq = 5): CommentAnchor => ({ partId, createdAtSeq: seq });

export function commentManagerContract(make: () => Promise<CommentManager> | CommentManager, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('CommentManager contract', () => {
    let mgr: CommentManager;
    let runId: string;
    beforeEach(async () => { mgr = await make(); runId = nextId('run'); });

    async function root(over: Partial<Parameters<CommentManager['create']>[0]> = {}) {
      return mgr.create({ id: nextId('c'), runId, tenantId: 'tA', authorId: 'alice', body: 'Looks wrong', anchor: anchor(), ...over });
    }

    it('creates a root comment whose thread is itself, anchored to a part', async () => {
      const c = await root();
      expect(c.threadId).toBe(c.id);
      expect(c.parentId).toBeNull();
      expect(c.anchor.partId).toBe('tool-1');
      expect(c.resolvedAt).toBeNull();
    });

    it('renders markdown to sanitized html (no script survives)', async () => {
      const c = await root({ body: 'see <script>alert(1)</script> **bad** [x](javascript:alert(1))' });
      expect(c.bodyHtml).not.toContain('<script>');
      expect(c.bodyHtml).toContain('<strong>bad</strong>');
      expect(c.bodyHtml).not.toContain('href="javascript:'); // never an executable link
    });

    it('a reply inherits the parent thread', async () => {
      const r = await root();
      const reply = await mgr.create({ id: nextId('c'), runId, tenantId: 'tA', authorId: 'bob', body: 'agreed', parentId: r.id, anchor: anchor() });
      expect(reply.threadId).toBe(r.id);
      expect(reply.parentId).toBe(r.id);
      expect((await mgr.listThread(r.id)).length).toBe(2);
    });

    it('rejects a reply to a non-existent parent', async () => {
      await expect(mgr.create({ id: nextId('c'), runId, tenantId: 'tA', authorId: 'bob', body: 'x', parentId: 'ghost', anchor: anchor() })).rejects.toThrow();
    });

    it('listForRun returns comments oldest-first', async () => {
      const a = await root({ body: 'first' });
      const b = await root({ body: 'second' });
      expect((await mgr.listForRun(runId)).map((c) => c.id)).toEqual([a.id, b.id]);
    });

    it('only the author may edit; edit stamps editedAt + re-renders', async () => {
      const c = await root({ body: 'orig' });
      await expect(mgr.edit(c.id, 'mallory', 'hacked')).rejects.toThrow();
      const edited = await mgr.edit(c.id, 'alice', 'updated **bold**');
      expect(edited.body).toBe('updated **bold**');
      expect(edited.bodyHtml).toContain('<strong>bold</strong>');
      expect(edited.editedAt).not.toBeNull();
    });

    it('soft-delete tombstones the row (author), preserving replies', async () => {
      const r = await root();
      await mgr.create({ id: nextId('c'), runId, tenantId: 'tA', authorId: 'bob', body: 'reply', parentId: r.id, anchor: anchor() });
      await expect(mgr.softDelete(r.id, 'mallory')).rejects.toThrow();       // not author
      await mgr.softDelete(r.id, 'alice');
      const got = await mgr.getById(r.id);
      expect(got?.deletedAt).not.toBeNull();
      expect(got?.body).toBe('');                                            // body scrubbed
      expect((await mgr.listThread(r.id)).length).toBe(2);                   // reply preserved
    });

    it('a moderator can force-delete another author comment', async () => {
      const c = await root({ authorId: 'bob' });
      await mgr.softDelete(c.id, 'owner', { force: true });
      expect((await mgr.getById(c.id))?.deletedAt).not.toBeNull();
    });

    it('resolve + reopen a thread is mirrored across the thread', async () => {
      const r = await root();
      await mgr.create({ id: nextId('c'), runId, tenantId: 'tA', authorId: 'bob', body: 'reply', parentId: r.id, anchor: anchor() });
      await mgr.resolveThread(r.id, 'owner');
      const thread = await mgr.listThread(r.id);
      expect(thread.every((c) => c.resolvedAt !== null)).toBe(true);
      expect(thread.find((c) => c.id === r.id)?.resolvedBy).toBe('owner');
      await mgr.reopenThread(r.id, 'owner');
      expect((await mgr.listThread(r.id)).every((c) => c.resolvedAt === null)).toBe(true);
    });
  });
}
