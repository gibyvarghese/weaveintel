// Build step: generate the geneWeave design-token CSS from @geneweave/tokens (the single source of
// truth shared with the native app) into a plain string module. This runs in NODE at build time — the
// browser-served styles.ts must NOT import @geneweave/tokens directly (raw-served ESM can't resolve a
// bare workspace specifier), so we inline the generated CSS as a literal string instead.
import { themeCss } from '@geneweave/tokens';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../src/ui/tokens.generated.ts', import.meta.url));
const css = themeCss();
const banner = '// AUTO-GENERATED from @geneweave/tokens by scripts/gen-tokens-css.mjs — do not edit by hand.\n// Run `npm run build` (or `node scripts/gen-tokens-css.mjs`) to regenerate.\n';
writeFileSync(out, `${banner}/* eslint-disable */\nexport const TOKENS_CSS = ${JSON.stringify(css)};\n`);
process.stdout.write(`[gen-tokens-css] wrote ${css.length} bytes of design-token CSS → ${out}\n`);
