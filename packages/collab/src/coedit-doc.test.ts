// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { createRgaDoc, fromRgaDoc, type CoeditDoc } from './coedit-doc.js';
import { coeditDocContract } from './coedit-doc-contract.js';
import { RgaDoc } from './rga.js';
import { createAgentPeer, agentSiteId } from './agent-peer.js';

// The RGA reference adapter must satisfy the full CoeditDoc conformance contract — the same
// suite a Yjs (or any other) adapter would be held to. See docs/adapters.md.
coeditDocContract(createRgaDoc, { describe, it, expect });

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
