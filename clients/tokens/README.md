# @weaveintel/tokens

**A tiny, brand-neutral theming engine.** You give it a palette; it gives you an accessible, themeable
design-token system — CSS variables for the web, the same tokens for native, WCAG-AA checking, and
safe per-tenant white-labelling. Zero runtime dependencies.

## Why it exists (the plain version)

Most "design token" packages ARE a specific product's colours. That is convenient for that product and
useless for everyone else. This package is the opposite: it is the **machinery**, and your palette is
**input**. So a team can adopt the accessibility checking, the CSS transform, and the white-label
plumbing without inheriting anyone's brand — and swap in their own colours, fonts, and CSS variable
names. (It follows the three-layer token model the [W3C Design Tokens spec](https://www.w3.org/community/design-tokens/)
settled on in 2025: raw palette → semantic roles → the CSS your components read.)

It ships a NEUTRAL reference palette (a slate + blue set, WCAG-AA verified) so it works and demos out of
the box — but that is a placeholder for your brand, not "the" brand.

## When to reach for it

- **Reach for it** when you want a themeable UI (light/dark, per-tenant white-label) with accessibility
  guaranteed, and you want to own your palette.
- **Don't** hand-roll `--my-color-*` CSS variables + a contrast checker + a tenant-override merge — that
  is exactly what this is.

## How to use it

**1 — bring your palette and turn it into CSS variables:**

```ts
import { toCssVariables, neutralThemes, type ColorTokens } from '@weaveintel/tokens';

// Your brand palette (same shape as ColorTokens), or start from the neutral default:
const myLight = { ...neutralThemes.light.colors, accent: '#7C3AED' /* your colour */ };
const theme = { ...neutralThemes.light, colors: myLight };

const vars = toCssVariables(theme, { prefix: 'brand' });
// → { '--brand-color-accent': '#7C3AED', '--brand-space-lg': '16px', ... }
```

The **prefix is yours** (default `wv`). Your components then read `var(--brand-color-accent)`; your app
assembles the full stylesheet (light/dark selectors, any component tokens) however it likes.

**2 — check accessibility (WCAG-AA):**

```ts
import { auditThemeContrast, contrastRatio, meetsAA } from '@weaveintel/tokens';

auditThemeContrast(theme).pass;          // false if any text-on-surface pair fails AA
meetsAA(contrastRatio('#333', '#fff'));  // true
```

**3 — safe per-tenant white-labelling:** let a customer re-brand — accent, fonts, corners — but **never**
below AA. A failing override is dropped and that theme keeps its accessible default:

```ts
import { tenantThemeVars } from '@weaveintel/tokens';

const bases = { light: theme, dark: myDarkTheme };
const { light, dark, degraded } = tenantThemeVars(bases, { colors: { accent: '#0055FF' } }, { prefix: 'brand' });
// `light`/`dark` = only the CHANGED --brand-* vars; apply at runtime with
// documentElement.style.setProperty(...). `degraded` is true if a theme fell back for accessibility.
```

## What's in the box

| Export | What it is |
|---|---|
| `toCssVariables(theme, { prefix })` | One theme → a flat `--<prefix>-*` CSS-variable map. |
| `tenantThemeVars` / `tenantThemeCss` | Per-tenant white-label: only the changed vars, AA-enforced. |
| `resolveTenantTheme` / `applyTenantTheme` | Merge an override over a base theme (pure); enforce contrast. |
| `auditThemeContrast` / `contrastRatio` / `meetsAA` | WCAG-AA colour maths + a full theme audit. |
| `neutralThemes` / `neutralDark` / `neutralLight` / `defaultTheme` | The neutral reference palette (your starting point). |
| generic scales | `spacing`, `radii`, `typeScale`, `motion`, `breakpoints`, elevation — sensible defaults. |
| types | `ColorTokens`, `Theme`, `TenantThemeOverride`, … — the token schema your palette fills in. |

## A worked brand

Want to see a real product build its identity on this engine? The geneWeave app composes its emerald
palette, fonts, `--gw-*` names, and full stylesheet on top of these primitives in
`apps/geneweave-ui/src/brand/` — the engine stays brand-free; the brand lives with the app.

## License

MIT.
