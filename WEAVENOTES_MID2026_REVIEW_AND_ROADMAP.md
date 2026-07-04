# weaveNotes — Mid‑2026 Capability Review, Gap Analysis & Phased Commercialization Roadmap

**Date:** 2026‑06‑30 · **Branch:** `collab-phase-0` (PR #8) · **Scope:** `@weaveintel/notes`, `@weaveintel/coedit`, `apps/geneweave` (notes server), `apps/geneweave-ui` (notes UI)

This document combines (a) a market scan of the mid‑2026 AI‑notes landscape, (b) a deep engineering review of the weaveNotes codebase (two independent reviews + the author's working knowledge), (c) **evidence from real tests run this session** (real‑LLM + real‑browser Playwright + live web fetches, with screenshots compared against real online content), and (d) a phased plan to take weaveNotes to a commercial‑grade product for **enterprise and public**. The guiding principle is the user's: **quality, not just "doing things"** — when we say "draw the heart," we must produce the *right* image, not *an* image.

---

## 0. Executive summary

**Where we are.** weaveNotes already ships an unusually broad surface for an indie build: a zero‑dependency CRDT co‑editing engine, AI co‑authoring as track‑changes suggestions, creative tools (diagrams/ink/illustration/image), real free‑to‑use **web image sourcing** (hardened, attributed, licence‑filtered, language‑aware), whole‑note restructure, a knowledge graph, databases with AI autofill, flashcards, capture, workspace RAG, version history, comments, synced blocks, templates, publish/export, mobile/desktop scaffolds, **per‑tenant action routing**, and supervisor‑delegated agent execution. Breadth is genuinely strong.

**The honest gap.** Most of the *table‑stakes* capabilities are present but several are **medium or shallow** in depth, and the **two things that differentiate in mid‑2026 — (1) AI that produces genuinely correct visual output, and (2) autonomous, scheduled, workspace‑wide agents — are exactly where we are weakest.** Our diagram engine is boxes‑and‑arrows only with **no accuracy/verification loop**; our AI image path is a small text model authoring SVG (a "wobbly blob" for anatomy) with image‑gen off by default and **no vision verification**; we have **no voice/meeting capture**, **no MCP server exposing the vault**, **no scheduled agents**, and several **enterprise‑blocking** gaps (tenant‑isolation hole in workspace search, no audit trail, no per‑user AI rate limiting, no data‑residency / BYOK / on‑prem story).

**The opportunity.** The 2026 market has converged on a clear recipe for *correct* AI visuals — **code‑first diagrams (Mermaid/D2/SVG) + a generate→render→verify→retry loop**, and **vision‑verified** image sourcing/generation. weaveNotes' hand‑rolled, zero‑dependency, MIT‑licensed creative layer is the *right substrate* to implement that recipe properly. Combined with our existing supervisor/worker agent architecture and per‑tenant governance, weaveNotes can credibly target the "agentic, verifiable, governable notes workspace" position rather than chasing parity.

**Verdict:** ~**65–70% of the way to a credible commercial v1.** The roadmap below sequences the work into 6 phases (P0 hardening → P5 frontier), front‑loading the security/quality fixes that block both enterprise and public launch.

---

## 1. The mid‑2026 market — what's table‑stakes vs what differentiates

Synthesized from primary vendor sources for Notion, Microsoft 365 Copilot, Google Workspace/Gemini, Apple Notes, Obsidian, Mem, Reflect, Capacities, Tana, Craft, Amplenote, Coda, Saga, Anytype, Granola, plus the AI‑image/diagram and future‑directions research (sources in Appendix A).

### 1.1 Capability maturity (16 categories)

| Capability | Verdict (mid‑2026) | Leaders | weaveNotes status |
|---|---|---|---|
| Writing/edit assist (rewrite/tone/continue) | **Table‑stakes** | Notion, Google Docs | ✅ have (suggestions) |
| Summarization (page/PDF/meeting) | **Table‑stakes** | Notion, OneNote (1.5M words) | ✅ basic |
| Q&A over your notes (RAG) | **Table‑stakes** | Notion "Ask", Obsidian | ✅ workspace_search (medium) |
| Agentic multi‑step actions | **DIFFERENTIATOR (frontier)** | Notion 3.0 Agents (~20min, scheduled) | ⚠️ supervisor delegation only; no scheduled/autonomous agents |
| Autolink / auto knowledge‑graph | Manual=stakes; **AI‑auto=differentiator** | Mem 2.0, Tana | ✅ graph + backlinks; entity extraction medium |
| Semantic / vector search | **Table‑stakes (infra)** | everyone | ✅ but loads all embeddings (perf) |
| Transcription / voice notes | **Table‑stakes (capture)** | Apple, Whisper, Tana | ❌ **none** |
| AI meeting notes | **DIFFERENTIATOR** | Granola (bot‑less), Notion, Tana | ❌ **none** |
| Image understanding / **generation** | Understand=stakes; **generate=differentiator** | Notion (Mar 2026), MS, Apple | ⚠️ gpt‑image‑1 off by default; **no vision verify** |
| Diagrams/mind‑maps from text | **DIFFERENTIATOR (native editable)** | Whimsical, Napkin, Excalidraw AI | ⚠️ boxes/arrows only, **no verify loop**, ≤8 nodes |
| AI web clipping | Table‑stakes (PKM niche) | Readwise, Glasp | ✅ capture_web_page (SSRF‑guarded) |
| Flashcards / spaced repetition | Stakes in study apps; **FSRS=new bar** | RemNote, Quizlet, Anki | ✅ SM‑2 (not FSRS) |
| Translation | **Table‑stakes** | Notion, DeepL | ⚠️ via rewrite only |
| DB AI auto‑fill | **Table‑stakes (DB tools)** | Notion, Coda | ✅ autofill (shallow); relation‑aware missing |
| Real‑time AI participant | **DIFFERENTIATOR (emerging)** | Google Docs, Notion | ✅ AI presence + live co‑edit (strong) |
| Chat with workspace | **Table‑stakes** | Notion, Mem, NotebookLM | ✅ workspace_search |

**Read:** shipping categories 1–3, 5, 6, 11, 13–16 buys *parity, not praise*. The 2026 differentiators are **agentic autonomy (#4), AI‑as‑live‑participant (#15, where we're actually strong), native editable diagram generation (#10), in‑document image generation (#9), auto knowledge‑graph (#5), and meeting‑notes (#8)**.

### 1.2 The "correct visual" recipe the market converged on (most relevant to the user's concern)

This is the single most important finding for "create the *right* perfect image, not just an image":

1. **For diagrams (anything that must be *accurate to the text* — flow, architecture, ER, mind‑map): code‑first wins decisively.** The best tools generate **Mermaid / D2 / SVG**, then run a **validate → render → self‑check → retry** loop. Techniques in production/research 2025–26: LLM‑as‑judge **structural scoring** (node/edge precision/recall/F1 — *Flowchart2Mermaid* reports Entity F1 ≈ 0.986), **syntax validate‑before‑export** (parse `.mmd` via mmdc/Kroki, regenerate on error), and **execution‑feedback self‑debugging** (*VisCoder2*: generate code → execute → analyze rendered output → revise). Raster diagram images are now considered the **low‑accuracy** path. (Sources A‑img‑1..4)
2. **For decorative/realistic images with text:** mid‑2026 leaders are **Nano Banana Pro (Gemini 3 Pro Image)** — best‑in‑class legible/multilingual text, Google‑Search‑grounded geometry — **GPT Image 2**, **Ideogram V3** (text specialist), **FLUX.2** (photorealism). 
3. **For editable vector/brand assets:** **Recraft V4 Vector** — the only model with native, layered **SVG** output.
4. **Universal mechanism: vision verification.** A VLM re‑reads the generated/sourced image and confirms it depicts the requested subject; reject + retry if not. Notion's in‑doc image gen is **context‑aware** (reads the page); Nano Banana Pro is **search‑grounded**. 

**weaveNotes gap:** our `diagram.ts` is boxes/arrows with **no validate/verify loop**; our `find_image` does **metadata‑based** ranking (titles/licence/context) but **no vision verification** of the pixels; our AI‑SVG illustration uses a weak text model. We have the right MIT substrate (rough.js, our SVG sanitizer, the hardened image pipeline) to implement the real recipe — see §4 and Phase P1/P2.

### 1.3 Enterprise must‑haves (from the governance research)

Every serious 2026 competitor ships most of: **no‑training‑by‑default commitment** (Notion, MS, Google all contractual) · **data residency** (Notion US/EU/JP/KR; Google US/EU; MS EUDB + in‑country, with the **Flex‑routing** nuance that EU inference can leave the EUDB at peak unless disabled) · **per‑tenant logical isolation** (all use logical, not dedicated) · **CMK/BYOK** (MS Purview Customer Key covers Copilot; Google CSE; Notion/Coda do **not** offer BYOK) · **on‑prem/air‑gapped** (Google GDC air‑gapped GA Aug 2025; MS Azure OpenAI in‑tenant) · **model choice** (Notion/MS expose Claude+GPT; choosing Claude in MS *exits* the EUDB) · **copyright indemnity** (MS CCC, Google two‑pronged) · **SSO/SCIM, audit, DLP/redaction, retention** · **certifications** (SOC2, ISO 27001/27018, **ISO 42001 AI‑MS**, HIPAA, GDPR) · **accessibility (WCAG‑AA)** · **character‑level citations** (Anthropic Citations API pattern) becoming the trust bar.

**weaveNotes status:** we have per‑tenant action routing, sensitivity gating + redaction on publish, SSRF‑hardened fetch, and WCAG‑AA‑validated palettes — a real head start — but **no audit trail, no data‑residency/BYOK/on‑prem story, no SSO/SCIM surfaced for notes, and a tenant‑isolation hole in workspace search** (see §3). These are launch‑blockers for enterprise.

**Per‑vendor governance benchmark (mid‑2026, primary‑source verified — Appendix A).** This is the bar weaveNotes is measured against for an *enterprise* tier:

| Control | Notion | M365 Copilot | Google Gemini | Coda | Obsidian | Anthropic | OpenAI |
|---|---|---|---|---|---|---|---|
| SSO (SAML/OIDC) | Business+ | Entra | Workspace SSO | Enterprise | ❌ none | Team+ | Enterprise |
| SCIM | Enterprise | Entra | SCIM 2.0 | Enterprise | ❌ none | Enterprise | Enterprise |
| Audit log / Compliance API | 365‑day audit log | Purview unified audit | Vault + audit (June 2026) | 12‑mo audit API + eDiscovery | ❌ none | 180‑day (Compliance API) | Compliance API |
| Native DLP | ❌ (Nightfall) | ✅ Purview (native) | ✅ Workspace DLP (native) | ❌ (Admin‑API) | ❌ none | ❌ (partner) | ❌ (partner) |
| Data residency | US/EU/JP/KR | EUDB (Flex caveat) | US/EU regions | ❌ AWS‑US | local‑first | US‑only (1st‑party); EU via Vertex/Bedrock | EEA/UK/+10 |
| CMK / BYOK | ❌ | ✅ Purview Customer Key | ✅ CSE | ❌ | n/a | ❌ (1st‑party) | ✅ EKM |
| On‑prem / air‑gapped | ❌ | Azure‑in‑tenant | ✅ GDC air‑gapped | ❌ | ✅ local‑first | ❌ | ❌ |
| No‑training default | ✅ contractual | ✅ | ✅ (CDPA) | ✅ | n/a (no AI) | ✅ | ✅ |
| ZDR | Enterprise (0‑day) | — | NotebookLM 0 | ❌ unstated | n/a | approved Enterprise | API in‑region |
| **ISO 42001 (AI‑MS)** | ⚠️ disputed | ✅ (recert Mar 2026) | ✅ (Dec 2024) | ❌ | ❌ | ✅ (first lab) | ✅ |
| HIPAA BAA | Enterprise | ✅ named | ✅ | Enterprise | ❌ won't sign | ✅ | gated |
| FedRAMP | ❌ | Moderate / High (GCC‑H) | **High** | ❌ | ❌ | via Bedrock GovCloud | Moderate (20x, Jan 2026) |
| Public WCAG VPAT | ❌ (14+ violations) | ✅ mature | ✅ downloadable | ❌ | ❌ | ⚠️ NDA‑gated | ❌ |
| Copyright indemnity | — | ✅ CCC | ✅ two‑pronged | — | — | ✅ | ✅ Copyright Shield |

Takeaways for our roadmap: **ISO 42001 is the 2026 dividing line** (the cleanest EU‑AI‑Act‑readiness proxy; held by MS/Google/Anthropic/OpenAI, *not* by the indie tools) — a credible enterprise weaveNotes needs an AI‑management‑system story. **Native DLP is rare** (only MS/Google) — most competitors, like us, lean on partner/Compliance‑API integration, so our redaction + sensitivity gating is *competitive* if we add an audit/Compliance‑API surface. **BYOK/local‑first is a real wedge** (OpenAI EKM, Obsidian local) that our multi‑provider engine can occupy. Note also the **Vault scope gap** pattern (Google's Vault covers the Gemini *app* but not in‑context "Help me write") — a reminder that our audit surface must cover *every* AI action, not just chat.

**EU AI Act timing (buyer context).** GPAI model obligations are **already live** (since 2 Aug 2025); **Article 50 transparency** (AI‑generated‑content disclosure/watermarking) lands **2 Aug 2026** — the near‑term obligation that touches a notes tool. High‑risk obligations were **deferred** by the Nov‑2025 "Digital Omnibus" (politically agreed May 2026, pending formal enactment): Annex III standalone high‑risk → **2 Dec 2027**, Annex I product‑embedded → **2 Aug 2028**. Practical read: most AI‑note use is limited/minimal‑risk, so our nearest compliance touchpoint is **AI‑output transparency (Aug 2026)** — cheap to honour (provenance stamping, which we partly do) and worth building in now.

### 1.4 Pricing context (for positioning)

Notion Business **$20** (AI bundled) · MS Copilot **$30** add‑on (on top of base) · Granola **$14/$35** · Obsidian Copilot plugin **$14.99** · Tana Plus/Pro **$8/$14** · Mem **$12** · Reflect **~$10** · Capacities **$9.99** · Saga **~$6** · Amplenote **BYOK no‑markup**. The market splits into **bundled‑AI** (Notion/Google) and **BYOK/credits** (Tana/Craft/Amplenote/Coda). weaveNotes' per‑tenant routing + multi‑provider engine positions it naturally for **both** a bundled tier and a BYOK/local tier.

---

## 2. weaveNotes today — capability inventory & honest depth

From the two engineering reviews (server + UI, and the two packages). Depth is rated **deep** (production‑grade), **medium** (works, real gaps), **shallow** (demo‑level).

| Capability | Implementation | Depth | Headline gap |
|---|---|---|---|
| Co‑editing (CRDT relay + presence) | `@weaveintel/coedit` (RGA + BlockDoc), `note-coedit-sql.ts`, `note-coedit-hub.ts` | **Deep** | In‑memory hub = single‑node only (needs Redis fan‑out) |
| AI co‑author (suggestions) | `note-ai-sql.ts` (`note_edit`, `restructure_note`) | **Deep** | No token budgeting; full‑markdown to model; no per‑user rate limit |
| Creative diagrams | `note-creative-sql.ts` + `diagram.ts` | **Medium** | Boxes/arrows only; **no accuracy verify**; ≤8 nodes; unbounded height |
| Ink / freehand | `ink.ts` + editable node‑view | **Medium** | Eraser is render‑only (not removed from model) |
| AI illustration (SVG) | `createIllustrationInner` | **Shallow→Medium** | Weak text model authors SVG → crude output |
| AI image generation | `generateImageInner` (gpt‑image‑1) | **Medium** | Off by default; **no vision verification**; single model |
| **find_image (web sourcing)** | `findImageInner` (Openverse/Wikimedia/Unsplash/Pexels/Pixabay), hardened fetch | **Medium (new, strong)** | Metadata‑only ranking; **no vision verify**; per‑user language done |
| Whole‑note restructure | `restructure` (`restructure_note`) | **Deep** | No token‑budget guard for huge notes |
| Knowledge graph (links/backlinks/related/entities) | `note-graph-sql.ts` | **Medium** | LLM‑only entity extraction; N+1 embeddings; no disambiguation |
| Databases + AI autofill | `note-db-sql.ts` | **Shallow** | Web‑search autofill leaks data; citations unvalidated; no relation rollup AI |
| Flashcards + spaced repetition | `note-study-sql.ts` + `study.ts` (SM‑2) | **Medium** | **SM‑2, not FSRS**; no card quality/feedback loop |
| Capture (web/run/email/jot) | `note-capture-sql.ts` (SSRF‑guarded) | **Medium** | Shallow email parser; no source hash/drift detection |
| Workspace RAG / "ask" | `note-workspace-sql.ts` (RRF fusion) | **Medium** | **Loads all embeddings**; **no tenantId filter (security)**; citations not char‑level |
| Version history | `note-version-sql.ts` | **Medium** | No retention/cleanup; restore reverts title |
| Comments (block‑anchored) | `note-comment-sql.ts` | **Medium** | No @mention notifications |
| Synced blocks (transclusion) | `note-synced-sql.ts` | **Shallow** | Index‑based anchor is fragile; no cycle detection |
| Publish / share (sensitivity + redaction) | `note-publish-sql.ts` | **Medium** | Redaction misses collapsed/toggle blocks; owner check on invite |
| Templates / organisation | `templates.ts` + m111 | **Medium** | Fine |
| Export (MD/HTML/Word/JSON) | `note-export.ts` | **Medium** | O(n) fixed earlier; no PDF/真 docx |
| Mobile / desktop | settings + client scaffolds | **Shallow** | Server orchestration minimal |
| Per‑tenant action routing (direct/agent/supervisor) | `note_action_modes` + Builder tab | **Medium (new)** | Solid; extend to more actions |
| Supervisor‑delegated agent actions | `runNoteAgentAction` + worker | **Medium (new)** | Works; ~50s latency; no scheduling |

---

## 3. Gap & risk analysis — from CODE **and** TESTS

Tagged: **[SEC]** security · **[CORR]** correctness · **[PERF]** performance/scale · **[QUAL]** quality/UX · **[TEST]** test‑gap · **[COMM]** commercialization. Severity P0 (blocker) → P3.

### 3.1 Security (highest priority for enterprise)

- **[SEC][P0] Tenant‑isolation hole in workspace search** — `note-workspace-sql.ts` filters embeddings by `userId` but **not `tenantId`**; in a multi‑tenant deployment a request could surface cross‑tenant notes. *Fix:* thread `tenantId` into every `listUserNoteEmbeddings`/RAG query + add a cross‑tenant isolation test. **(No automated cross‑tenant test exists today.)**
- **[SEC][P1] Prompt‑injection into visual/agent prompts** — user instructions are concatenated into system prompts (diagram title, image queries) without escaping; the agent/worker path also trusts note content. *Fix:* dedicated instruction sanitization + a standing adversarial‑injection test corpus (we have none).
- **[SEC][P1] Redaction misses hidden blocks on publish** — `note-publish-sql.ts` redacts after `blocksToMarkdown`; secrets inside collapsed **toggle** blocks may evade redaction. *Fix:* redact at block level pre‑serialization; test with a secret‑in‑toggle corpus.
- **[SEC][P1] DB‑autofill web search can leak confidential cell data** — `note-db-sql.ts` sends column values to web search providers with no PII gate. *Fix:* PII detection + opt‑in + privacy notice.
- **[SEC][P2] Owner check on note invite** — verify `access.role === 'owner'` before minting share tokens in the route (defence‑in‑depth around `createInvite`).
- **[SEC][P2] SVG sanitizer vs nested `<script>`** — `svg.ts` regex is greedy on nested tags; move to a parser‑based sanitizer + an OWASP XSS payload corpus test.
- **[SEC][P2] CRDT link‑mark validation only at serialization** — validate link `value` at `validateClientBlockOps` (input), not just on render.
- **Positives confirmed:** find_image + capture use the canonical **`hardenedFetch`** (SSRF guard: cloud‑metadata, RFC‑1918, **DNS‑rebinding**, redirect re‑validation, size cap) + `isSafePublicUrl` defence‑in‑depth + content‑type validation. This is genuinely good and was validated this session (find_image refuses to fetch anything but public images).

### 3.2 Correctness

- **[CORR][P1] CRDT mark LWW tiebreaker bug** — `block-doc.ts:262` compares `siteId > ''` instead of the current winner's siteId; concurrent same‑lamport marks can pick the wrong winner. *Fix + property test.*
- **[CORR][P1] restructure/edit token budget** — full `view.markdown` (potentially MBs) passed with `maxTokens` set but no input truncation → silent mid‑doc truncation on large notes. *Fix:* count/clip input.
- **[CORR][P2] Workspace embedding dimension/model drift** — embeddings from different model versions silently skipped (length mismatch). *Fix:* store embedding model version; re‑embed on change.
- **[CORR][P2] Synced‑block index anchor fragility** — index‑based source anchor breaks on reorder/delete. *Fix:* CRDT block ids for co‑edited notes.
- **[CORR][P2] Mark range off‑by‑one** (`block-doc.ts:224`) inclusive/exclusive ambiguity.

### 3.3 Performance / scale

- **[PERF][P1] Workspace search loads ALL embeddings into memory** then ranks in JS — O(notes) memory per query. *Fix:* push top‑K cosine into the adapter (sqlite‑vec / pgvector + HNSW).
- **[PERF][P1] In‑memory co‑edit hub** = single‑node; multi‑node deployments silently diverge. *Fix:* Redis pub/sub fan‑out (documented post‑v1).
- **[PERF][P2] Unbounded `note_activity` log** — no retention; `listNoteActivity` degrades over months. *Fix:* retention policy + index.
- **[PERF][P2] Embeddings not batched** in graph indexing (1 call/note). *Fix:* batch 32–64.
- **[PERF][P2] find_image = 2 LLM calls** (derive queries + rank). Acceptable but cache by (query+context) hash; consider one combined call.
- **[PERF][P3] LCS diff O(n²)** and **mark lookup O(n)/block** — fine for normal notes, cap or index for huge ones.

### 3.4 Quality / UX (the "right output" theme)

- **[QUAL][P1] Diagrams have no accuracy/verification loop and only boxes/arrows** — the core of the user's complaint generalized. *Fix:* Mermaid‑class diagram types + validate‑render‑(vision)verify‑retry (see §4, Phase P1).
- **[QUAL][P1] No vision verification on any visual output** — find_image/illustration/image insert without confirming the pixels match intent. *Fix:* VLM verify step (Phase P2).
- **[QUAL][P2] No progress indicators for long AI ops** (supervisor ~50s) — user thinks it hung. *Fix:* SSE progress (we already have the hub).
- **[QUAL][P2] SM‑2 not FSRS** — FSRS is the 2026 bar for scheduling.
- **[QUAL][P2] Shallow email parser; web‑clip dedup; eraser render‑only.**
- **[QUAL][P3] Diagram unbounded height; no theme extensibility (Pro/Creative hard‑coded).**

### 3.5 Commercialization

- **[COMM][P0] No audit trail** — CRDT ops carry siteId but **no timestamps**; no "who changed what when" log for compliance/forensics. *Blocker for enterprise.*
- **[COMM][P0] No per‑user AI rate limiting / quota** — unlimited diagram/edit/find_image → cost‑explosion + abuse vector. *Blocker.*
- **[COMM][P1] No data‑residency / BYOK / on‑prem / no‑training commitment** surfaced for notes. *Enterprise table‑stakes.*
- **[COMM][P1] No usage analytics** (suggestion accept‑rate, AI‑action metering) — can't bill, can't improve.
- **[COMM][P2] Citations not character‑level** (Anthropic Citations API pattern) — trust bar.
- **[COMM][P2] Image licence provenance not embedded** in the stored asset.

### 3.6 Test evidence gathered THIS session (what actually works online)

Validated by real‑LLM + real‑browser Playwright and live web fetches (screenshots compared to real online content):

- ✅ **find_image** sources a **real CC0 anatomical heart** from Openverse, hardened‑fetched, stored as an artifact, rendered with a licence/attribution caption — screenshot matches a genuine textbook heart (vs the AI‑SVG "blob" it replaced). Long 500‑char selections are **summarized** to "human heart anatomy" before searching; candidate ranking is **context‑aware**; per‑user **language** preference (default English) round‑trips.
- ✅ **Supervisor routing** — "Make a diagram"/"Restructure" run via supervisor → **weavenotes_editor worker** (forced delegation: supervisor has zero direct note tools); ephemeral chat is deleted (chat list stays clean).
- ✅ **Editable AI diagrams** — rename/recolour/add/delete nodes persist (after fixing a real **CRDT attr‑clock drop** + a **save serialization race** + an artifact base64→blob bug).
- ✅ **Restructure** reorders to a supplied outline, preserving all content + visuals.
- ✅ **Per‑tenant action routing** + Builder admin tab render and gate correctly.
- ✅ **Unit suites green:** coedit (98), image‑search helpers (17), notes config.

**Security/stress probe results (managed Playwright server, run THIS session — `notes-audit-probe.e2e.ts`):**

| Probe | Result | Evidence |
|---|---|---|
| **AUTHZ** — user B reads/edits/AI's user A's note | ✅ **PASS** | every cross‑user op returns 404: `{"B GET A note":404,"B PATCH A note":404,"B diagram on A":404,"B find-image on A":404,"B suggestions list A":404,"B export A":404}` |
| **SSRF** — capture_web_page hits metadata/private hosts | ✅ **PASS** | `169.254.169.254`→400, `localhost:3510`→400, `127.0.0.1:22`→400, `10.0.0.1`→400, `[::1]`→502 (all refused) |
| **SANITIZE** — note doc with `<script>`/`onerror` served | ✅ **PASS** | rendered HTML has `<script>`? **false**; `javascript:` src? **false** |
| **STRESS** — 2000‑block note: create/GET/export/suggestions | ❌ **FAIL (timed out at 3 min)** | confirms **[PERF][P1]** empirically — large notes blow the latency budget; the in‑memory + O(n) paths don't scale |

So the per‑note **authorization, SSRF guard, and XSS sanitization hold up under direct attack** (good), while the **2000‑block stress test empirically fails** — turning the [PERF] concerns from "code smell" into a measured, reproducible defect. Note the AUTHZ pass is *per‑note* (owner check); it does **not** clear the *cross‑tenant* workspace‑search hole in §3.1, which needs its own test.

- **Recommended additions (still gaps in our test suite):** cross‑**tenant** isolation (distinct from the per‑note authz just proven), adversarial prompt‑injection, OWASP‑XSS SVG corpus, multi‑node CRDT convergence, per‑user AI rate‑limit, redaction‑of‑hidden‑blocks. The audit probe (`notes-audit-probe.e2e.ts`) should be **productionized into CI** — and its STRESS case kept as a perf regression gate (it must pass after P0/P1 perf fixes).

---

## 4. The quality bar — "the right perfect image" (design)

This is the user's central concern, so it gets its own design. The target: **every visual the AI produces is verified to actually depict what was asked, in the right form, before it's inserted.**

**Pipeline (applies to all visual requests):**

1. **Intent classification** (already partially in `classifyVisual`): is the request a *diagram* (process/relationship/structure), an *illustration/icon* (vector art), a *real photo/figure* (a thing you can photograph or a textbook figure), or *freehand ink*? Route accordingly. Critically, **"draw the human heart" → real figure / illustration, never a boxes‑and‑arrows diagram.**
2. **Generate in the highest‑fidelity form for that intent:**
   - *Diagram* → **emit Mermaid/D2** (MIT) for real diagram types (flow, sequence, class, ER, state, mind‑map, gantt), rendered to SVG. Our current node/edge model becomes one renderer among several.
   - *Illustration/icon/vector* → improved AI‑SVG with a **stronger model** and/or a vector specialist (Recraft V4 Vector when a paid tier is enabled); always run through our existing **SVG sanitizer**.
   - *Real figure/photo* → **find_image** (already built) first; **image‑gen** (Nano Banana Pro / GPT Image 2 for accurate in‑image text; gpt‑image‑1 today) when enabled.
3. **Verify before insert (the key step we lack):**
   - *Diagrams:* **syntax validate** (parse the Mermaid/D2 before render) + **LLM‑as‑judge structural score** (does the node/edge set match the requested entities/relations?) → regenerate on failure.
   - *Images (sourced or generated):* **vision verification** — a VLM re‑reads the image and answers "does this clearly depict <subject> as <intent>, with correct/legible labels in <language>, and is it appropriate?" Reject + fall through to the next candidate / re‑prompt on failure.
4. **Stage as a track‑changes suggestion** (unchanged) with provenance (source, licence, model, verification verdict) so the human always approves.

**Why this is achievable for us:** the 2026 research shows this *is* the state of the art (code‑first + verify loops + vision verification), and it's mostly **orchestration over MIT components we already have or can add** (Mermaid is MIT; our SVG sanitizer, hardened image pipeline, supervisor/worker, and suggestion staging are done). The verification step reuses the same model routing we already use.

---

## 5. Target architecture for commercialization (enterprise + public)

Additive to today's design; nothing below requires a rewrite.

- **Two product tiers from one engine:** (a) **Cloud/bundled** (managed models, per‑tenant governance) and (b) **BYOK / local‑first** (bring your own keys; on‑device/Ollama models for privacy) — our multi‑provider routing already supports this; expose it for notes.
- **Governance plane (per‑tenant, Builder‑managed):** model‑routing, **data residency** (region pinning per tenant), **no‑training commitment** surfaced, **BYOK/CMK**, DLP/redaction policy, retention policy, **audit log**, SSO/SCIM, per‑user **AI quota/rate limits**, capability flags. We already have the `note_action_modes` + weavenotes_settings pattern to extend.
- **Verification plane:** the §4 validate/verify loop as a reusable service used by diagrams, illustrations, images, and (later) any agent‑produced artifact.
- **Agent plane:** today's supervisor→worker, extended with **scheduled/triggered agents** (the Notion‑3.0‑style differentiator) running over the workspace with **budget caps + audit**.
- **Interop plane:** an **MCP server** exposing the vault (read/search/write notes) so any agent (Claude, ChatGPT, Cursor) can use weaveNotes as a tool surface — this is becoming table‑stakes (MCP is now under the Linux Foundation; Notion/Granola/Mem/Anytype all ship MCP).
- **Trust plane:** **character‑level citations** (Anthropic Citations API pattern) for workspace RAG and any AI‑generated claim; provenance stamping (already partially present).
- **Capture plane:** **voice/meeting capture** (transcription + bot‑less system‑audio + summary) — the biggest missing table‑stakes/differentiator.

---

## 6. Phased implementation plan

Each phase: goal, key workstreams, and **acceptance criteria** (measurable, test‑backed). Phases are roughly sequential but P0 and P1 can overlap.

### **P0 — Security & trust hardening (launch‑blocking)**  
*Goal: nothing ships to a paying tenant until these are closed.*
- **Tenant isolation:** thread `tenantId` through workspace search + every embedding/graph query; **cross‑tenant isolation e2e** (tenant A's note never appears for tenant B).
- **Audit trail:** timestamp every CRDT op + AI action; per‑note "who/what/when" log; admin export.
- **Per‑user AI rate limiting / quota** on all `/ai/*` endpoints + agent tools.
- **Redaction completeness** (collapsed/toggle blocks) + secret‑in‑toggle test corpus; **owner check** on invites.
- **Prompt‑injection** sanitization + adversarial corpus; **SVG XSS** parser‑based sanitizer + OWASP corpus.
- **CRDT mark LWW tiebreaker** fix + property test; **restructure token‑budget** guard.
- *Acceptance:* all of the §3.6 "recommended" tests added and green; zero P0/P1 [SEC]/[CORR] open; pen‑test checklist passed.

### **P1 — Visual correctness (the "right image" recipe)**  
*Goal: AI visuals are verified, not hopeful.*
- **Diagram engine v2:** add **Mermaid/D2** (MIT) for real diagram types; **syntax‑validate → render → structural‑score (LLM‑judge) → retry**; keep our editable node renderer for simple cases. Bound diagram height/reflow.
- **Vision verification** for find_image + illustration + image: VLM "does this depict X correctly?" → reject/retry; expose verdict in the suggestion.
- **Illustration upgrade:** stronger model for AI‑SVG; sanitizer unchanged.
- **Progress/SSE** for long AI ops (reuse the hub).
- *Acceptance:* an automated **visual‑quality suite** — for a fixed prompt set (heart, water cycle, mitochondria, org chart, sequence diagram), the produced artifact passes structural/vision verification ≥ a target threshold; screenshots reviewed against reference images; "draw the heart" never yields a flowchart.

### **P2 — Table‑stakes depth + enterprise governance**  
*Goal: parity on the expected features + enterprise viability.*
- **Workspace RAG:** push top‑K into the adapter (sqlite‑vec/pgvector); **character‑level citations**; query expansion.
- **Data residency / BYOK / no‑training** surfaced per tenant; **CMK** option; **SSO/SCIM** for notes; retention policies (activity log, versions).
- **Image generation** properly: enable behind governance with **Nano Banana Pro / GPT Image 2** routing for accurate in‑image text (with vision verify from P1); licence/provenance metadata embedded.
- **Translation** as a first‑class action; **FSRS** for flashcards; **DB autofill** relation‑aware + PII‑safe web search.
- *Acceptance:* enterprise checklist (residency, audit, SSO/SCIM, DLP, retention, no‑training) demonstrably configurable per tenant; RAG citations are click‑to‑exact‑span.

### **P3 — Differentiators: agents + interop**  
*Goal: move from parity to position.*
- **Scheduled/triggered autonomous agents** over the workspace (Notion‑3.0‑style) with **budget caps + audit + HITL approval**; built on today's supervisor/worker.
- **MCP server** exposing the vault (search/read/write) so external agents use weaveNotes as a tool; **A2A** later.
- **AI‑as‑live‑participant** deepened (we're already strong here) — proactive linking/suggestions as you write.
- **Auto knowledge‑graph** quality: GraphRAG‑style extraction + **entity disambiguation**; batched embeddings.
- *Acceptance:* a scheduled agent demonstrably performs a multi‑step note task overnight within budget, fully audited; an external Claude/ChatGPT session reads+writes notes via MCP.

### **P4 — Capture & multimodal**  
*Goal: close the biggest missing table‑stakes.*
- **Voice notes + transcription** (Whisper‑class; on‑device option); **bot‑less meeting capture** + summary with **transcript‑anchored citations** (Notion/Tana/Granola bar).
- **Multimodal canvas** experiments (infinite canvas + AI shape ops) leveraging our CRDT.
- *Acceptance:* record → transcribe → structured note with action items + clickable transcript citations, end‑to‑end e2e.

### **P5 — Frontier & scale**  
*Goal: durability + frontier polish.*
- **Redis fan‑out** for multi‑node co‑edit; horizontal scale tests.
- **Background memory** (proactive, temporally‑aware) for a true "second brain".
- **On‑device/local model** path for privacy‑sensitive tenants (Apple/Ollama/MLX).
- **FSRS personalization, theme extensibility/white‑label, accessibility audit (WCAG‑AA) across the editor.**
- *Acceptance:* multi‑node convergence test green; local‑model path passes the visual‑correctness + RAG suites offline.

---

## 7. Immediate next actions (this/next sprint)

1. **P0‑1 Tenant isolation** in workspace search + cross‑tenant test (highest risk, smallest fix).
2. **P0‑2 Per‑user AI rate limiting** middleware on `/ai/*` + agent tools.
3. **P0‑3 Audit log** (timestamps on ops + AI actions).
4. **P1‑1 Diagram verify loop** prototype: Mermaid output + syntax‑validate + structural‑score on a 10‑prompt set; measure pass‑rate vs today.
5. **P1‑2 Vision verification** prototype for find_image on the heart/mitochondria/org‑chart set; measure "correct image" rate.
6. Productionize the **audit probe** (`notes-audit-probe.e2e.ts`) into the CI suite — keep the **STRESS** case (which **empirically failed this session**, §3.6) as a perf regression gate.
7. **Large‑note perf fix** (the measured 2000‑block timeout): profile the create/GET/export/suggestions path; cap or index the O(n) mark lookup + LCS diff; this is a concrete, reproducible defect, not a hypothetical.

---

## Appendix A — Sources (selected; full URL lists captured per research stream)

**Vendors / capabilities:** Notion 3.0 Agents (notion.com/blog/introducing-notion-3-0; releases/2025-09-18), AI Meeting Notes (notion.com/product/ai-meeting-notes), in‑doc image gen (notion.com/releases/2026-03-09); Microsoft 365 Copilot (learn.microsoft.com/.../microsoft-365-copilot-privacy; .../connect-to-ai-subprocessor; copilot-flex-routing; blog GPT‑5/5.5; Notebooks May‑2026); Google Workspace/Gemini (workspaceupdates.googleblog.com 2026‑04; knowledge.workspace.google.com data‑regions/CSE; cloud.google.com GDC air‑gapped; Vertex Claude multi‑region); Apple (apple.com/newsroom 2024‑12, 2025‑09; machinelearning.apple.com foundation‑models; Image Playground 2026‑06); Obsidian (obsidian.md data‑storage / Sync security / teams license; obsidiancopilot.com; smartconnections.app); Mem (get.mem.ai), Reflect (reflect.app), Capacities (capacities.io), Tana (outliner.tana.inc), Craft (support.craft.do), Amplenote (amplenote.com/help), Coda (help.coda.io / coda.io/trust), Saga (saga.so/ai), Anytype (github.com/anyproto/anytype-mcp), Granola (granola.ai).

**Image/diagram accuracy (A‑img):** arxiv 2512.02170 (Flowchart2Mermaid LLM‑judge), arxiv 2510.23642 (VisCoder2 execution feedback), github.com/Agents365-ai/mermaid-skill (validate‑before‑export), blog.google nano‑banana‑pro, melies.co/compare/ai-image-models, recraft.ai/docs (V4 Vector), nimbalyst.com best‑ai‑diagram‑tools‑2026, infrasketch.net diagram‑as‑code‑2026.

**Future directions:** Notion 3.0; OpenAI memory "Dreaming"; tldraw agent starter‑kit / Figma First Draft; Granola/Tana voice + bot‑less; Apple on‑device + Ollama/MLX; Microsoft GraphRAG/LazyGraphRAG; MCP (Anthropic → Linux Foundation AAIF) + Google A2A; Anthropic Citations API.

**Enterprise governance (primary‑source verified across 11 research streams):**
- *Notion:* notion.com/help/notion-ai-security-practices, /ai-safety, /audit-log, /saml-sso-configuration, /provision-users-and-groups-with-scim, /add-security-and-compliance-integrations; trustcenter.notion.com (gated). ZDR Enterprise‑only; AI subprocessors OpenAI+Anthropic(+Google Jan 2026)+Turbopuffer; opt‑in "AI LEAP" training program; DLP via Nightfall; ISO 42001 disputed.
- *Microsoft 365 Copilot:* learn.microsoft.com/purview/audit-copilot, /ai-m365-copilot(-considerations), /dspm-for-ai; /microsoft-365-copilot/microsoft-365-copilot-{privacy,licensing,architecture…}; /sharepoint/restricted-content-discovery, /advanced-management; /compliance/regulatory/offering-iso-42001. Purview = native DLP+eDiscovery+sensitivity‑label inheritance; ISO 42001 recert Mar 2026 (incl. Copilot Studio); HIPAA‑named; GCC‑High FedRAMP‑High; **Claude models excluded from EU Data Boundary**.
- *Google Workspace/Gemini:* knowledge.workspace.google.com/admin/{sso,scim,gemini…}, /security/about-dlp; workspaceupdates.googleblog.com (Vault‑Gemini June 2026, data‑regions June 2025, audit logs July 2025); accessibility.google + downloadable Gemini VPAT (Oct 2025); FedRAMP High (first GenAI assistant); GDC air‑gapped.
- *Coda (now Superhuman/ex‑Grammarly):* coda.io/trust/security, help.coda.io HIPAA/SSO/SCIM, superhuman.com/subprocessors (DPA entity moved). SOC2 II + ISO 27001/17/18; **no ISO 42001, no FedRAMP, no public residency, no VPAT**; native eDiscovery+legal‑hold (differentiator); OpenAI‑backed AI, no‑training.
- *Obsidian (note app — NOT obsidiansecurity.com):* obsidian.md/security, /privacy, /help/teams/{security,sync,license}, /help/sync/security. Local‑first, no telemetry, AES‑256‑GCM E2E Sync (Cure53/Trail‑of‑Bits audits, no certs); **no SSO/SCIM/audit/DLP/BAA**; free for commercial use since Feb 2025; AI only via 3rd‑party plugins (full‑vault egress risk).
- *Anthropic:* privacy.claude.com (training/retention/ZDR/certs), platform.claude.com/docs (data‑residency, API retention), support.claude.com (SSO/SCIM/audit/Compliance‑API), claude.com/blog/compliance-api-security-partners (28 partners, May 2026), anthropic.com/legal/commercial-terms (copyright defence indemnity). No‑train default; SOC2/ISO 27001/**ISO 42001 (first lab)**; US‑only 1st‑party residency (EU via Vertex/Bedrock); no 1st‑party CMK; audit logs exclude chat content (Compliance API includes it).
- *OpenAI:* developers.openai.com/api/docs/guides/your-data (ZDR/retention — only cleanly fetchable host), openai.com/enterprise-privacy + trust.openai.com (SOC2 II, ISO 27001/27701/42001), policies/service-terms (Copyright Shield + carve‑outs), help.openai.com SSO/SCIM, data‑residency EEA/UK/+10. **EKM/BYOK** (AWS/GCP/Azure KMS) = differentiator vs Anthropic; FedRAMP Moderate (20x, Jan 9 2026).
- *EU AI Act:* artificialintelligenceact.eu/implementation-timeline; digital‑strategy.ec.europa.eu (Digital Omnibus, Nov 2025); gibsondunn.com (May‑2026 deferral analysis). GPAI live Aug 2025; Art. 50 transparency Aug 2026; high‑risk deferred to Dec 2027 (Annex III)/Aug 2028 (Annex I), pending enactment.
- *Accessibility:* microsoft.com/accessibility/conformance-reports (VPAT 2.4), accessibility.google (downloadable VPATs); Anthropic VPAT NDA‑gated; Notion 14+ WCAG violations (independent audits); OpenAI/Coda/Obsidian no public VPAT.

> Sourcing caveat: many 2026‑dated specifics (exact model version strings, prices, dated stats) come from vendor release notes corroborated by reputable secondary coverage; treat precise figures as "as reported" and re‑verify against primary docs before external use. Primary vendor/official URLs are anchored where load‑bearing.

## Appendix B — Companion docs
- `WEAVENOTES_DRAWING_TECH_RESEARCH_2026.md` — the deep dive on drawing/sketching tech, MIT licensing, and the find_image build (the practical basis for §4 / Phase P1).
