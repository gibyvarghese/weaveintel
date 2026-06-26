// SPDX-License-Identifier: MIT
/**
 * Tests for `validateClientBlockOps` — the weaveNotes Phase 2 trusted-relay guard.
 * Positive (well-formed ops pass), negative (malformed shapes rejected), and the
 * security cases that matter: identity forgery, floods, oversized inserts/values,
 * unknown block/mark types.
 */
import { describe, it, expect } from 'vitest';
import { BlockDoc } from './block-doc.js';
import { validateClientBlockOps } from './block-validation.js';

const NS = 'u:alice';
const SITE = 'u:alice:tab1'; // a device-site UNDER alice's namespace

/** A small batch of real ops authored under `site`. */
function realOps(site: string) {
  const doc = new BlockDoc(site);
  const { ops: bOps, blockId } = doc.insertBlock(null, 'heading', { level: 2 });
  const txt = doc.insertText(blockId, 0, 'Hello');
  const mark = doc.addMark(blockId, 0, 4, 'bold');
  return [...bOps, ...txt, ...(mark ? [mark] : [])];
}

describe('validateClientBlockOps — positive', () => {
  it('accepts a well-formed batch authored within the namespace', () => {
    const res = validateClientBlockOps(realOps(SITE), { expectedSiteId: NS });
    expect(res.ok).toBe(true);
    expect(res.ops!.length).toBeGreaterThan(0);
  });
  it('accepts ops authored as the namespace itself (no device suffix)', () => {
    const res = validateClientBlockOps(realOps(NS), { expectedSiteId: NS });
    expect(res.ok).toBe(true);
  });
});

describe('validateClientBlockOps — negative / security', () => {
  it('rejects identity forgery (author site outside the namespace)', () => {
    const res = validateClientBlockOps(realOps('u:mallory:tab1'), { expectedSiteId: NS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forbidden/);
  });
  it('rejects a prefix-collision namespace (u:alice2 is NOT under u:alice)', () => {
    const res = validateClientBlockOps(realOps('u:alice2'), { expectedSiteId: NS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forbidden/);
  });
  it('rejects a non-array / empty batch', () => {
    expect(validateClientBlockOps('nope', { expectedSiteId: NS }).ok).toBe(false);
    expect(validateClientBlockOps([], { expectedSiteId: NS }).ok).toBe(false);
  });
  it('rejects a flood beyond maxOps', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ t: 'ins', id: { counter: i + 1, siteId: SITE }, originId: null, kind: 'char', char: 'x' }));
    expect(validateClientBlockOps(many, { expectedSiteId: NS, maxOps: 10 }).ok).toBe(false);
  });
  it('rejects an oversized char insert', () => {
    const op = [{ t: 'ins', id: { counter: 1, siteId: SITE }, originId: null, kind: 'char', char: 'x'.repeat(100) }];
    expect(validateClientBlockOps(op, { expectedSiteId: NS, maxCharsPerOp: 8 }).ok).toBe(false);
  });
  it('rejects an unknown block type', () => {
    const op = [{ t: 'ins', id: { counter: 1, siteId: SITE }, originId: null, kind: 'block', blockType: 'evilBlock' }];
    expect(validateClientBlockOps(op, { expectedSiteId: NS }).ok).toBe(false);
  });
  it('rejects an unknown mark type', () => {
    const op = [{ t: 'mark', opId: { counter: 1, siteId: SITE }, startId: { counter: 2, siteId: SITE }, endId: { counter: 3, siteId: SITE }, markType: 'blink', remove: false }];
    expect(validateClientBlockOps(op, { expectedSiteId: NS }).ok).toBe(false);
  });
  it('rejects an oversized attribute value (anti-bloat)', () => {
    const op = [{ t: 'attr', opId: { counter: 1, siteId: SITE }, block: null, key: 'k', value: 'y'.repeat(9000) }];
    expect(validateClientBlockOps(op, { expectedSiteId: NS, maxValueLen: 4096 }).ok).toBe(false);
  });
  it('rejects malformed ids and unknown op types', () => {
    expect(validateClientBlockOps([{ t: 'ins', id: { counter: 0, siteId: SITE }, originId: null, kind: 'char', char: 'x' }], { expectedSiteId: NS }).ok).toBe(false);
    expect(validateClientBlockOps([{ t: 'frobnicate' }], { expectedSiteId: NS }).ok).toBe(false);
  });
});
