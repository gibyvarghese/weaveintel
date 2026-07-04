// SPDX-License-Identifier: MIT
/**
 * Tree-shaking guard for the subpath-exported tool library.
 *
 * `@weaveintel/tools` bundles ~20 integrations (Gmail, Slack, market data, …) behind SUBPATH imports so a
 * consumer that only wants `@weaveintel/tools/gmail` pays for gmail — not for marketdata, a broker feed, or
 * every other integration. This test proves that isolation is real: it bundles a single subpath entry and
 * asserts the resulting module graph does NOT reach a sibling subpath's code. If someone adds a shared
 * import that couples the subpaths (or re-exports them all from the root), this test fails.
 *
 * It bundles the built `dist/` entry with esbuild's metafile — the canonical "what actually got pulled in"
 * trace — rather than trusting `sideEffects: false` alone.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));

/** Bundle one built subpath entry and return the set of input files esbuild pulled into the graph. */
async function inputsFor(entrySubpath: string): Promise<string[]> {
  const result = await build({
    entryPoints: [distDir + entrySubpath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    metafile: true,
    // Keep third-party deps external so we only trace OUR module graph (the point is subpath isolation,
    // not bundling node_modules). @weaveintel/* stay in the graph so cross-subpath coupling would show.
    packages: 'external',
  });
  return Object.keys(result.metafile.inputs);
}

describe('tools subpath tree-shaking', () => {
  it('importing tools/gmail does NOT pull in marketdata (or broker) code', async () => {
    const inputs = await inputsFor('gmail/index.js');
    expect(inputs.some((p) => p.includes('gmail'))).toBe(true); // sanity: we did trace gmail
    expect(inputs.some((p) => /\/marketdata\//.test(p))).toBe(false);
    expect(inputs.some((p) => /\/broker\//.test(p))).toBe(false);
    expect(inputs.some((p) => /\/slack\//.test(p))).toBe(false);
  });

  it('importing tools/marketdata does NOT pull in gmail code', async () => {
    const inputs = await inputsFor('marketdata/index.js');
    expect(inputs.some((p) => /\/marketdata\//.test(p))).toBe(true);
    expect(inputs.some((p) => /\/gmail\//.test(p))).toBe(false);
  });

  it('the ROOT entry stays lean — it does not re-export the heavy integrations', async () => {
    const inputs = await inputsFor('index.js');
    for (const heavy of ['gmail', 'marketdata', 'slack', 'broker', 'dropbox', 'imap']) {
      expect(inputs.some((p) => new RegExp(`/${heavy}/`).test(p))).toBe(false);
    }
  });
});
