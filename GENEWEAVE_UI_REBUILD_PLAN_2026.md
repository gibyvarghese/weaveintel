# geneWeave UI — enterprise, cross‑platform rebuild plan (design‑system first)

**Goal.** Bring the shipped geneWeave web UI to the high‑fidelity `*.dc.html` design language, make it
enterprise‑grade and *responsive across web / tablet / mobile* (and native‑ready), by **extending what
already exists** — not forking a second app. This document is the "right way to change the existing UI":
the structure, the design‑system contract, and the migration order. It is grounded in the design
references (`GeneWeave Design System/*.dc.html`) and in current industry practice.

## What the research says (and why we're doing it this way)

- **Design tokens are the contract.** The W3C **Design Tokens Format (DTCG) reached its first stable
  version (v2025.10)**, backed by Adobe/Google/Meta/Figma. The single highest‑ROI move in a design‑system
  overhaul is adopting **W3C tokens with a three‑tier architecture** (primitives → semantic → component) as
  *one source of truth that drives every platform* — web, iOS, Android, RN — higher ROI than rewriting
  components. Tooling: **Style Dictionary** transforms one token file into CSS custom properties (web),
  `UIColor` (iOS), etc. Sources: designtokens.org, w3.org/community/design-tokens, styledictionary.com.
- **Responsive *components*, not just pages.** 2026 practice is fluid/responsive by default, using
  **container queries** (baseline since 2023, >90% support) so each panel adapts to *its* space; plus an
  **adaptive navigation** pattern — persistent rails on desktop that become **drawers / bottom‑sheets** on
  small screens (Notion/Figma model), with full keyboard + focus management. Explicitly treat the
  **600–900px** range (foldables, small tablets), not just 320/768/1024. Sources: Android adaptive‑layout
  guides, uxpin, framer breakpoints‑2026.

## The one lucky break: our token package already exists and is correct

`@geneweave/tokens` (`clients/tokens`, zero‑dep, framework‑agnostic, **consumed today by the React‑Native
mobile app**) already encodes the exact `dc.html` design:

- `lightColors` = **canvas `#F6F8F7` · surface `#FFFFFF` · hairline `#E7ECEA` · ink `#14201B` · muted
  `#5E6E67` · emerald `#0E9A6E` · emerald‑press `#0B7A57` · mint `#E8F5EE` · mint‑deep `#DCEFE5` · paper
  `#FBF8F1` · coral `#D85A30` · amber `#D98A3D` · highlighters · diff**  — verbatim to the spec.
- fonts = **Plus Jakarta Sans / Inter / JetBrains Mono / Caveat** — verbatim.
- **dark** palette, **WCAG‑AA contrast verified by tests**, a **4‑pt spacing grid**, radii, elevation,
  motion, and **per‑tenant white‑label theming** (`resolveTenantTheme`/`applyTenantTheme`) that *degrades a
  failing override to the accessible base* — i.e. enterprise theming is already solved.

So the web UI has been reinventing tokens in `apps/geneweave-ui/src/ui/styles.ts` (its own `:root` with
`--bg`/`--accent`/…). **The fix is to make `@geneweave/tokens` the single source of truth for web too.**

## Target architecture (three tiers, one source, every platform)

```
@geneweave/tokens  ── the DTCG‑shaped single source of truth (colors/type/space/radii/elevation/motion,
   │                   dark+light, pro/creative variants, breakpoints, per‑tenant overrides, AA‑audited)
   ├── web:    themeCss()  → CSS custom properties (:root + [data-theme=dark] + [data-variant=creative])
   │             ⇒ apps/geneweave-ui consumes these `--gw-*` vars (styles.ts stops hard‑coding hex/px)
   ├── native: the typed TS `themes` object            ⇒ clients/mobile (already)
   └── future: Style‑Dictionary transforms for iOS/Android when native apps land
```

- **Primitives** = raw palette (`palette.ts`). **Semantic** = role tokens (`background`, `ai.surface`=mint,
  `ai.signal`=emerald, `action.primary`, `text`, …) already role‑named in `ColorTokens`. **Component** =
  a thin per‑component layer we add only where needed (e.g. `--gw-assistant-bubble-bg`).
- **Color encodes agency stays a token, not a convention:** `mint`/`mintDeep`/`emerald`/`coral`/`amber`
  are first‑class tokens; AI surfaces use `ai.*`, user content uses neutrals. Nothing crosses the line.

## Responsive & cross‑platform strategy (web now, native‑ready)

- **Breakpoints** (added to the token package): `mobile <600`, `foldable 600–899`, `tablet 900–1199`,
  `desktop 1200–1599`, `wide ≥1600`. Exposed as tokens + `@media`/container‑query helpers.
- **Adaptive shell:** the left notebook rail and right assistant rail are **persistent side panels ≥ tablet**
  and become **overlay drawers / bottom‑sheets < tablet** (slide over, close on outside‑tap/Esc, focus‑trap).
  The Notes 1/2/3 columns **clamp to 1 on mobile, ≤2 on tablet**. Popovers (Insert, ⋯, Outline/Links, Ask‑AI,
  account, share) reposition and, on mobile, dock as sheets.
- **Container queries** for each panel so components are independently responsive.
- **A11y:** 44px min hit targets, visible focus rings (emerald on mint), full keyboard nav for every
  menu/dialog, ARIA roles, `prefers-reduced-motion` respected (already present), reduced‑transparency safe.

## Migration order (extend, ship in slices, never break the running app)

1. **Foundation (this slice).** Extend `@geneweave/tokens`: add a **web CSS‑variable emitter** (`css.ts`:
   `toCssVariables`, `themeCss`), **breakpoints**, and **pro/creative** surface variants. Wire the web UI to
   consume `--gw-*` (styles.ts `:root` generated from the tokens; keep legacy `--bg`/`--accent` as aliases so
   nothing regresses). Add the responsive breakpoint scaffold + adaptive‑nav CSS. Tests + docs.
2. **Notes screen** to full `dc.html` fidelity + responsive: sidebar/toolbar/columns/assistant/insert‑capture/
   share, using the shared primitives. Visual‑diff vs reference; deviation list.
3. **Shared primitives** package pass: promote the ad‑hoc dropdown/menu/dialog/popover/toast into reusable,
   accessible, tokenized primitives (web), specced so native can mirror them.
4. **Account, Builder, Society + Society Templates** — reuse primitives; diff each vs reference.
5. **DB‑backed appearance config** via the Builder module (`weavenotes_settings` already has `default_theme`
   pro/creative + `agency_color_enabled`; extend with default color‑scheme (system/light/dark) + density,
   and a per‑tenant theme override that feeds `resolveTenantTheme`).

## Testing (every slice)

- **Package:** `@geneweave/tokens` unit tests — emitter output shape, AA‑audit stays green, pro/creative +
  breakpoint correctness, tenant override still AA‑safe. Positive/negative/stress/security (untrusted tenant
  override can't inject CSS).
- **App API:** appearance settings round‑trip + Builder admin.
- **Playwright UI:** screenshot each screen at mobile/tablet/desktop widths; review against the matching
  `design_handoff_geneweave/*.dc.html`; assert the color‑encodes‑agency invariants (AI on mint, user neutral).
- Run on **dev + test servers**, restart after changes. Real‑LLM where AI surfaces are involved.

## Non‑goals / deferred
Full Style‑Dictionary iOS/Android transforms (added when native apps are built); a router rewrite (kept
imperative for now, URL‑drive later); the WCAG‑AA *audit* of every existing screen (tracked separately).
