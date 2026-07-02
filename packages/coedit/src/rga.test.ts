// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { RgaDoc, idGreater, idKey, type RgaOp } from './rga.js';

/** Apply a list of ops to a doc in a given order. */
function applyAll(doc: RgaDoc, ops: RgaOp[]): void { for (const op of ops) doc.apply(op); }

/** All permutations of a small array (for order-independence proofs). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i]!, ...p]);
  }
  return out;
}

describe('RgaDoc — basic editing', () => {
  it('inserts and reads text', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'hello');
    expect(d.text()).toBe('hello');
    expect(d.length).toBe(5);
  });

  it('inserts in the middle + at the end', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'helo');
    d.localInsert(2, 'l');        // hel|o → hello
    expect(d.text()).toBe('hello');
    d.localInsertText(5, '!');
    expect(d.text()).toBe('hello!');
  });

  it('delete tombstones (text shrinks, anchors survive)', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'abc');
    d.localDelete(1); // delete 'b' (0-based index 1)
    expect(d.text()).toBe('ac');
    // Inserting after the (now deleted) anchor still works.
    d.localInsert(1, 'X'); // a|c → aXc
    expect(d.text()).toBe('aXc');
  });
});

describe('RgaDoc — CONVERGENCE (the core CRDT guarantee)', () => {
  it('two replicas typing concurrently at the same spot converge identically', () => {
    // Both start from "Hello!", then concurrently insert a name after "Hello ".
    const base = new RgaDoc('seed');
    const seedOps = base.localInsertText(0, 'Hello!');

    const alice = new RgaDoc('alice'); applyAll(alice, seedOps);
    const bob = new RgaDoc('bob'); applyAll(bob, seedOps);

    const aOps = alice.localInsertText(5, ' Alice');   // "Hello Alice!"
    const bOps = bob.localInsertText(5, ' Bob');       // "Hello Bob!"

    // Each receives the other's ops (in opposite orders).
    applyAll(alice, bOps);
    applyAll(bob, aOps);

    expect(alice.text()).toBe(bob.text());             // CONVERGED
    // RGA keeps each concurrent run contiguous (forward non-interleaving) — no scramble.
    expect(alice.text().includes('Alice')).toBe(true);
    expect(alice.text().includes('Bob')).toBe(true);
  });

  it('converges regardless of op delivery ORDER (all permutations equal)', () => {
    const a = new RgaDoc('a'); const b = new RgaDoc('b'); const c = new RgaDoc('c');
    const ops = [
      ...a.localInsertText(0, 'AAA'),
      ...b.localInsertText(0, 'BBB'),
      ...c.localInsertText(0, 'CCC'),
    ];
    const results = new Set<string>();
    for (const perm of permutations(ops).slice(0, 60)) { // sample permutations
      const d = new RgaDoc('x');
      applyAll(d, perm);
      results.add(d.text());
    }
    expect(results.size).toBe(1); // every order yields the SAME text
  });

  it('three-way concurrent edit + deletes converge', () => {
    const seed = new RgaDoc('seed'); const s = seed.localInsertText(0, 'The quick fox');
    const r1 = new RgaDoc('r1'); applyAll(r1, s);
    const r2 = new RgaDoc('r2'); applyAll(r2, s);
    const r3 = new RgaDoc('r3'); applyAll(r3, s);
    const o1 = r1.localInsertText(9, ' brown');     // "The quick brown fox"
    const o2 = r2.localInsertText(13, ' jumps');    // append-ish
    const o3 = [r3.localDelete(0)!, r3.localDelete(0)!, r3.localDelete(0)!, r3.localDelete(0)!]; // delete "The "
    for (const [doc, mine] of [[r1, o1], [r2, o2], [r3, o3]] as const) {
      for (const [other, ops] of [[r1, o1], [r2, o2], [r3, o3]] as const) if (other !== doc) applyAll(doc, ops as RgaOp[]);
      void mine;
    }
    expect(r1.text()).toBe(r2.text());
    expect(r2.text()).toBe(r3.text());
  });
});

describe('RgaDoc — idempotency + causal delivery', () => {
  it('applying the same op twice is a no-op (idempotent)', () => {
    const d = new RgaDoc('a');
    const op = d.localInsert(0, 'x');
    expect(d.apply(op)).toBe(false); // duplicate ignored
    expect(d.text()).toBe('x');
  });

  it('buffers an insert whose origin has not arrived, then applies it on arrival', () => {
    const src = new RgaDoc('src');
    const o1 = src.localInsert(0, 'a');
    const o2 = src.localInsert(1, 'b'); // origin = a

    const dst = new RgaDoc('dst');
    expect(dst.apply(o2)).toBe(false);  // origin 'a' missing → buffered
    expect(dst.text()).toBe('');
    expect(dst.apply(o1)).toBe(true);   // origin arrives → buffer drains
    expect(dst.text()).toBe('ab');
  });

  it('a delete whose target is unknown is buffered until the target arrives', () => {
    const d = new RgaDoc('a');
    // Target not present → buffered (returns false), then applied when it arrives.
    expect(d.apply({ type: 'del', opId: { counter: 1, siteId: 'b' }, target: { counter: 5, siteId: 'src' } })).toBe(false);
    const src = new RgaDoc('src'); src.localInsertText(0, 'xxxxx'); // makes (5,src) exist
    const insOps = src.opsSince({});
    d.applyMany(insOps); // now (5,src) exists → the buffered delete drains
    // The 5th char (id (5,src)) is now tombstoned.
    expect(d.length).toBe(4);
  });
});

describe('RgaDoc — state-vector sync (offline reconcile)', () => {
  it('opsSince returns exactly the ops the peer is missing', () => {
    const a = new RgaDoc('a');
    a.localInsertText(0, 'hello');
    const b = new RgaDoc('b');
    // b is empty → it is missing everything.
    const missing = a.opsSince(b.stateVector());
    expect(missing.length).toBe(5);
    b.applyMany(missing);
    expect(b.text()).toBe('hello');
    // Now b is caught up → no more missing.
    expect(a.opsSince(b.stateVector()).length).toBe(0);
  });

  it('two peers that edited OFFLINE reconcile to the same text via opsSince', () => {
    const seed = new RgaDoc('seed'); const s = seed.localInsertText(0, 'doc');
    const a = new RgaDoc('a'); applyAll(a, s);
    const b = new RgaDoc('b'); applyAll(b, s);
    // Both go offline and edit independently.
    a.localInsertText(3, '-A1'); a.localInsertText(0, 'X');
    b.localInsertText(3, '-B1'); b.localDelete(0);
    // Reconnect: exchange only the missing ops (the Yjs sync-vector handshake).
    const aMissing = a.opsSince(b.stateVector());
    const bMissing = b.opsSince(a.stateVector());
    b.applyMany(aMissing);
    a.applyMany(bMissing);
    expect(a.text()).toBe(b.text()); // CONVERGED after offline edits
  });
});

describe('RgaDoc — snapshot', () => {
  it('round-trips through a snapshot (incl. tombstones + clock)', () => {
    const d = new RgaDoc('a');
    d.localInsertText(0, 'abcdef');
    d.localDelete(1); // tombstone 'b'
    const restored = RgaDoc.fromSnapshot('a', d.snapshot());
    expect(restored.text()).toBe(d.text());
    // The restored doc can keep editing with non-colliding ids.
    const op = restored.localInsert(0, 'Z');
    expect(op.id.counter).toBeGreaterThan(6);
    expect(restored.text()).toBe('Zacdef');
  });
});

describe('RgaDoc — fuzz convergence (stress)', () => {
  // A small deterministic PRNG (no Math.random — reproducible).
  function makeRng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }

  it('N replicas making many random concurrent edits all converge', () => {
    for (let trial = 0; trial < 8; trial++) {
      const rng = makeRng(1234 + trial * 7);
      const sites = ['a', 'b', 'c'];
      const docs = sites.map((s) => new RgaDoc(s));
      const allOps: RgaOp[] = [];
      // Each replica makes a burst of local edits (broadcast collected, applied later).
      for (let round = 0; round < 40; round++) {
        const doc = docs[Math.floor(rng() * docs.length)]!;
        if (doc.length > 0 && rng() < 0.25) {
          const op = doc.localDelete(Math.floor(rng() * doc.length));
          if (op) allOps.push(op);
        } else {
          const ch = String.fromCharCode(97 + Math.floor(rng() * 26));
          allOps.push(doc.localInsert(Math.floor(rng() * (doc.length + 1)), ch));
        }
      }
      // Every replica receives every op (in a shuffled order). Idempotent + causal.
      for (const doc of docs) {
        const shuffled = [...allOps];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
        // Apply twice to also exercise idempotency.
        doc.applyMany(shuffled); doc.applyMany(shuffled);
      }
      const texts = docs.map((d) => d.text());
      expect(new Set(texts).size).toBe(1); // ALL replicas converged
    }
  });
});

describe('id comparison', () => {
  it('descending order: higher counter first, then higher siteId', () => {
    expect(idGreater({ counter: 2, siteId: 'a' }, { counter: 1, siteId: 'z' })).toBe(true);
    expect(idGreater({ counter: 1, siteId: 'b' }, { counter: 1, siteId: 'a' })).toBe(true);
    expect(idGreater({ counter: 1, siteId: 'a' }, { counter: 1, siteId: 'b' })).toBe(false);
    expect(idKey({ counter: 3, siteId: 'a' })).toBe('3@a');
  });
});
