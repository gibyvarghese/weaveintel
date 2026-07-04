// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link AnnotationManager} adapter (Phase 4).
 */
import type { AnnotationManager } from './run-annotation.js';
import type { ContractTestApi } from './shared-session-contract.js';

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }

export function annotationManagerContract(make: () => Promise<AnnotationManager> | AnnotationManager, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('AnnotationManager contract', () => {
    let mgr: AnnotationManager;
    let runId: string;
    beforeEach(async () => { mgr = await make(); runId = nextId('run'); });

    it('creates a numeric score anchored to a part', async () => {
      const a = await mgr.create({ id: nextId('a'), runId, tenantId: 'tA', authorId: 'alice', name: 'helpfulness', dataType: 'numeric', value: 4, partId: 'tool-1' });
      expect(a.value).toBe(4);
      expect(a.partId).toBe('tool-1');
      expect(a.source).toBe('human');
    });

    it('normalises a boolean (thumbs) to 1/0 with a readable label', async () => {
      const up = await mgr.create({ id: nextId('a'), runId, tenantId: 'tA', authorId: 'alice', name: 'thumbs', dataType: 'boolean', value: 1 });
      expect(up.value).toBe(1);
      expect(up.stringValue).toBe('true');
    });

    it('lists by run and by part', async () => {
      await mgr.create({ id: nextId('a'), runId, tenantId: 'tA', authorId: 'alice', name: 'x', dataType: 'numeric', value: 1, partId: 'tool-1' });
      await mgr.create({ id: nextId('a'), runId, tenantId: 'tA', authorId: 'bob', name: 'x', dataType: 'numeric', value: 5, partId: 'text-2' });
      expect((await mgr.listForRun(runId)).length).toBe(2);
      expect((await mgr.listForPart(runId, 'tool-1')).length).toBe(1);
    });

    it('only the author may delete (moderator can force)', async () => {
      const a = await mgr.create({ id: nextId('a'), runId, tenantId: 'tA', authorId: 'alice', name: 'x', dataType: 'numeric', value: 1 });
      await expect(mgr.delete(a.id, 'mallory')).rejects.toThrow();
      await mgr.delete(a.id, 'owner', { force: true });
      expect(await mgr.getById(a.id)).toBeNull();
    });
  });
}
