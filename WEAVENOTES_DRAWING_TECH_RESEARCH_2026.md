# weaveNotes — "Draw" diagnosis + detailed-drawing technology research (mid-2026)

## 1. Why "draw the human heart" produced something that isn't a heart

Reproduced end-to-end (real LLM, screenshots in scratchpad: `heart-1-diagram.png`, `heart-2-illustration.png`).

### What the "draw a diagram" path actually does
- **Endpoint**: `POST /api/me/notes/:id/ai/diagram` → `createDiagramInner` (`note-creative-sql.ts`).
- **Inputs sent to the model**:
  - `system`: *"You design a small, clear diagram as JSON: {kind: flow|mindmap|graph, nodes[…], edges[…]} … at most 8 nodes. Output ONLY the JSON."*
  - `user`: `"<instruction>\n\nNote context:\n<first 3000 chars of the note markdown>"`
  - `temperature: 0.3, maxTokens: 1200`, model = the geneWeave default text model (gpt‑4o‑mini / Claude — a **text** model).
- **What comes back**: a `DiagramScene` JSON of **nodes + edges**, e.g. for "Draw the human heart" the model returned a perfectly sensible **blood‑circulation flowchart**: `Vena Cava → Right Atrium → Right Ventricle → Pulmonary Artery → Lungs → Left Atrium → Left Ventricle → Aorta` (8 ellipses/boxes joined by arrows).
- **Rendered**: `diagramToSvg(scene, {style:'sketch'})` → boxes/ellipses + arrows.

### Root cause: wrong TOOL, not a bad model
The diagram tool **structurally can only emit boxes-and-arrows**. It can never produce a heart *shape* — so "draw a heart" via `create_diagram` will always be a flowchart of heart parts, which is exactly what you saw.

When the **same request** is sent to `create_illustration` instead, the model authored an actual **heart shape** (red, four labelled chambers) — recognisably a heart. So the capability exists; the request was simply routed to the wrong tool.

### Is the right model being used?
- For **diagram JSON** the text model is fine — it did its job correctly.
- For a **detailed illustration**, a text model hand‑writing SVG is the weak link: gpt‑4o‑mini produced only a ~1.6 KB stylised "valentine" heart, not an anatomical one. A stronger text model (Claude Sonnet/Opus) authors much richer SVG.
- For a **realistic anatomical picture** you need an **image model** (gpt‑image‑1 / open diffusion). That path (`generate_image`) exists but is **off by default** (`imageGenerationEnabled: false`, costs money).

### Immediate fix (no new tech, free)
1. Route organic/anatomical "draw X" requests to `create_illustration` (or `generate_image` when enabled), **not** `create_diagram`. The `classifyVisual` heuristic already favours illustration for `anatom|cross-section|drawing of|picture of` — but the **UI "Make a diagram" button and the agent picking `create_diagram` bypass it**. Tighten the tool descriptions so the agent only picks `create_diagram` for processes/relationships, and make the UI "Draw" default to `auto` (which classifies) rather than forcing `diagram`.
2. For real pictures, turn on image generation (`imageGenerationEnabled: true`) with gpt‑image‑1, or wire an open model (below).

---

## 2. Mid‑2026 technologies for detailed drawing / sketching (licensing-checked)

Licenses verified via GitHub API / project sites on 2026‑06‑29.

### ✅ MIT — safe to vendor/extend
| Tech | What it gives us | License | Notes |
|---|---|---|---|
| **rough.js** | Hand‑drawn/sketchy stroke rendering | **MIT** | Already used in our diagram renderer. |
| **perfect-freehand** | Pressure‑sensitive freehand ink strokes | **MIT** | Spec already referenced it; pairs with our ink canvas. |
| **Mermaid** | Real flow/sequence/class/ER/state/mindmap diagrams; supports `look:'handDrawn'` (via rough.js) | **MIT** | Big upgrade over our 8‑node box renderer **for diagrams**. |
| **Excalidraw** (`@excalidraw/excalidraw`, `@excalidraw/mermaid-to-excalidraw`) | Editable infinite‑canvas scene + element schema; the spec's original "Excalidraw scene" idea | **MIT** | Richer editable diagrams; heavier React dependency. |
| **Two.js** | 2D drawing API → SVG/Canvas/WebGL | **MIT** | Programmatic vector composition. |
| **SVG.js** | Tiny SVG build/animate API | **MIT** (LICENSE is MIT text; GitHub mislabels as "Other") | Lightweight server/client SVG authoring. |
| **SVGDreamer** (`ximinng/SVGDreamer`, CVPR'24) + SVGDreamer++ | **Text → editable SVG** via diffusion (semantic objects) | **MIT** | Could generate detailed, *editable* vector art server‑side. GPU/diffusion — heavy; self‑host only. |

### ⚠️ Permissive but NOT MIT — usable, document the terms
| Tech | License | Caveat |
|---|---|---|
| **Paper.js** | MIT per project site; GitHub flags "Other" | Verify the exact LICENSE before vendoring. |
| **Snap.svg** | **Apache‑2.0** | Fine for commercial, but Apache (patent/NOTICE terms), not MIT. |
| **FLUX.1‑schnell** | **Apache‑2.0** (open weights) | Real image gen, commercial OK. |
| **FLUX.2 [klein] 4B** | **Apache‑2.0** | The commercial‑friendly FLUX.2 variant. |
| **Qwen‑Image**, **Z‑Image‑Turbo** | **Apache‑2.0** | Real image gen, fully permissive commercial. |
| **Stable Diffusion 3.5** | "Apache‑2.0‑like" community license | Mostly permissive; read the SAI community terms. |
| **NeuralSVG / DiffSketcher / Reason‑SVG** | research code, license varies | Confirm per‑repo before use. |

### ❌ NOT MIT / restricted — avoid unless we license them
| Tech | License | Why it's a problem |
|---|---|---|
| **tldraw** | Proprietary **tldraw SDK License** | Requires a **license key** in production; **"made with tldraw" watermark** on the hobby tier; commercial deployment needs a paid commercial agreement. Not MIT — do **not** embed without licensing. |
| **FLUX.1‑dev**, **FLUX.2 [dev]** | Non‑commercial weights | Free only for non‑commercial; **commercial license required** from Black Forest Labs. |
| **SDXL** | **CreativeML OpenRAIL‑M** | Usage restrictions (acceptable‑use clauses); not a pure permissive licence. |
| **Recraft** (text→vector) | Commercial **SaaS** | Paid API/ToS, not open source. |
| **gpt‑image‑1** (OpenAI) | Commercial **API** (a service, no code license) | Fine to *call* (it's already wired) — it's a paid service, not something we redistribute. |

---

## 3. Recommended path (ranked)

1. **Fix tool routing (today, free):** stop sending "draw a heart/anatomy/picture" to `create_diagram`; default the UI "Draw" to `auto`/illustration and sharpen the agent tool descriptions. This alone turns the flowchart into a real heart.
2. **Enable image generation for realistic art:** gpt‑image‑1 (paid API, already wired) → flip `imageGenerationEnabled`. For self‑hosted/open + commercial: **FLUX.2 [klein]**, **Qwen‑Image**, or **Z‑Image‑Turbo** (all **Apache‑2.0**).
3. **Upgrade vector diagrams with Mermaid (MIT)** when a *diagram* is genuinely wanted — far richer than our 8‑node renderer, with a hand‑drawn look via rough.js (already MIT, already in use).
4. **Optional, advanced:** **SVGDreamer (MIT)** server‑side for detailed *editable* vector illustrations (heavier, GPU).
5. **Avoid tldraw** unless we buy a commercial license + accept the watermark.

**Sources:** tldraw license — https://tldraw.dev/legal/tldraw-license ; SVGDreamer (MIT) — https://github.com/ximinng/SVGDreamer ; open image models + licenses — https://www.bentoml.com/blog/a-guide-to-open-source-image-generation-models ; Mermaid (MIT) — https://github.com/mermaid-js/mermaid/blob/develop/LICENSE ; Excalidraw (MIT) — https://github.com/excalidraw/excalidraw ; Paper.js — https://paperjs.org/about/ ; Two.js — https://two.js.org/ .

---

## 4. Update — AI-authored heart still wrong; sourcing REAL free-to-use images

Re-ran the illustration path with an explicit *"anatomically correct, cross-section, four chambers, aorta, pulmonary artery, vena cava, labelled"* prompt (`heart-now.png`). gpt‑4o‑mini still produces a **malformed double‑lobe blob** with scattered, mis-attached labels — not an anatomical heart. A small text model hand‑writing SVG simply can't draw accurate anatomy. So for "draw/show a heart," the right answer is to **fetch a real, free-to-use image** rather than synthesise one.

### Free-to-use image sources (APIs, tested 2026‑06‑29)

| Source | Best for | Key? | License model | Verified |
|---|---|---|---|---|
| **Openverse** (`api.openverse.org`) | Everything — aggregates 800M+ CC + public-domain images (Wikimedia, Flickr, museums) | **No key** (rate-limited; free key for more) | Per-image CC / CC0 / Public-Domain-Mark; filter `license_type=commercial,modification` | ✅ 139 results for "human heart anatomy" (CC‑BY‑SA + PDM), each with license + creator + source |
| **Wikimedia Commons** (`commons.wikimedia.org/w/api.php`) | **Labelled medical/scientific diagrams** | **No key** | Mostly CC‑BY‑SA / public domain; per-file `extmetadata` license | ✅ returns the canonical **"Heart diagram-en.svg"** (accurate labelled cross-section, CC‑BY‑SA‑3.0) |
| **Unsplash** | High-quality photos | Free key | Unsplash License — free commercial, attribution optional | API key needed |
| **Pexels** | Photos/videos | Free key | Pexels License — free commercial, attribution appreciated | API key needed |
| **Pixabay** | Photos + vectors | Free key | Pixabay Content License — free commercial | API key needed |
| **Openclipart** | CC0 clip-art / SVG | No key | **CC0** (public domain) | Good for icons/simple art |

### Licensing tiers — "free to use" is not uniform (must be handled)
- **CC0 / Public-Domain-Mark** → truly free, **no attribution** required. Safest default.
- **CC‑BY** → free, **attribution required** (credit creator + link).
- **CC‑BY‑SA** → free, **attribution + ShareAlike** (derivatives under the same licence). The Wikimedia heart diagram is BY‑SA‑3.0.
- **Unsplash / Pexels / Pixabay** → free for commercial use, attribution optional (their own licences, not CC).

### Recommended capability: `find_image` (source a real, attributed, free image)
1. **Route**: "show / insert / add a picture/photo/real image of X" (and organic "draw X" where a photo/diagram beats AI art) → `find_image`, not `create_diagram`/`create_illustration`.
2. **Providers**: **Openverse** (default, no key, CC+PD) + **Wikimedia Commons** (for diagrams). Optional Unsplash/Pexels/Pixabay (free keys) for photos.
3. **License safety**: query with `license_type=commercial,modification`; **prefer CC0/PDM**; **always capture + display attribution + licence** in a caption under the image (like our citations). Make **CC‑BY‑SA opt-in** (ShareAlike obligation) and let an admin restrict allowed licence types.
4. **Safety/robustness**: fetch the chosen image **server-side through the existing SSRF guard** (as `capture_web_page` does), validate it's an image, cap size, store as an **artifact**, and embed same-origin (`/api/artifacts/:id/data`) — no hot-linking.
5. **Config (per-tenant, like Action Routing)**: `image_search_enabled`, provider, allowed licence types, attribution-required toggle — Builder-editable.

This gives "draw a heart" a path to the real, textbook‑accurate, free‑to‑use heart diagram (e.g. Wikimedia's, with attribution), instead of a synthesised blob.

**Sources:** Openverse API — https://api.openverse.org/v1/ ; Openverse licences — https://openverse.org/ ; Wikimedia Commons API — https://commons.wikimedia.org/w/api.php ; Creative Commons licences — https://creativecommons.org/about/cclicenses/ ; Unsplash License — https://unsplash.com/license ; Pexels License — https://www.pexels.com/license/ ; Pixabay License — https://pixabay.com/service/license-summary/ .

---

## 5. IMPLEMENTED — `find_image`: source a real, free-to-use image (hardened fetch)

Shipped the recommendation from §4. "Draw the human heart" can now return a **real, accurate, free-to-use** heart image (verified: a CC0 public-domain anatomical heart from Openverse, rendered with a credit line) instead of an AI blob.

- **Providers**: Openverse (default, no key) + Wikimedia Commons (no key) + Unsplash / Pexels / Pixabay (free keys via `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY`). Falls back to the no-key providers when the configured one yields nothing.
- **Hardened fetch**: BOTH the provider search AND the image download go through `hardenedFetch` (`@weaveintel/core`) — SSRF guard (cloud-metadata, RFC-1918, DNS-rebinding), HTTPS enforcement, redirect re-validation, timeout, and a 12 MiB size cap — plus an `isSafePublicUrl` pre-check. The download also validates the response is really `image/*`. The image is stored as a binary artifact and embedded same-origin (`/api/artifacts/:id/data`) — never hot-linked.
- **Licence safety**: queries restrict to commercial+modifiable; results are filtered to a configurable allow-list (default `cc0/pdm/by/by-sa/unsplash/pexels/pixabay` — **NC/ND excluded**); public-domain is preferred; every image carries a **licence + attribution caption** with a source link (required for CC-BY/BY-SA).
- **Governance**: Builder settings (weaveNotes → Settings: enabled / provider / allowed-licences / require-attribution) + per-tenant routing (weaveNotes → Action Routing: `find_image`, default `direct`). Agent tool `find_image` is catalogued + granted to the weaveNotes Editor worker.
- **Tests**: 13 unit (licence normalise/filter, attribution, URL builders, parsers) + 3 real-LLM/real-web e2e (sources + renders a real heart with attribution; registration; config gating). Fixed a latent artifact bug along the way: base64 image `data` was stored as text → served as broken `image/png`; now decoded to a binary blob (also fixed for `generate_image`).

---

## 6. find_image — smarter selection (a few tries, summarised, context-aware)

Improved `find_image` so it identifies the RIGHT image instead of the first hit:
- **Summarise the request**: a long SELECTED passage (or any text) is condensed by the model into 1–3 SHORT, focused image-search queries (e.g. a 500-char heart paragraph → "human heart anatomy"), with a couple of variants tried.
- **Gather several candidates** across those queries (deduped, only allowed free-to-use licences).
- **Context-aware pick**: the model orders the candidates BEST-first by how well each (title / creator / licence / provider) fits the request AND the note's context — a real decision over a few options, not "whatever came first". This runs in every routing mode (direct / agent / supervisor); when routed via the supervisor it's the worker that performs it.
- **Download in that order** with fallback, so a dead/blocked URL drops to the next-best candidate.

Verified: the same "human heart" request now selects a more on-point anatomical image, and a 500-char selected paragraph is summarised to "human heart anatomy" before searching. (e2e + the prior 13 unit / hardened-fetch tests still green.)

---

## 7. find_image — per-user image LANGUAGE (default English)

A sourced image's labels (especially diagrams) can be in any language. Each USER now has a preferred
image language (default **English**), stored in the database (`user_preferences.notes_image_language`,
m119) and editable via `GET`/`PUT /api/me/notes-image-language` (and a language dropdown on the AI
Visualize card). find_image uses it three ways: it writes the search queries in that language,
sinks clearly-other-language titles (e.g. a "…-fr.svg" diagram) below same/neutral ones, and tells
the model to prefer that language when picking the best candidate. Pure helpers (normalizeLanguage /
detectTitleLanguage / titleLanguageMismatch / applyLanguagePreference) are unit-tested.
