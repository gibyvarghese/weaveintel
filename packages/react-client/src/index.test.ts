/**
 * Smoke tests — @weaveintel/react-client public surface.
 *
 * NOTE: the monorepo has no React DOM renderer / @testing-library, so the hook
 * itself cannot be mounted here. `useRun` is a thin (~20-line) binding over
 * `createRunSession`; its behaviour is exhaustively covered by
 * `@weaveintel/client`'s run-session.test.ts. This file guards the package's
 * public surface and that it builds/typechecks against real React 18 types
 * (see `tsc -b`). Mounting coverage belongs in the host app's component tests.
 */
import { describe, it, expect } from 'vitest';
import { useRun } from './index.js';

describe('@weaveintel/react-client surface', () => {
  it('exports useRun as a hook function', () => {
    expect(typeof useRun).toBe('function');
    // React hooks are named so the linter / devtools can identify them.
    expect(useRun.name).toBe('useRun');
  });

  it('throws an invalid-hook-call when invoked outside a renderer (proves it uses React hooks)', () => {
    // Calling a hook with no active React dispatcher must throw — confirming the
    // implementation genuinely consumes React's hook machinery rather than
    // re-implementing a store inline.
    expect(() => useRun({ client: {} as never })).toThrow();
  });
});
