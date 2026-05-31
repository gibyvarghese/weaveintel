import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('.', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // `./stores/` ships opt-in driver-coupled adapters (better-sqlite3, pg,
      // mongodb, redis, dynamodb) via subpath exports + peerDependencies.
      // They are deliberately excluded from the core-only invariant.
      if (name === 'stores') continue;
      walk(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('reusability invariant', () => {
  it('package source imports nothing app-specific', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);
    const forbidden = [
      '@weaveintel/geneweave',
      'apps/geneweave',
      'better-sqlite',
      '@weaveintel/agents',
      '@weaveintel/live-agents',
    ];
    const offences: string[] = [];
    // Match actual `from '...'` import statements (and dynamic `import('...')`)
    // so JSDoc / inline comments mentioning package names don't false-positive.
    const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    for (const file of files) {
      const txt = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(txt)) !== null) {
        const spec = m[1] ?? '';
        for (const f of forbidden) {
          if (spec.includes(f)) offences.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('package depends only on @weaveintel/core and @weaveintel/tools', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    expect(deps).toEqual(['@weaveintel/core', '@weaveintel/tools']);
  });
});
