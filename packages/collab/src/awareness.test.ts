// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { RgaDoc } from './rga.js';
import { fromRgaDoc } from './coedit-doc.js';
import { Awareness, cursorFromIndex, indexFromCursor } from './awareness.js';
import { createAgentPeer, agentSiteId, isAgentSite } from './agent-peer.js';
import { validateClientOps } from './validation.js';

describe('relative-position cursors survive concurrent edits', () => {
  it('a cursor anchored to a character stays put when text is inserted ABOVE it', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'hello world');
    // Cursor after "hello" (index 5).
    const cur = cursorFromIndex(d, 5);
    expect(indexFromCursor(d, cur)).toBe(5);
    // Someone inserts at the very start → an integer offset would now be wrong,
    // but the relative cursor moves WITH its anchor.
    d.localInsertText(0, '>>> ');
    expect(d.text()).toBe('>>> hello world');
    expect(indexFromCursor(d, cur)).toBe(9); // 5 + 4 inserted chars — still after "hello"
  });

  it('a cursor whose anchor was deleted resolves to a sensible nearby index', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'abcdef');
    const cur = cursorFromIndex(d, 3); // after 'c'
    d.localDelete(2);                  // delete 'c'
    expect(d.text()).toBe('abdef');
    expect(indexFromCursor(d, cur)).toBeGreaterThanOrEqual(2); // resolves near the old spot
  });

  it('start-of-doc cursor is anchorId null', () => {
    const d = new RgaDoc('a'); d.localInsertText(0, 'x');
    expect(cursorFromIndex(d, 0)).toEqual({ anchorId: null, assoc: -1 });
    expect(indexFromCursor(d, { anchorId: null, assoc: -1 })).toBe(0);
  });
});

describe('Awareness — LWW clock + TTL', () => {
  it('applies a remote entry only if its clock is strictly greater', () => {
    let t = 1000;
    const aw = new Awareness('me', { now: () => t });
    expect(aw.applyRemote('bob', { clock: 2, state: { name: 'Bob', status: 'editing' } })).toBe(true);
    expect(aw.applyRemote('bob', { clock: 1, state: { name: 'Bob', status: 'idle' } })).toBe(false); // older
    expect(aw.applyRemote('bob', { clock: 3, state: { name: 'Bob', status: 'idle' } })).toBe(true);
    expect(aw.states().get('bob')?.status).toBe('idle');
  });

  it('a peer can never overwrite the local entry', () => {
    const aw = new Awareness('me');
    aw.setLocalState({ name: 'Me' });
    expect(aw.applyRemote('me', { clock: 999, state: { name: 'Imposter' } })).toBe(false);
    expect(aw.states().get('me')?.name).toBe('Me');
  });

  it('expires peers past the TTL; offline (null) states are filtered out', () => {
    let t = 1000;
    const aw = new Awareness('me', { ttlMs: 5000, now: () => t });
    aw.applyRemote('bob', { clock: 1, state: { name: 'Bob' } });
    t = 4000; expect(aw.states().has('bob')).toBe(true);   // within TTL
    t = 7000;
    expect(aw.states().has('bob')).toBe(false);            // past TTL
    expect(aw.expire()).toContain('bob');
    // An explicit offline (state:null) is hidden even when fresh.
    t = 7100; aw.applyRemote('carol', { clock: 1, state: null });
    expect(aw.states().has('carol')).toBe(false);
  });

  it('setLocalState bumps the clock monotonically', () => {
    const aw = new Awareness('me');
    const a = aw.setLocalState({ status: 'editing' });
    const b = aw.setLocalState({ status: 'idle' });
    expect(b.clock).toBeGreaterThan(a.clock);
  });
});

describe('agent as a co-editing peer', () => {
  it('the agent appends as a normal CRDT peer and merges with a human', () => {
    const human = new RgaDoc('human');
    const hOps = human.localInsertText(0, 'Title\n');

    const agent = new RgaDoc(agentSiteId('run-1'));
    expect(isAgentSite(agent.siteId)).toBe(true);
    agent.applyMany(hOps);
    const peer = createAgentPeer(fromRgaDoc(agent)); // direct mode, through the port
    const aOps = peer.append('Body written by the agent.');
    expect(agent.text()).toBe('Title\nBody written by the agent.');

    // Concurrently the human keeps typing; everything converges.
    const more = human.localInsertText(human.length, '!!!');
    human.applyMany(aOps);
    agent.applyMany(more);
    expect(human.text()).toBe(agent.text());
    expect(peer.written()).toBe(26);
  });

  it('suggest mode returns ops WITHOUT mutating the live doc (HITL gate)', () => {
    const doc = new RgaDoc(agentSiteId('run-2'));
    doc.localInsertText(0, 'x');
    const peer = createAgentPeer(fromRgaDoc(doc), { mode: 'suggest' });
    const ops = peer.append(' suggested');
    expect(ops.length).toBe(10);
    expect(doc.text()).toBe('x'); // unchanged — the suggestion is staged, not applied
  });
});

describe('validateClientOps — trusted relay security', () => {
  const base = (over: Record<string, unknown> = {}) => ({ type: 'ins', id: { counter: 1, siteId: 'alice' }, originId: null, value: 'x', ...over });

  it('accepts well-formed ops authored by the connection site', () => {
    const res = validateClientOps([base()], { expectedSiteId: 'alice' });
    expect(res.ok).toBe(true);
    expect(res.ops!.length).toBe(1);
  });

  it('REJECTS an op forging another site as the author (anti-spoof)', () => {
    const res = validateClientOps([base({ id: { counter: 1, siteId: 'mallory' } })], { expectedSiteId: 'alice' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forgery|another site/i);
  });

  it('rejects malformed shapes, empty/oversized values, and floods', () => {
    expect(validateClientOps('nope', { expectedSiteId: 'a' }).ok).toBe(false);
    expect(validateClientOps([], { expectedSiteId: 'a' }).ok).toBe(false);
    expect(validateClientOps([base({ value: '' })], { expectedSiteId: 'alice' }).ok).toBe(false);
    expect(validateClientOps([base({ value: 'x'.repeat(100) })], { expectedSiteId: 'alice', maxCharsPerOp: 64 }).ok).toBe(false);
    expect(validateClientOps([base({ id: { counter: 0, siteId: 'alice' } })], { expectedSiteId: 'alice' }).ok).toBe(false); // counter must be > 0
    const many = Array.from({ length: 11 }, () => base());
    expect(validateClientOps(many, { expectedSiteId: 'alice', maxOps: 10 }).ok).toBe(false);
  });

  it('allows deleting ANY element, but the delete op must be authored by this site', () => {
    // Target someone else's char — fine; the del op is authored by alice.
    expect(validateClientOps([{ type: 'del', opId: { counter: 5, siteId: 'alice' }, target: { counter: 2, siteId: 'someoneElse' } }], { expectedSiteId: 'alice' }).ok).toBe(true);
    // Forging the del op as another author — rejected.
    expect(validateClientOps([{ type: 'del', opId: { counter: 5, siteId: 'mallory' }, target: { counter: 2, siteId: 'x' } }], { expectedSiteId: 'alice' }).ok).toBe(false);
  });

  it('accepts a device site UNDER the user namespace (multi-device), rejects outside it', () => {
    // u:alice owns u:alice:tab1 — accepted.
    expect(validateClientOps([base({ id: { counter: 1, siteId: 'u:alice:tab1' } })], { expectedSiteId: 'u:alice' }).ok).toBe(true);
    // u:alice does NOT own u:bob:tab1 — rejected.
    expect(validateClientOps([base({ id: { counter: 1, siteId: 'u:bob:tab1' } })], { expectedSiteId: 'u:alice' }).ok).toBe(false);
  });

  it('rejects unknown op types', () => {
    expect(validateClientOps([{ type: 'evil', id: { counter: 1, siteId: 'alice' } }], { expectedSiteId: 'alice' }).ok).toBe(false);
  });
});
