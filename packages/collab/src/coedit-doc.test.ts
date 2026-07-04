// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { createRgaDoc, fromRgaDoc, type CoeditDoc } from './coedit-doc.js';
import { RgaDoc } from './rga.js';
import { createAgentPeer, agentSiteId } from './agent-peer.js';

describe('CoeditDoc port — the RGA reference adapter (createRgaDoc)', () => {
  it('inserts + deletes visible text and tracks length', () => {
    const doc = createRgaDoc('a');
    doc.insert(0, 'Hello world');
    expect(doc.text()).toBe('Hello world');
    expect(doc.length).toBe(11);
    doc.delete(5, 6); // drop " world"
    expect(doc.text()).toBe('Hello');
    expect(doc.length).toBe(5);
  });

  it('delete stops cleanly at the end of the document', () => {
    const doc = createRgaDoc('a');
    doc.insert(0, 'hi');
    const ops = doc.delete(1, 99); // asks for far more than exists
    expect(ops.length).toBe(1); // only the one remaining char was removed
    expect(doc.text()).toBe('h');
  });

  it('two replicas converge regardless of op order (applyOps is commutative)', () => {
    const alice = createRgaDoc('alice');
    const bob = createRgaDoc('bob');
    const a1 = alice.insert(0, 'The fox');
    bob.applyOps(a1);
    // concurrent edits from both sites
    const a2 = alice.insert(3, 'quick '); // "The quick fox"
    const b2 = bob.insert(bob.length, ' runs'); // "The fox runs"
    // cross-apply in DIFFERENT orders
    alice.applyOps(b2);
    bob.applyOps(a2);
    expect(alice.text()).toBe(bob.text());
  });

  it('snapshot round-trips through createRgaDoc(siteId, snapshot)', () => {
    const src = createRgaDoc('src');
    src.insert(0, 'persist me');
    const restored = createRgaDoc('restored', src.snapshot());
    expect(restored.text()).toBe('persist me');
    // and it keeps editing correctly from the restored state
    restored.insert(restored.length, '!');
    expect(restored.text()).toBe('persist me!');
  });

  it('opsSince + stateVector deliver exactly the sync delta', () => {
    const server = createRgaDoc('server');
    const joiner = createRgaDoc('joiner');
    server.insert(0, 'abc');
    const sv = joiner.stateVector();
    const delta = server.opsSince(sv);
    joiner.applyOps(delta);
    expect(joiner.text()).toBe('abc');
    // a joiner already caught up gets nothing new
    expect(server.opsSince(server.stateVector()).length).toBe(0);
  });

  it('fork is an independent shadow (edits do not touch the live doc)', () => {
    const live = createRgaDoc('live');
    live.insert(0, 'base');
    const shadow = live.fork();
    shadow.insert(shadow.length, ' + speculative');
    expect(shadow.text()).toBe('base + speculative');
    expect(live.text()).toBe('base'); // untouched
  });

  it('anchor/resolve keep a cursor stable across concurrent inserts', () => {
    const a = createRgaDoc('a');
    const b = createRgaDoc('b');
    a.insert(0, 'Hello world');
    b.applyOps(a.opsSince(b.stateVector()));
    // anchor a cursor after "Hello" (index 5) on replica b
    const anchor = b.anchor(5);
    // replica a inserts BEFORE the cursor; b merges it
    const ins = a.insert(0, '>> ');
    b.applyOps(ins);
    // the cursor followed its character: now at index 8 ("’>> Hello|’ world")
    expect(b.resolve(anchor)).toBe(8);
    expect(b.text()).toBe('>> Hello world');
  });
});

describe('CoeditDoc port — fromRgaDoc adapts a live RGA replica', () => {
  it('wraps the SAME instance (edits are visible on both the doc and the port)', () => {
    const raw = new RgaDoc('a');
    const port = fromRgaDoc(raw);
    port.insert(0, 'shared');
    expect(raw.text()).toBe('shared'); // same underlying replica
    expect(port.siteId).toBe('a');
  });
});

describe('agent-peer works through the CoeditDoc port (engine-swap-safe)', () => {
  it('direct mode: the agent appends as a normal peer and the doc mutates', () => {
    const doc: CoeditDoc = createRgaDoc(agentSiteId('run-1'));
    doc.insert(0, 'Title\n');
    const peer = createAgentPeer(doc);
    const ops = peer.append('Body by the agent.');
    expect(ops.length).toBeGreaterThan(0);
    expect(doc.text()).toBe('Title\nBody by the agent.');
    expect(peer.written()).toBe(18);
  });

  it('suggest mode: ops are computed against a fork, live doc untouched (HITL)', () => {
    const doc: CoeditDoc = createRgaDoc(agentSiteId('run-2'));
    doc.insert(0, 'x');
    const peer = createAgentPeer(doc, { mode: 'suggest' });
    const ops = peer.append(' suggested');
    expect(ops.length).toBe(10); // one insert op per character
    expect(doc.text()).toBe('x'); // staged, NOT applied
  });

  it('the agent peer touches ONLY the port surface (no engine internals)', () => {
    // A minimal spy CoeditDoc: agent-peer must drive it through the interface alone.
    const seen = new Set<string>();
    let text = '';
    const spy: CoeditDoc = {
      siteId: agentSiteId('spy'),
      get length() { seen.add('length'); return text.length; },
      text() { seen.add('text'); return text; },
      insert(index, t) { seen.add('insert'); text = text.slice(0, index) + t + text.slice(index); return []; },
      delete() { seen.add('delete'); return []; },
      applyOps() { seen.add('applyOps'); return 0; },
      opsSince() { seen.add('opsSince'); return []; },
      stateVector() { seen.add('stateVector'); return {}; },
      snapshot() { seen.add('snapshot'); return { text: '', tombstones: [] } as never; },
      fork() { seen.add('fork'); return spy; },
      anchor() { seen.add('anchor'); return { anchorId: null, assoc: -1 }; },
      resolve() { seen.add('resolve'); return 0; },
    };
    const peer = createAgentPeer(spy);
    peer.append('hi');
    expect(text).toBe('hi'); // drove the swap-in engine purely via insert()/length
    expect(seen.has('insert')).toBe(true);
  });
});
