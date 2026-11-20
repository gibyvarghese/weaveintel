/**
 * @weaveintel/sandbox — the scratch folder a run leaves behind
 *
 * WHAT THIS FILE IS (plain language)
 * Proof that clearing away a finished run's temporary folder can never be the reason a run is
 * reported as having failed.
 *
 * WHY IT EXISTS. Every execution gets a temporary folder on the host: the container reads its code
 * from it and writes results into it. Removing that folder used to happen in a `finally` — and a
 * `finally` that throws REPLACES whatever the function was about to return. On macOS the container
 * releases its mount of the folder a moment after the process exits, so a deletion issued immediately
 * is refused with EACCES, and `force: true` forgives a folder that is already GONE rather than one the
 * operating system will not let you touch yet.
 *
 * The visible result was a run whose code had executed perfectly, whose output was already in hand,
 * coming back to the caller as "the sandbox failed to run the code". With one run at a time it almost
 * never happened. Measured with forty at once: it happened forty times out of forty.
 */
import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardScratchFolder } from './base.js';

describe('clearing away a finished run’s scratch folder', () => {
  it('removes a folder it is allowed to remove', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wi_scratch_'));
    await mkdir(join(folder, 'output'));
    await discardScratchFolder(folder);
    expect(existsSync(folder), 'the folder should be gone').toBe(false);
  });

  it('says nothing and throws nothing when the folder is already gone', async () => {
    // The ordinary race in the other direction: something else tidied up first. That is success.
    const folder = await mkdtemp(join(tmpdir(), 'wi_scratch_'));
    await discardScratchFolder(folder);
    await expect(discardScratchFolder(folder)).resolves.toBeUndefined();
  });

  it('NEVER throws when the folder cannot be removed, because the run itself succeeded', async () => {
    // **THE WHOLE POINT.** A caller is holding a completed run's output. Whatever happens to a
    // temporary folder must not take that away from them.
    const parent = await mkdtemp(join(tmpdir(), 'wi_locked_'));
    const trapped = join(parent, 'output');
    await mkdir(trapped);
    // Read and execute only: the process may look inside but may not remove anything from it.
    await chmod(parent, 0o500);
    try {
      await expect(discardScratchFolder(trapped, 3, 5), 'a tidy-up must never become the caller’s error').resolves.toBeUndefined();
    } finally {
      // Put the permissions back, or the temporary directory cannot be cleared afterwards.
      await chmod(parent, 0o700);
    }
  });

  it('gives up rather than retrying for ever, so a run cannot hang on housekeeping', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wi_locked_'));
    const trapped = join(parent, 'output');
    await mkdir(trapped);
    await chmod(parent, 0o500);
    try {
      const started = Date.now();
      await discardScratchFolder(trapped, 3, 5);
      // Three attempts waiting 5ms then 10ms: tens of milliseconds, not seconds. The exact figure is
      // not asserted — only that it is bounded, because a machine under load makes any tight bound a
      // test that fails for reasons no code caused.
      expect(Date.now() - started, 'giving up must be quick').toBeLessThan(2_000);
    } finally {
      await chmod(parent, 0o700);
    }
  });
});
