// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — the shared conformance test for any {@link CoeditDoc} adapter.
 *
 * The {@link CoeditDoc} port is the product; the RGA is only the REFERENCE adapter. This
 * contract is what makes "the engine is swappable" a guarantee instead of a claim: every
 * adapter — the built-in RGA today, a Yjs-backed adapter you write tomorrow — must pass this
 * exact suite. If it does, it will co-edit, sync, merge, and anchor cursors identically, and
 * `agent-peer.ts` (the AI-as-editing-peer) will work on top of it unchanged.
 *
 * It follows the same dependency-injected shape as the notes `NoteRepository` contract: you pass
 * in your test runner's `describe`/`it`/`expect`, so this file ships in `src` with NO test-runner
 * dependency. See `docs/adapters.md` for a worked Yjs adapter that this contract validates.
 *
 * Usage (from your adapter's own test file):
 *
 *   import { describe, it, expect } from 'vitest';
 *   import { coeditDocContract } from '@weaveintel/collab';
 *   import { createYjsDoc } from './my-yjs-adapter.js';
 *   coeditDocContract(createYjsDoc, { describe, it, expect });
 */
import type { CoeditDoc, CoeditSnapshot } from './coedit-doc.js';

/** The tiny slice of a test runner the contract needs (inject vitest/jest/node:test here). */
export interface CoeditContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeGreaterThan(v: number): void;
  };
}

/**
 * The factory an adapter provides: build a fresh replica for `siteId`, optionally restored from a
 * previously-captured {@link CoeditSnapshot}. This is exactly the shape of `createRgaDoc`.
 */
export type CoeditDocFactory = (siteId: string, snapshot?: CoeditSnapshot) => CoeditDoc;

/**
 * Run the full {@link CoeditDoc} conformance suite against `make`. Every assertion here is a
 * property the PORT promises and every engine must honour — nothing RGA-specific leaks in.
 */
export function coeditDocContract(make: CoeditDocFactory, t: CoeditContractTestApi): void {
  const { describe, it, expect } = t;

  describe('CoeditDoc contract', () => {
    it('insert writes visible text and length tracks it', () => {
      const doc = make('a');
      doc.insert(0, 'Hello world');
      expect(doc.text()).toBe('Hello world');
      expect(doc.length).toBe(11);
      doc.insert(5, ','); // "Hello, world"
      expect(doc.text()).toBe('Hello, world');
    });

    it('delete removes a run of characters and is bounded at the end', () => {
      const doc = make('a');
      doc.insert(0, 'Hello world');
      doc.delete(5, 6); // drop " world"
      expect(doc.text()).toBe('Hello');
      const ops = doc.delete(4, 99); // ask for far more than remains
      expect(doc.text()).toBe('Hell');
      expect(ops.length).toBe(1); // only the one real character was removed
    });

    it('two replicas CONVERGE under concurrent edits, whatever order ops arrive', () => {
      const alice = make('alice');
      const bob = make('bob');
      const seed = alice.insert(0, 'The fox');
      bob.applyOps(seed);
      // concurrent, overlapping edits from both sites
      const a = alice.insert(3, 'quick '); // "The quick fox"
      const b = bob.insert(bob.length, ' runs'); // "The fox runs"
      // cross-apply in DIFFERENT orders on each side
      alice.applyOps(b);
      bob.applyOps(a);
      expect(alice.text()).toBe(bob.text()); // identical result — the CRDT guarantee
    });

    it('applyOps is idempotent — replaying the same ops changes nothing', () => {
      const alice = make('alice');
      const bob = make('bob');
      const ops = alice.insert(0, 'abc');
      expect(bob.applyOps(ops)).toBe(3); // three inserts newly applied
      expect(bob.applyOps(ops)).toBe(0); // a duplicate delivery is a no-op
      expect(bob.text()).toBe('abc');
    });

    it('snapshot round-trips through the factory and keeps editing', () => {
      const src = make('src');
      src.insert(0, 'persist me');
      const restored = make('restored', src.snapshot());
      expect(restored.text()).toBe('persist me');
      restored.insert(restored.length, '!');
      expect(restored.text()).toBe('persist me!');
    });

    it('opsSince + stateVector deliver exactly the missing delta', () => {
      const server = make('server');
      const joiner = make('joiner');
      server.insert(0, 'abc');
      joiner.applyOps(server.opsSince(joiner.stateVector()));
      expect(joiner.text()).toBe('abc');
      // a replica already caught up is owed nothing
      expect(server.opsSince(server.stateVector()).length).toBe(0);
    });

    it('fork is an independent shadow — edits on it never touch the live doc', () => {
      const live = make('live');
      live.insert(0, 'base');
      const shadow = live.fork();
      shadow.insert(shadow.length, ' + speculative');
      expect(shadow.text()).toBe('base + speculative');
      expect(live.text()).toBe('base');
    });

    it('an anchored cursor stays on its character across concurrent inserts', () => {
      const a = make('a');
      const b = make('b');
      a.insert(0, 'Hello world');
      b.applyOps(a.opsSince(b.stateVector()));
      const anchor = b.anchor(5); // just after "Hello"
      const ins = a.insert(0, '>> '); // someone inserts BEFORE the cursor
      b.applyOps(ins);
      expect(b.text()).toBe('>> Hello world');
      expect(b.resolve(anchor)).toBe(8); // the cursor followed its character
    });
  });
}
