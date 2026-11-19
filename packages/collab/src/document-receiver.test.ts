// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { BlockDoc, type BlockOp } from './block-doc.js';
import { validateClientBlockOps } from './block-validation.js';
import { createCollaborationReceiver, type CollaborationDocumentScope } from './document-receiver.js';
import { RgaDoc, type RgaOp } from './rga.js';
import { validateClientOps } from './validation.js';

const scope: CollaborationDocumentScope = {
  tenantId: 'tenant', sessionId: 'session', documentId: 'doc', documentKind: 'rga/v1',
};
type Principal = { site: string; canWrite: boolean };
const alice: Principal = { site: 'alice', canWrite: true };
const delivery = (operations: unknown[], target = scope) => ({ scope: target, operations });

function textReceiver(doc: RgaDoc, target = scope) {
  return createCollaborationReceiver<RgaOp, Principal>({
    scope: target,
    maxOperations: 10,
    authorize: (principal) => principal.canWrite,
    validate: (operations, principal) => validateClientOps(operations, { expectedSiteId: principal.site }),
    apply: (operations) => { doc.applyMany(operations); },
  });
}

describe('document collaboration receiver', () => {
  it('isolates tenants, sessions, documents and operation formats without delimiter collisions', () => {
    const doc = new RgaDoc('receiver');
    const receiver = textReceiver(doc, { ...scope, tenantId: 'a:b', sessionId: 'c' });
    const op = new RgaDoc('alice').localInsert(0, 'x');
    const target = { ...scope, tenantId: 'a:b', sessionId: 'c' };
    for (const other of [
      { ...target, tenantId: 'a', sessionId: 'b:c' },
      { ...target, sessionId: 'other' },
      { ...target, documentId: 'other' },
      { ...target, documentKind: 'block/v1' },
    ]) {
      expect(receiver.receive(alice, delivery([op], other))).toBe('scope-mismatch');
    }
    expect(doc.text()).toBe('');
    expect(receiver.receive(alice, delivery([op], target))).toBe('accepted');
    expect(doc.text()).toBe('x');
  });

  it('uses the host principal and rechecks authorization and operation authorship', () => {
    const doc = new RgaDoc('receiver');
    const receiver = textReceiver(doc);
    const op = new RgaDoc('alice').localInsert(0, 'x');
    const message = { ...delivery([op]), principal: alice };
    expect(receiver.receive({ site: 'bob', canWrite: false }, message)).toBe('unauthorized');
    expect(receiver.receive({ site: 'bob', canWrite: true }, message)).toBe('invalid');
    expect(doc.text()).toBe('');
    expect(receiver.receive(alice, message)).toBe('accepted');
    alice.canWrite = false;
    try {
      expect(receiver.receive(alice, message)).toBe('unauthorized');
    } finally {
      alice.canWrite = true;
    }
  });

  it('rejects malformed, oversized and partially invalid batches before applying any operations', () => {
    const doc = new RgaDoc('receiver');
    const receiver = textReceiver(doc);
    const op = new RgaDoc('alice').localInsert(0, 'x');
    for (const message of [null, {}, { scope }, delivery([]), delivery(Array(11).fill(op)), delivery([op, { type: 'bad' }])]) {
      expect(receiver.receive(alice, message)).toBe('invalid');
    }
    expect(doc.text()).toBe('');
  });

  it('copies its scope and rejects invalid configuration and validator results', () => {
    const mutable = { ...scope };
    const apply = vi.fn();
    const receiver = createCollaborationReceiver<unknown, Principal>({
      scope: mutable, maxOperations: 1, authorize: () => true,
      validate: () => ({ ok: true, ops: [] }), apply,
    });
    mutable.documentId = 'changed';
    expect(receiver.receive(alice, delivery([1]))).toBe('invalid');
    expect(receiver.receive(alice, delivery([1], mutable))).toBe('scope-mismatch');
    expect(apply).not.toHaveBeenCalled();
    expect(() => textReceiver(new RgaDoc('r'), { ...scope, sessionId: '' })).toThrow();
    expect(() => createCollaborationReceiver({ scope, maxOperations: 0, authorize: () => true, validate: () => ({ ok: false }), apply })).toThrow();
  });

  it('fails closed if a JavaScript host accidentally supplies asynchronous authorization', () => {
    const apply = vi.fn();
    const receiver = createCollaborationReceiver<unknown, Principal>({
      scope, maxOperations: 1,
      authorize: (() => Promise.resolve(true)) as unknown as () => boolean,
      validate: (ops) => ({ ok: true, ops: [...ops] }),
      apply,
    });
    expect(receiver.receive(alice, delivery([1]))).toBe('unauthorized');
    expect(apply).not.toHaveBeenCalled();
  });

  it('replays a complete history after disconnect, including duplicates and out-of-order ops', () => {
    const source = new RgaDoc('alice');
    const first = source.localInsert(0, 'a');
    const second = source.localInsert(0, 'b'); // independent of first; later counter arrives first
    const receiverDoc = new RgaDoc('receiver');
    const receiver = textReceiver(receiverDoc);
    expect(receiver.receive(alice, delivery([second]))).toBe('accepted');
    expect(source.opsSince(receiverDoc.stateVector())).toEqual([]); // a max counter is not a gap-safe cursor
    expect(receiver.receive(alice, delivery([first, second]))).toBe('accepted');
    expect(receiverDoc.text()).toBe(source.text());

    const dependent = source.localInsertText(source.length, 'cd');
    expect(receiver.receive(alice, delivery([dependent[1], dependent[0], dependent[1]]))).toBe('accepted');
    expect(receiverDoc.text()).toBe(source.text());
  });

  it('uses the same boundary with the existing rich-text BlockDoc adapter', () => {
    const source = new BlockDoc('alice');
    const { ops: blocks, blockId } = source.insertBlock(null, 'heading');
    const edits = [...blocks, ...source.insertText(blockId, 0, 'Hi')];
    const replica = new BlockDoc('replica');
    const target = { ...scope, documentKind: 'block/v1' };
    const receiver = createCollaborationReceiver<BlockOp, Principal>({
      scope: target, maxOperations: 10,
      authorize: (principal) => principal.canWrite,
      validate: (operations, principal) => validateClientBlockOps(operations, { expectedSiteId: principal.site }),
      apply: (operations) => { replica.applyMany(operations); },
    });
    expect(receiver.receive(alice, delivery([...edits].reverse(), target))).toBe('accepted');
    expect(receiver.receive(alice, delivery(edits, target))).toBe('accepted');
    expect(replica.blocks()).toEqual(source.blocks());
  });

  it('also accepts a non-text adapter without imposing RGA operation shapes', () => {
    const values = new Set<string>();
    const target = { ...scope, documentKind: 'set/v1' };
    const receiver = createCollaborationReceiver<string, Principal>({
      scope: target, maxOperations: 10,
      authorize: (principal) => principal.canWrite,
      validate: (ops) => ops.every((op) => typeof op === 'string')
        ? { ok: true, ops: ops as string[] } : { ok: false },
      apply: (ops) => { for (const op of ops) values.add(op); },
    });
    expect(receiver.receive(alice, delivery(['b', 'a', 'b'], target))).toBe('accepted');
    expect([...values].sort()).toEqual(['a', 'b']);
  });
});
