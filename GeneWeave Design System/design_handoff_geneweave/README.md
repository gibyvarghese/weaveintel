# Handoff: geneWeave — design system, Builder, and Notes editor

## Overview
geneWeave is a calm, conversation-first AI assistant. This package covers three connected
design surfaces that share one visual language:

1. **Design system reference** — the tokens, type, logo, components, and copy rules.
2. **Builder mode** — the enterprise/admin config area (master–detail collection + record editor).
3. **Notes editor** — the collaborative notes app where the AI co-authors the page.

The unifying idea across all three is **"color encodes agency":** everything the *user* owns is
rendered in calm neutrals; everything the *AI* is or creates wears a soft emerald-mint signal
(mint surfaces, a woven mark, a byline, an emerald left-edge). One glance shows who did what.

## About the design files
The files in this bundle are **design references created in HTML** — prototypes showing the
intended look and behavior, **not production code to copy directly**. They are authored as
"Design Components" (`*.dc.html`) that render through a small runtime (`support.js`, included so
the files open in a browser).

The task is to **recreate these designs in the target codebase's existing environment** (React,
Vue, SwiftUI, native, etc.) using its established component library, patterns, and tokens. If no
environment exists yet, choose the most appropriate framework and implement them there. Do not
ship the HTML or the `support.js` runtime as production code — read them as a precise spec.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, and interactions are all specified.
Recreate the UI faithfully using the codebase's libraries. Exact hex/px values are in the
**Design Tokens** section and inline in each HTML file's `style=""` attributes.

---

## Screens / Views

### 1. Design system reference — `GeneWeave Design System.dc.html`
A single scrolling document (max-width 1040px, centered, 80px section rhythm) on the `canvas`
background. Purpose: the source of truth for anyone building geneWeave. Sections, in order:

- **Cover** — woven-mark logo + wordmark, display headline (Plus Jakarta Sans 56px/800,
  -0.03em), intro paragraph, vibe chips.
- **01 Principle — "color encodes agency"** — two cards contrasting "what you own" (ink bubble)
  vs "what the assistant touches" (mint bubble + emerald left-edge + woven mark).
- **02 Logo & wordmark** — the woven mark (two interlaced strokes: emerald = assistant, ink =
  you) in three lockups (primary, on-mint, reversed-on-ink), plus clear-space / min-size / don't
  rules. Wordmark: `gene` in muted 600 + `Weave` in ink 700, always lowercase g.
- **03 Color** — swatch grid for Neutrals and Signal tokens (each with name, hex, usage) + a
  dark-mode strip.
- **04 Typography** — three type-role cards + a specimen list (display → meta).
- **05 Spacing, shape & depth** — 8px scale, radius samples (12/16/full), two elevation levels.
- **06 Buttons & forms** — button variants, fields (default/focused/attach), and the composer pill.
- **07 Cards & data display** — the signature **agent action card** shown both in a chat thread
  and mirrored in the right "Today" rail; left-nav item states; the Notes selection-AI pill.
- **08 Plain language** — a before→after table mapping system-internal nouns to user-facing
  labels, plus Do/Don't lists.

### 2. Builder mode — `GeneWeave Builder.dc.html`
A full-height (100vh) three-column app shell. Purpose: let admins configure the assistant using
two reusable, schema-driven patterns — a **collection view** and a **record editor** — so every
resource type looks and behaves the same.

- **Left rail (220px, white, right hairline border):** logo; "ASSISTANT SETUP" group with plain-
  language nav (Instructions, Version history, Building blocks [active], Response formats, Thinking
  styles, Auto-tuning); a lower group (Workflows, Request handling, Rules & limits, Connected
  apps); footer with "Switch to Daily" and the account row. Active nav item = mint pill, emerald
  dot, 600 weight.
- **Collection pane (360px, white, right hairline):** header with title "Building blocks" +
  record count + filled-emerald "+ New"; a search field + filter button; a column header row
  (NAME ↕ / STATUS). Rows are clickable (status dot, name, mono key/"shortcut", On/Off pill).
  Active row = mint background + inset 2px emerald left bar. Footer: "1–4 of 4" + prev/next.
- **Record editor pane (flex, canvas background):** sticky header (eyebrow + record name + ⋯
  overflow). Scrolling form, single column, max-width 640px, grouped into hairline-separated
  sections with emerald mono labels: **BASICS** (Shortcut [mono input + `{{>key}}` help], Name),
  **THE BLOCK** (What it's for [textarea], Block text [dark monospace code editor with format
  tab + char count]), **DETAILS** (Fill-in values [JSON editor with Format button + inline
  validation], Labels [chip input], Version [mono]), **AVAILABILITY** (Active [toggle switch +
  helper]). A "Danger zone" card (warm/amber tint) holds Delete, demoted out of the action row.
  **Sticky bottom action bar:** dirty-state indicator + Cancel (ghost) + Save (emerald).

### 3. Notes editor — `GeneWeave Notes.dc.html`
A full-height three-column collaborative editor. Purpose: a page the user shares with the AI;
the AI writes, edits, and diagrams alongside them. Colour-encoded authorship throughout.

- **Left rail (248px):** logo; search field (with ⌘K hint); notebook tree (Personal collapsed;
  Work expanded → "Matter & its states" [active, mint], "Standup notes", "Ideas"); "New note"
  button with a "templates" hint.
- **Centre canvas:** sticky top bar (breadcrumb · presence avatars [you = ink "G", AI = mint
  woven mark] · **Pro/Creative theme toggle** · "+ Insert"); a tool strip (bold/italic/underline ·
  four highlighter swatches · pen/shape [+ ✨ sticker in Creative] · "Ask AI"). The page (max-
  width 720px) holds: title; meta line ("geneWeave AI is here"); a paragraph with a highlighter-
  underlined word; the **select-text AI card** (floating, rounded, elevated — prompt line +
  chips: Rewrite/Shorten/Expand/Continue/✦ Make a diagram); an **AI mind map block** (mint frame,
  "geneWeave AI · mind map" byline, central "Matter" node → Solid/Liquid/Gas/Plasma branches,
  "Edit nodes"/"Make mine" actions); a paragraph; an **inline diff** (struck red old text + mint-
  green new text + ✓ Accept / ✕ Reject — interactive); a **human ink doodle** (coral hand-drawn
  arrow + Caveat caption + "you · ink" byline).
- **Right rail (300px):** tabs (Assistant [active] / Outline / Links); an AI participant message
  (mint bubble) with suggestion action buttons; a collapsed "Done · 3.1s · view steps" line; a
  bottom "Ask this note anything…" composer.

---

## Interactions & Behavior
- **Builder — row selection:** clicking a collection row loads that record into the editor pane
  (list stays put — master–detail, never a page jump). Active row gets the mint highlight.
- **Builder — live editing:** editing Name/Shortcut/etc. updates the selected record in place;
  the row in the list reflects Name and On/Off changes immediately.
- **Builder — toggle:** the Active switch animates the knob (transform translateX, 0.18s ease)
  and flips the track color emerald↔grey; the list pill + status dot follow.
- **Builder — JSON validation:** "Fill-in values" is validated on change; invalid JSON shows a
  warm error message under the field and the field border turns warm; "Format" pretty-prints
  valid JSON. Save is blocked while invalid.
- **Builder — dirty state + save:** the action bar shows "Unsaved changes" (amber) vs "All
  changes saved" (grey). Save commits and shows a "Saved" toast (auto-dismiss ~2.2s). Cancel
  reverts the record to its last-saved snapshot.
- **Builder — new record:** "+ New" appends a blank "Untitled block" and selects it.
- **Notes — theme toggle:** Pro ↔ Creative swaps the page surface (#FFFFFF ↔ #FBF8F1), the title
  font (Plus Jakarta Sans ↔ Caveat), the highlighter treatment (soft fill ↔ visible underline
  highlight), and reveals the ✨ sticker tool in Creative.
- **Notes — inline diff:** Accept replaces the text with the AI version + an "AI edit accepted"
  tag; Reject keeps the user's text + a "kept yours" tag. Both remove the action buttons.
- **Motion:** calm and purposeful. Suggested: text/messages fade-and-rise in, diagrams "draw in"
  (stroke-dashoffset), a single soft mint pulse when the AI finishes (`gwpulse` keyframe). Always
  respect `prefers-reduced-motion`.

## State Management
- **Builder:** `records[]` (each: id, key, name, enabled, version, description, content,
  variables[JSON string], tags[]), `selectedId`, a saved-snapshot (`pristine`) for dirty/cancel,
  derived `jsonError`, and a transient `toast` flag. Selecting = set `selectedId`; editing =
  patch the selected record; save = copy current → pristine.
- **Notes:** `theme` ('pro' | 'creative') and `diff` ('pending' | 'accepted' | 'rejected').
- **Design system reference:** static, no state.

## Design Tokens

### Color
| Token | Hex | Use |
|---|---|---|
| canvas | `#F6F8F7` | App background (Pro) |
| paper | `#FBF8F1` | Notes page surface (Creative) |
| surface | `#FFFFFF` | Cards, panels, rails |
| ink | `#14201B` | Primary text |
| muted | `#5E6E67` | Secondary text, labels, resting icons |
| hairline | `#E7ECEA` | Borders, dividers |
| emerald | `#0E9A6E` | Primary action + AI presence (only) |
| emerald-press | `#0B7A57` | Pressed/active, mint-surface text |
| mint | `#E8F5EE` | AI surfaces, agent bubbles, action-card aura, active rows |
| mint-deep | `#DCEFE5` | Hover on mint, mint borders |
| amber | `#D98A3D` | Attention only (overdue, unsaved), sparing |
| coral | `#D85A30` | Human ink / doodles (Notes) |
| highlighters | amber `#FAC775`, pink `#F4C0D1`, teal `#9FE1CB`, blue `#B5D4F4` | Multi-color highlighter set |
| diff added | bg `#E8F5EE`, text `#14201B` | AI-added text |
| diff removed | bg `#FBEFEA`, text `#9c6b5c`, strike-through | Removed text |
| danger zone | bg `#FCF7F2`, border `#F0E0D5`, text `#A8551F` | Demoted destructive actions |
| dark mode | canvas `#0E1714`, surface `#15201C`, ink `#E8EFEB` | Optional Pro dark theme |

### Typography
- **Display / headings:** Plus Jakarta Sans (400/500/600/700/800), tracking tightened ~-0.02 to -0.03em.
- **Body / UI:** Inter (400/500/600).
- **Metadata / code / keys / IDs:** JetBrains Mono (400/500).
- **Handwriting (Notes Creative mode — titles, diagram labels, doodles):** Caveat (500/600/700).
- Scale (px): display 56 (cover) / 34 (app titles) · h1 22 · h2 18–19 · body 15–16 (line-height
  1.6–1.75) · small 13 · meta 11–12 (mono). **Sentence case everywhere.**

### Spacing & shape
- 8px base grid: 8 inline · 16 element · 24 card padding · 32 section padding · 80 section rhythm.
- Radius: 10–12px cards/fields · 14–16px bubbles/composer/AI cards · 999px pills & avatars.
- Elevation: prefer hairlines + faint mint frames. One soft shadow max for floating elements:
  `0 1px 3px rgba(20,32,27,0.06)`; popovers/AI card up to `0 8px 28px rgba(20,32,27,0.12)`.

### Logo
Woven mark = two interlaced rounded strokes in a 34×34 viewBox (paths in the HTML). Emerald strand
= assistant, ink strand = you. Reversed: emerald → `#2FD39B`, ink → `#E8EFEB`.

## Copy / voice rules
Active voice, plain verbs, sentence case. Name things by what the user controls, never by system
internals (this is enforced even in Builder — see the "Plain language" section: e.g. *Fragment* →
*Building block*, *key* → *Shortcut*, *Variables (JSON)* → *Fill-in values*, *enabled: true* →
*Active · On*, *Orchestration* → *Workflows*). Buttons name the result ("Save" → "Saved" toast).
Empty states are invitations. Show On/Off pills, never a raw `1`; show "Not set", never an em-dash.

## Assets
No external image assets. The logo/woven mark and all diagram artwork are inline SVG (paths in the
HTML). Icons are inline SVG (Lucide-style stroke icons) — substitute your codebase's icon set.
A few emoji are used as notebook glyphs in Notes (📓 💼 ✨) — replace with your icon set if preferred.
Fonts load from Google Fonts (Plus Jakarta Sans, Inter, JetBrains Mono, Caveat).

## Files
- `GeneWeave Design System.dc.html` — tokens, type, logo, components, copy rules.
- `GeneWeave Builder.dc.html` — admin collection view + schema-driven record editor.
- `GeneWeave Notes.dc.html` — collaborative notes editor (the hero screen).
- `support.js` — the runtime that renders the `.dc.html` files in a browser. **Reference/preview
  only — do not port to production.**

Open any `.dc.html` in a browser to view it. All visual values are inline in `style=""`
attributes; the logic (state, handlers) is in the `<script data-dc-script>` block at the bottom
of each file.
