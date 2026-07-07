# `@weaveintel/skills` — Mid-2026 Review, Gap Analysis & Roadmap

**Package:** `@weaveintel/skills` · **Published:** `0.1.1` (npm) · **Target next release:** **one `0.1.2`**
containing all phases (the phases below are internal build-and-test milestones, **not** separate npm
releases). `0.1.2` is a patch — additive/backward-compatible — so the `^0.1.1` downstreams auto-adopt it;
see §7. (It can't be `0.1.1` itself: npm versions are immutable once published.)
**Scope of this doc:** review what the skills capability actually builds, compare it against the mid-2026
state of the art (with online research), classify every capability as **built / partial / missing**, give a
detailed design for each gap, and lay out a **phased plan** — each phase ending with **positive, negative,
security, and stress tests** proving it works end to end. The plan respects the open-core boundary
(`[[feedback_open_core_boundary]]`): the **engine** lives in `@weaveintel/skills`; the **catalog, policies,
thresholds, and admin UI** live in the app.

---

## 1. What is built today (`0.1.1`)

`@weaveintel/skills` is a **text-first, prompt-injected** skill runtime (2,216 LOC, depends only on
`@weaveintel/core`). A "skill" is a rich metadata + narrative-guidance package — **not** a folder of files.

**Model (`types.ts`, `SkillDefinition`):** id/name/version/category, `summary`/`purpose`/`whenToUse`/
`whenNotToUse`, staged guidance (`reasoning`/`execution`/`output`/`completion`/`ambiguity`/`failure`),
`examples`, `completionContract` (narrative + required evidence), `policy` (allowed/disallowed tools,
side-effects, approval, runtime budget, tenant boundary), `outputContract` (schema), a **machine-enforced
`executionContract`** (`minDelegations`, `requiredOutputSubstrings`, `requiredOutputPatterns`),
`domainSections` (query-scorable sub-playbooks), `agenticScope`, `toolPolicyKey`, `triggerPatterns`.

**Runtime:**
- `activation.ts` — `activateSkills()`: score → candidates (`maxCandidates 6`, `minScore 0.12`) → optional
  **LLM reasoning selector** → **policy evaluator** gate → selected (`maxSelected 3`); telemetry via hooks.
- `matching.ts` — `semanticScore()`: **bag-of-words TF-cosine** over the skill's narrative + a deterministic
  `triggerPatternBoost`. *(Called "semantic" but it is lexical, not embeddings.)*
- `prompt-builder.ts` — renders selected skills into a system prompt with **mode-aware, query-relevance
  section filtering** (a form of progressive disclosure at the *section* level) + tool guidance + examples +
  the execution-contract marker.
- `evaluateSkillCompletion()` — **heuristic** completion state via substring/regex/ambiguity/warning-tone.
- `registry.ts`, `persistence.ts`, `seed.ts`, `builtin.ts` (5 built-in skills), `a2a-skill-catalog.ts`
  (agent-to-agent skill taxonomy), lifecycle hooks + `CapabilityTelemetrySummary`.
- **Overlays** (`withSkillOverlay`/`applySkillOverlays`) — append-only skill extension + stricter-policy
  merge, so a skill can be extended without forking. *(A genuinely strong, somewhat unique feature.)*

**App side (correctly outside the package):** the skill catalog rows, the LLM selector implementation
(`reasonAboutSkillSelection`), the candidate threshold (`SKILL_CANDIDATE_MIN_SCORE`, raised to 0.25 during
the community hardening), and the admin Skills pages.

**Verdict:** a mature *authoring + prompt-injection + governance* model, ahead of most on
`executionContract`, `policy`, `agenticScope`, and overlays. It is **behind** the Dec-2025 "Agent Skills"
open standard on three axes: **skills-as-files (bundled scripts/resources)**, **real semantic retrieval &
scale**, and **security/trust/distribution**.

---

## 2. The mid-2026 state of the art (researched)

- **Agent Skills are an open standard.** Anthropic's Agent Skills (Oct 2025) became the open **`SKILL.md`**
  standard (**agentskills.io**, Dec 2025), adopted by ~40 clients (Copilot, Cursor, Codex, Gemini CLI,
  Goose, …). A skill is a **directory**: `SKILL.md` (YAML frontmatter `name`+`description`) + **bundled
  reference files and executable scripts**.
  ([Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills),
  [SKILL.md standard](https://www.agensi.io/learn/agent-skills-open-standard))
- **Progressive disclosure = 3 levels.** L1 metadata (~dozens of tokens) always in the prompt; L2 full
  instructions on trigger; L3 scripts/reference docs loaded **on demand** via a filesystem + code-exec
  tool. This directly fights the "50+ tools → 49% accuracy" attention collapse; MCP is retrofitting a
  **tool-search** mechanism to get the same benefit.
  ([survey 2602.12430](https://arxiv.org/html/2602.12430v3),
  [MCP vs skills](https://www.salmanq.com/blog/skills-vs-mcp/))
- **Skill libraries: retrieval, composition, dependency graphs.** Skills carry a *condition* (relevance),
  *execution policy*, *termination criterion*, and a *composition interface*; libraries add hierarchical
  organization, **dependency-aware retrieval via graphs**, typed params/preconditions, and a documented
  **selection phase-transition** (accuracy degrades sharply past a critical library size — so retrieval &
  disambiguation matter). ([SkillComposer](https://arxiv.org/pdf/2606.06079),
  [SoK: Agentic Skills](https://arxiv.org/html/2602.20867v1),
  [SkillResolve-Bench](https://arxiv.org/pdf/2606.10388))
- **Acquisition is becoming autonomous.** Beyond human-authored: RL-integrated skill libraries (**SAGE**:
  +8.9% completion, −59% tokens), autonomous discovery (**SEAgent**), and **meta-skills that generate new
  skills from failure cases**; multi-agent systems compiled into skill libraries.
  ([SkillClaw](https://arxiv.org/pdf/2604.08377), [eval/evolution](https://arxiv.org/pdf/2606.11435))
- **Evaluation is a named gap.** No standard metrics for **reusability / composability / maintainability**;
  benchmarks target same-capability ambiguity and skill evolution.
- **Security is now front-page.** A **26.1% vulnerability rate** across 42k community skills; bundling
  scripts raises risk **2.12×**; supply-chain attacks (ClawHavoc compromised ~1 in 5 packages). Mitigations
  crystallizing into: **4 verification gates** (static → LLM-semantic → behavioral sandbox → permission
  manifest), **4 trust tiers** (graduated permissions by provenance), **cryptographic signing** (ed25519 /
  Merkle-root / detached `*.oms.sig` covering every file) + provenance attestation verified at install, and
  the **[OWASP Agentic Skills Top 10](https://owasp.org/www-project-agentic-skills-top-10/)**
  (malicious skills, supply chain, over-privilege, insecure metadata, untrusted external instructions,
  weak isolation, update drift, poor scanning, no governance, cross-platform reuse).
  ([NVIDIA-verified skills](https://developer.nvidia.com/blog/nvidia-verified-agent-skills-provide-capability-governance-for-ai-agents/),
  [secure agent skills](https://arxiv.org/html/2604.02837v1))

---

## 3. Gap analysis

| # | Capability | Status | Notes |
|---|---|---|---|
| G1 | Rich skill authoring model (when/why/how, contracts, policy) | ✅ **Built** | Ahead of most; keep. |
| G2 | Machine-enforced execution contract | ✅ **Built** | `minDelegations` + output substrings/patterns. |
| G3 | Section-level progressive disclosure in the prompt | ✅ **Built** | But only over in-DB narrative. |
| G4 | Overlay / append-only extension | ✅ **Built** | Strong, keep as the extension mechanism. |
| G5 | Policy controls + `agenticScope` | 🟡 **Partial** | Declared, but no capability *manifest* / enforcement gates / least-privilege defaults. |
| G6 | **Semantic retrieval** | 🟡 **Partial** | Lexical TF-cosine only — no embeddings, no reranking, misses paraphrase/synonymy. |
| G7 | **True 3-level progressive disclosure (files/scripts on demand)** | ❌ **Missing** | No L3 — skills can't reference/lazy-load bundled files. |
| G8 | **Skills-as-packages (`SKILL.md` folder: bundled scripts + resources)** | ❌ **Missing** | Skills are text/DB only; can't ship deterministic code or reference assets. |
| G9 | **Skill composition / dependency graph** | ❌ **Missing** | Flat top-3 selection; no `requires`/`composes`, no conflict resolution. |
| G10 | **Retrieval at scale / disambiguation** | ❌ **Missing** | No tool-search-style retrieval; selection degrades past a critical catalog size. |
| G11 | **Skill evaluation harness** | 🟡 **Partial** | Only heuristic completion eval; no eval datasets, reusability/composability metrics, or eval-gated promotion. |
| G12 | **Lifecycle governance (trust tiers, retire, promote/demote)** | 🟡 **Partial** | Version string + `enabled` only. |
| G13 | **Security: verification gates + sandbox + signing/provenance** | ❌ **Missing** | No static/LLM/behavioral gates, no signing, host-mode by default if scripts ever added. |
| G14 | **Autonomous / learned skill acquisition (meta-skills)** | ❌ **Missing** | Human-authored only; no learn-from-trajectory / failure-driven generation. |
| G15 | **MCP interop (skills↔MCP, import/export standard `SKILL.md`)** | ❌ **Missing** | No bridge; not interoperable with the ~40-client standard. |
| G16 | **Multimodal skill inputs** | 🟡 **Partial** | `M69_NEW_INPUT_MIME_TYPES` hints exist; not wired to activation. |
| G17 | **Usage analytics → adaptive thresholds** | 🟡 **Partial** | Telemetry emitted; no feedback loop / auto-tuned `minScore` / hit-rate. |

---

## 4. Design (per gap) — engine vs app

Guiding rule: **generic mechanism → `@weaveintel/skills`; catalog / policy / thresholds / admin → app.**
Reuse existing framework packages (do not re-implement — `[[feedback_open_core_boundary]]` "one impl each").

### 4.1 Semantic retrieval (G6, G10) — reuse `@weaveintel/retrieval`
- **Engine:** add a pluggable `SkillRetriever` interface; ship two adapters — the existing `lexicalRetriever`
  (zero-dep default) and an `embeddingRetriever(embed, vectorStore)` that indexes each skill's L1
  card (`name`+`summary`+`whenToUse`+`triggerPatterns`) via `@weaveintel/retrieval`'s embedding + a vector
  store, with **RRF fusion of lexical + vector** (retrieval already has RRF) and optional reranking.
- **Scale/disambiguation:** a `SkillRouter` that first retrieves top-K by vector, then runs the LLM selector
  only over K (not the whole catalog) — this is the "tool-search" pattern that avoids the selection
  phase-transition. Add a `disambiguate()` step for same-capability collisions (SkillResolve-Bench).
- **App:** choose the embedding model + vector store (SQLite-vec / pgvector), owns the index refresh job.

### 4.2 True 3-level progressive disclosure + skills-as-packages (G7, G8) — reuse `@weaveintel/sandbox`
- **Engine:** define the `SKILL.md` **package format** (directory: `SKILL.md` YAML frontmatter + body +
  `resources/*` + `scripts/*`), a `parseSkillPackage()` loader, and a **3-level loader**: L1 card in the
  prompt always; L2 body injected on activation (existing); **L3** a `read_skill_file(skill, path)` tool +
  a `run_skill_script(skill, path, args)` tool that executes bundled scripts through **`@weaveintel/sandbox`**
  (Docker isolation) — never host mode. Bridge to the existing `SkillDefinition` (a folder skill compiles to
  a `SkillDefinition` + a `resourceRoot`).
- **App:** stores/serves packages (blob store), the admin "upload skill package" flow.

### 4.3 Skill composition / dependency graph (G9)
- **Engine:** add `requires?: string[]`, `composesWith?: string[]`, `conflictsWith?: string[]`,
  `precondition?`, `termination?` to `SkillDefinition`; a `resolveSkillGraph(selected)` that topologically
  orders required skills, pulls in dependencies, and resolves conflicts (highest trust-tier/priority wins,
  else ask). Composition interface = typed inputs/outputs so one skill's output can satisfy another's
  precondition.
- **App:** authoring UI for edges; guardrail on cycle depth.

### 4.4 Security: verification gates, trust tiers, signing (G5, G13) — reuse `sandbox`, `guardrails`, `encryption`
- **Engine — 4 verification gates** (mirrors the survey): **G1 static** (dangerous-YAML/`insecure metadata`,
  shell/net patterns), **G2 LLM-semantic** (via `@weaveintel/guardrails` — is the SKILL.md content an
  injection?), **G3 behavioral sandbox** (dry-run scripts in `@weaveintel/sandbox`, watch egress/fs), **G4
  permission-manifest validation** (declared capabilities ⊇ observed).
- **Engine — 4 trust tiers T1–T4**: T1 metadata-only (no L2/L3), T2 body but no scripts, T3 sandboxed
  scripts, T4 full — permissions graduated by provenance. Wire to progressive disclosure (L3 scripts only at
  T3+).
- **Engine — signing/provenance:** `signSkillPackage()` / `verifySkillPackage()` (ed25519 detached sig over
  a Merkle root of all files, via `@weaveintel/encryption`), + a provenance attestation checked at install.
- **Capability manifest (G5):** an explicit `capabilities` block (fs paths, network domain **allowlist**,
  shell y/n) with least-privilege defaults + explicit deny for identity/secret files.
- **App:** the trust policy (which tiers may run), the org skill inventory + approval workflow + audit log
  (OWASP AST09 "no governance"), publish/install-time scanning.
- **Maps to OWASP Agentic Skills Top 10:** AST01/02 → signing+scanning; AST03/06 → manifest+sandbox
  default-Docker; AST04 → G1 static; AST05/08 → G2 LLM-semantic + content-hash pinning; AST07 → verify on
  update + pinned hashes; AST09 → app inventory/approval/audit; AST10 → carry security metadata in the
  package.

### 4.5 Evaluation harness (G11) — reuse `@weaveintel/testing/evals`
- **Engine:** `evaluateSkill(skill, dataset, judge)` producing **reusability / composability /
  maintainability** scores + task-completion; regression gate; **eval-gated promotion** (a skill only reaches
  a higher trust tier / `enabled` after passing its eval). Same-capability ambiguity test built in.
- **App:** eval datasets (product-specific), the admin "run skill evals" page, promotion policy.

### 4.6 Autonomous / learned skills (G14) — reuse `memory`, `observability`, `agents`
- **Engine:** a `SkillMiner` that reads successful/failed trajectories (from `@weaveintel/observability`
  run logs) and proposes candidate `SkillDefinition`s (failure-driven meta-skill); all **proposals land as
  T1 draft skills gated behind the eval harness + human approval** (never auto-enabled — safety).
- **App:** the "suggested skills" review queue.

### 4.7 MCP interop + standard import/export (G15) — reuse `mcp-server`/`mcp-client`
- **Engine:** `importSkillMd(dir)` / `exportSkillMd(skill)` for the open `SKILL.md` standard (interop with
  ~40 clients); an MCP bridge so an MCP server's prompts/resources can register as skills and a skill can be
  exposed over MCP.
- **App:** the connectors UI already exists for MCP.

### 4.8 Adaptive thresholds + multimodal (G16, G17)
- **Engine:** feed activation telemetry into a `SkillFeedback` store; expose `suggestedMinScore()` from
  hit/miss rates. Add `inputModalities` to `SkillDefinition` + gate activation on attachment mime types.
- **App:** owns the analytics dashboard + the auto-tune toggle.

---

## 5. Phased plan (each phase ships + is fully tested)

The phases are **internal build-and-test milestones, not separate npm releases** — implement each in
sequence and **gate it with a 4-tier test pass** (positive / negative / security / stress) before moving on,
then publish **everything once as `0.1.2`** (§7). Nothing auto-enables; every new capability is opt-in via
config, so the single release stays backward-compatible and the `^0.1.1` downstreams adopt it automatically.
*(If you later prefer to ship value sooner, any milestone can instead be published as its own patch —
`0.1.2`, `0.1.3`, … — with no design change; that's purely a release-cadence choice.)*

### Phase 0 — Retrieval upgrade (G6, G10) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built (`src/retrieval.ts`):** `SkillRetriever` seam + `lexicalSkillRetriever` (default, zero-dep),
  `embeddingSkillRetriever` (injected embedder + cached in-memory `createSkillEmbeddingIndex`),
  `hybridSkillRetriever` (RRF-fused via `@weaveintel/retrieval`'s `reciprocalRankFusion`, graceful
  lexical fallback), and `createSkillRouter` (retrieve-then-select). Wired into `activateSkills` behind an
  optional `retriever` — **lexical stays the default, fully backward compatible**. README updated.
- **Tests:** 70/70 green — 17 hermetic 4-tier unit tests (concept-embedder) + **3 real-OpenAI-embedding
  e2e** (paraphrase win, exact+conceptual hybrid, index caching) + 50 existing. Stress: 5,000-skill
  catalog, 1,000 queries, retrieval p95 < 50 ms, candidates always bounded to top-K.
- **Original spec:** `SkillRetriever` interface + lexical (default) & embedding adapters (via
  `@weaveintel/retrieval`, RRF-fused); `SkillRouter` (retrieve-then-select). Backward compatible.
- **Tests:**
  - *Positive:* paraphrased query ("tidy up my code" → a "refactor/quality" skill) matches with embeddings
    where lexical scored ~0; RRF beats either alone on a labelled set.
  - *Negative:* unrelated query attaches nothing; empty/garbage query returns no candidates; embedding
    provider down → falls back to lexical (no throw).
  - *Security:* a skill whose narrative contains an injection ("ignore your instructions") cannot raise its
    own score via crafted trigger patterns beyond the boost cap; query with 10k tokens is truncated safely.
  - *Stress:* 5,000-skill catalog, 1,000 queries — retrieval p95 < 50 ms (vector) and selection only sees
    top-K; verify the selection phase-transition is avoided (accuracy flat vs catalog size).

### Phase 1 — Composition & dependency graph (G9) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** extended `SkillDefinition` with `requires`/`composesWith`/`conflictsWith`/`provides`/
  `precondition`/`termination`/`trust` (all typed + DB-storable — capability tokens, not code). New
  `src/skill-graph.ts`: `resolveSkillGraph()` (a pure typed-DAG resolver — transitive `requires`
  expansion, **cycle detection** via `detectRequiresCycle`, conflict resolution by trust/priority,
  **SCALAR-style frontier topological ordering** by `provides`→`precondition`, defers infeasible skills,
  bounds `maxSkills`/`maxDepth`) + `isSkillTerminated()`. Aligned to GraSP (typed DAG, precondition–effect
  edges) and the typed interface-contract literature. README "Composing skills" section added.
- **Tests:** 87/87 green — 16 hermetic 4-tier unit + 1 **real-OpenAI e2e** (retrieval + composition:
  a plain-language compound request → embeddings find the skills → graph produces load→analyze→report).
  Security: low-trust can't pull a higher-trust dependency (escalation blocked); conflicts resolved
  deterministically; fan-out/depth bounded. Stress: 200-node chain resolves in-order < 20 ms; 1,000-node
  graph fast; cycle detection on 1,000 nodes < 50 ms.
- **Original spec:** `requires`/`composesWith`/`conflictsWith`/`precondition`/`termination`;
  `resolveSkillGraph()`.
- **Tests:** *Positive* A requires B → both activate in order; *Negative* cycle A→B→A is detected & broken
  with a clear error; *Security* a low-trust skill can't pull a high-trust skill as a dependency; *Stress*
  200-node dependency graph resolves < 20 ms, deep chains bounded.

### Phase 2 — Skills-as-packages + 3-level disclosure (G7, G8) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** `src/skill-package.ts` — the open agentskills.io `SKILL.md` folder format:
  `parseSkillPackage(files)` (dependency-free frontmatter reader: required `name`[≤64, matches folder]
  + `description`[≤1024], optional `version`/`author`/`license`/`tags`/`agents`/`allowed-tools`, unknown
  keys kept as metadata; classifies `scripts/*` vs `references/`+`assets/*`) + `skillPackageToDefinition()`
  bridge (description→L1 card, body→executionGuidance, allowed-tools→toolNames) so packages flow through
  retrieval + composition. `src/skill-loader.ts` — true 3-level disclosure: `skillCardL1` / `skillBodyL2` /
  `listSkillFiles`; `readSkillFile` (L3, traversal + absolute-path guarded); `runSkillScript` through a
  **dependency-injected** `SkillScriptRunner` seam (adapts 1:1 to `@weaveintel/sandbox` CSE — NOT a hard
  dep, app owns isolation policy) with safe defaults (network denied unless package declares a network
  tool AND caller opts in; host execution refused; always time-bounded; resources + input files travel
  with the script, script excluded); `limitScriptConcurrency` in-process semaphore; `skillFileTools()` =
  `read_skill_file` + `run_skill_script` descriptors. Added `@weaveintel/sandbox` as a **dev**-only dep.
- **Tested (all green):** 23 hermetic 4-tier unit (`skill-package.test.ts`, fake runner) — *positive*
  parse/L1-L2-L3/bridge/tools; *negative* missing SKILL.md, bad name, name≠folder, over-long description,
  resource-not-found, run-a-reference, missing-script; *security* traversal + absolute paths blocked on
  read AND run, no-runner refusal, network-deny-by-default, network only when declared+opted-in; *stress*
  100 concurrent runs capped to 4 in-flight (all complete), 200-file package parses <50ms. Plus 5 **REAL
  Docker e2e** (`skill-package.realsandbox.test.ts`, actual `@weaveintel/sandbox` engine): a bundled Python
  script runs in a container and returns the correct computed answer; egress blocked (script can't phone
  home); workspace read-only (can't tamper); host `~/.ssh` unreachable; and the flagship — a plain-language
  request routed by REAL OpenAI embeddings to the right package, then executed for real (`revenue=130.00`).
- **Also fixed `@weaveintel/sandbox` (patch, real gap surfaced by e2e):** the LocalDockerProvider didn't
  create parent dirs for injected files nested under subfolders (`references/x.md` → ENOENT) and the
  one-shot executor lacked `-w /workspace` (relative `open('data.csv')` failed) — both fixed + one-shot
  now sanitizes file names (strips `..`). Backward-compatible; sandbox suite 22/22 still green.

### Phase 3 — Security: gates, trust tiers, signing (G5, G13) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** least-privilege **capability manifest** added to `SkillPackage` (declared in SKILL.md frontmatter
  — `network`/`filesystem`/`secrets`/`execution` — parsed in `skill-package.ts`). New `src/skill-security.ts`:
  **Ed25519 signing** `signSkillPackage()`/`verifySkillPackage()` + `hashSkillPackage()` (canonical digest over
  every file + all metadata → any byte change is detectable = tamper + rug-pull detection) — **REUSES**
  `@weaveintel/encryption` (`generateAttestationSigningKey`/`fingerprintEd25519PublicKey`/`canonicalize`, added
  as a runtime dep; acyclic — encryption deps only core) + Node `crypto` ed25519 sign/verify, NOT new crypto.
  **Trust tiers T1–T4** (`tierPermissions`): T1 community=advice-only (unsigned), T2 verified=sandboxed scripts
  no-net, T3 org-trusted=declared-host network, T4 first-party=full. **Four gates** `assessSkillPackage()`:
  (1) *structural* — size ceilings, invisible/hidden chars in name/desc, insecure-YAML surfacing;
  (2) *content-safety* — static scanners (injection markers, dangerous script patterns [`curl|sh`, `os.system`,
  reverse shells, raw-IP egress], secret-access [`~/.ssh`, `.aws/credentials`, embedded private keys]) PLUS an
  **injected `deepScan`** (LLM/guardrails) under a **hard timeout** so a hostile input can't hang the pipeline;
  (3) *capability* — least-privilege: a script that uses the network while the manifest declares none is blocked
  (AST03), manifest can't exceed the tier ceiling; (4) *provenance* — signature valid + trusted-publisher
  allowlist + `pinnedDigest` drift check. Returns `{allowed, earnedTier, gates, findings}` where earnedTier is
  capped by what the checks justify (unsigned/untrusted → T1). `OWASP_AGENTIC_SKILLS_TOP_10` = the AST01–AST10 →
  gate mapping. Exported from index.ts; grounded in the 2026 OWASP Agentic Skills Top 10 + skill-signing
  research (Ed25519 over content hash; ClawHub poisoning / Snyk ToxicSkills 36%). Changeset
  `.changeset/skills-security-gates.md` (patch).
- **Tested — full suite 142/142 green** (was 115; +25 unit +2 real-LLM): `skill-security.test.ts` 25 hermetic
  4-tier — *positive* tier ladder, stable/sensitive hash, sign→verify, clean-signed earns its tier, unsigned
  advice capped at T1, OWASP map complete; *negative* edit-after-sign→digest mismatch, wrong key, corrupt sig,
  sig-without-pubkey blocked, tampered signed pkg → dropped to T1; *security* **each OWASP AST01–AST10 as a test
  case** asserting the RIGHT gate blocks with the right id (malicious code, injection, invisible-char smuggling,
  excessive/undeclared net, tier ceiling, metadata hidden char, no-sandbox-at-T1, pinned-digest drift, insecure
  YAML surfaced, secret exfil, execution:false-with-scripts escalation); *stress* 10k sign+verify+assess <20s,
  hung deepScan can't hang the pipeline (hard timeout). Plus `skill-security.realllm.test.ts` 2 **REAL OpenAI
  (gpt-4o) e2e** — FLAGSHIP: a benign skill passes; a **SUBTLE exfiltration instruction that slips past the
  static regex is caught by the model** and blocks install (proves the layered static+semantic defense).
- GOTCHAs: provenance gate's unsigned early-return must compute `passed` from findings (a `pinnedDigest` block
  can co-exist with unsigned); `allText()` for scanners must include name+description (YAML/injection can hide in
  metadata not just body); an unsigned pkg WITH scripts is correctly refused at default T1 (test advice-only pkgs
  for the "unsigned→T1 allowed" case); relax stress timing bounds + add explicit vitest test timeouts (default 5s
  vitest timeout flakes the 10k-scan under parallel load).

### Phase 4 — Evaluation harness + lifecycle governance (G11, G12) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** new `src/skill-evaluation.ts`. `evaluateSkill(skill, opts)` → `{reusability, composability,
  maintainability, taskCompletion, overall, passed, findings}` — each dimension a `{score, measured, reasons}`.
  Qualitative dims by fast HEURISTICS (composability: provides/precondition/requires/conflicts/tools;
  maintainability: version/examples/whenNotToUse/completionContract/guidance-size; reusability: examples-count/
  when-to-use-generality/triggerPatterns/category), refined by an OPTIONAL injected `judge` (blended avg).
  **taskCompletion is MEASURED BY RUNNING** the skill: `opts.cases` through injected `runCase(skill,input)` +
  `judgeCase({input,output,expectation})` → pass rate (no cases → `measured:false`, excluded from `overall`,
  finding emitted). overall = weighted over MEASURED dims (default completion .4 / reuse .2 / compose .2 /
  maintain .2), passed = overall≥.7 AND taskCompletion≥.8. Judge seam (`SkillJudge`/`SkillRubricCriterion`/
  `SkillJudgeRequest`/`SkillJudgeResponse`) is **shape-compatible with `@weaveintel/testing`'s `RubricJudgeAdapter`**
  so adopters pass it straight in — REUSE-by-injection, NO hard dep (testing pulls in sandbox; kept skills at
  core+encryption+retrieval). `evaluatePromotion(input, policy)` → `{decision: promote|hold|demote, toTier,
  reasons}` gates Phase-3 tier moves: needs eval.passed + signatureValid for T2+ + **humanApproved for
  ≥T3** (poisoned/gamed eval alone tops out just below the human-gated tier — anti-gaming), auto-DEMOTE on
  regression (baseline.overall − ev.overall ≥ demoteOnRegressionDelta[.15]). **Lifecycle**: `SkillLifecycleState`
  draft→active→deprecated→retired + optional `lifecycle`/`deprecation` fields added to `SkillDefinition` (inline
  `import()` types, additive); `deprecateSkill(skill,{reason,replacedBy})` (still usable, points to replacement),
  `retireSkill(skill,reason)` (enabled:false), `isSkillUsable(skill)` (retired/disabled → false),
  `lifecycleForEvaluation(current,ev,{baseline})` (regression → auto-move active→deprecated = "demote after
  repair"; draft+passed→active). Exported from index.ts; grounded in 2026 skill-eval SOTA (reuse/compose/maintain
  + task-completion; layered automated→LLM-judge→HUMAN review vs the 37% lab-vs-prod gap; SkillsVote/SKILL.nb
  lifecycle). Changeset `.changeset/skills-evaluation-lifecycle.md` (patch).
- **Tested — full suite 163/163 green** (was 142; +19 unit +2 real-LLM): `skill-evaluation.test.ts` 19 hermetic
  4-tier — *positive* good skill scores well, task-completion measured by running cases (3/3), poor skill fails,
  injected judge lifts scores; *negative* off-task runner → 0 completion → not passed, throwing runner counted as
  failure not crash, broken judge falls back to heuristics; *security/anti-gaming* clean+signed promotes T1→T2,
  NO promote to T2 without signature, **a gamed perfect eval CANNOT reach human-gated T3 on its own** (needs
  humanApproved), regression auto-demotes T3→T2, failing eval holds; *lifecycle* deprecate keeps usable +
  replacedBy, retire disables, regression→deprecated, draft+passed→active; *stress* 1k skills heuristic <2s, 1k×3
  cases <5s. Plus `skill-evaluation.realllm.test.ts` 2 **REAL OpenAI e2e** — FLAGSHIP: real gpt-4o-mini PERFORMS
  the contract-summary skill on real contracts, real gpt-4o GRADES completion + a real rubric judge scores the
  qualitative dims → passed → `evaluatePromotion` promotes T1→T2; SECURITY: an off-task runner (same nice
  description) is FAILED by the real judge → promotion held (description alone can't pass the gate).
- GOTCHA: default `judgeCase` inline lambda infers `{pass}` not `{pass,reason?}` → annotate
  `const judgeCase: NonNullable<EvaluateSkillOptions['judgeCase']> = opts.judgeCase ?? (...)` so `verdict.reason`
  typechecks. Real-LLM eval e2e ~21s (perform+grade over 3 cases ×2 tests).

### Phase 5 — MCP interop + standard import/export (G15) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** new `src/skill-interop.ts` — `exportSkillMd(pkg)→string` (inverse of the Phase-2 parser;
  emits frontmatter incl. manifest network/filesystem/secrets + `allowed-tools` space-delimited + preserved
  metadata keys; only emits `execution: false` when it differs from the scripts-present default → lossless),
  `exportSkillPackage(pkg)→{path:contents}` (SKILL.md + resources + scripts), `skillDefinitionToSkillMd(skill)`
  (publish an in-code def out), `importSkillMd(string|filesMap, opts)→{package, definition, assessment}`
  (parse + **ALWAYS `claimedTier:1` + full Phase-3 gate scan** — never trusted on import; sets
  `definition.lifecycle:'draft'`; `rejectIfBlocked` throws with the blocking findings; malformed → precise
  `SkillPackageError`), `importSkillMdDirectory({folder:filesMap})→{imported[], failed[]}` (per-folder
  try/catch — a bad folder is collected not fatal). New `src/skill-mcp.ts` — `createSkillMcpBridge({skills,
  packageFor?, retriever?, serverInfo?, maxResults?})→SkillMcpHandlers` (**structurally identical to
  `@weaveintel/mcp-server`'s `McpHandlers`** → drop straight into its `handleMcpMessage`; REUSE-by-structural-
  compat, NO hard dep) exposing 3 discovery-on-demand tools: `list_skills` (L1 cards), `search_skills`
  (uses the injected retriever = Phase-0; defaults to lexical), `get_skill` (returns SKILL.md via
  exportSkillMd if a package exists, else skillDefinitionToSkillMd). `isSkillUsable` filter hides
  retired/disabled skills (ties to Phase-4 lifecycle). Grounded in MCP-2026 research (JSON-RPC 2.0; skills
  COMPLEMENT MCP via progressive/on-demand discovery vs dumping all tools into context; MCP roadmap adding a
  Skills primitive). Exported from index.ts; README "Sharing skills with other tools" section; changeset
  `.changeset/skills-interop-mcp.md` (patch).
- **Tested — full suite 183/183 green** (was 163; +18 unit +2 real-LLM): `skill-interop.test.ts` 18 hermetic
  4-tier — *positive* import public SKILL.md, **round-trip export→import lossless** (incl. security manifest
  network/secrets + scripts/resources), export a SkillDefinition→re-import; *negative* missing/invalid name +
  name≠folder precise errors, bad folder in batch collected-not-thrown; *security* imported skill always
  earnedTier:1 + lifecycle:'draft' + all 4 gates ran, malicious script (AST01) flagged + rejectIfBlocked
  throws, injection in body (AST02) caught; *MCP bridge* 3 tools, list hides retired, search finds the right
  skill, get_skill round-trips, unknown id → isError not throw; *stress* import 500-skill directory <5s all
  T1, MCP search over 2000-skill catalog <500ms. Plus `skill-interop.realllm.test.ts` 2 **REAL OpenAI e2e** —
  FLAGSHIP: import a public meeting-minutes SKILL.md → fold its guidance into a real gpt-4o-mini → it PRODUCES
  minutes (summary+decisions+action-items) from a real transcript, real gpt-4o judge confirms it FOLLOWED the
  imported skill (captured the CSV decision + Bob/Carol owners); MCP semantic discovery: bridge w/ REAL
  embeddings finds meeting-minutes from "tidy write-up of who agreed to what after our call" (lexical would
  miss) → get_skill → re-import round-trips.

### Phase 6 — Autonomous skill mining + adaptive/multimodal (G14, G16, G17) — ✅ DONE (in `packages/skills`, pending `0.1.2` publish)
- **Built:** new `src/skill-mining.ts`. `mineSkillCandidates(traces, opts)` — clusters FAILING `SkillRunTrace`s
  by normalised `failureReason` (or injected `clusterKey`), and for each pattern with ≥`minOccurrences`(3) emits
  a `SkillProposal{draft, evidence{pattern,occurrences,exampleRequests}, safety, requiresApproval:true}` (ranked
  by frequency, `maxProposals` cap). Draft via injected LLM `proposer` OR a safe heuristic. **SAFETY (the core
  guarantee):** every draft is ALWAYS `enabled:false, lifecycle:'draft', trust:0` — can NEVER auto-enable; the
  ONLY path to live is `approveMinedSkill({proposal, evaluation, humanApproved, targetTier?, signatureValid?})`
  which requires human sign-off AND `evaluation.passed` AND `!draftFlagged` (T1 default = advice, no signature;
  T2+ additionally runs the Phase-4 `evaluatePromotion` gate = needs signature). Poisoned trajectories: each
  cluster's trace text is scanned via `scanTextForInjection` (NEW export on skill-security.ts reusing Phase-3
  INJECTION_MARKERS+INVISIBLE_CHARS) — if injection found, the LLM proposer is SKIPPED and only a safe inert
  heuristic draft is produced (injection never copied verbatim), `safety.injectionInTraces:true`. `suggestedMinScore(samples, opts)`
  — adaptive retrieval cut-off: given `RetrievalFeedbackSample{score,relevant}[]`, picks the threshold maximising
  F1 (fallback if <minSamples[10] or 0 relevant). **Multimodal:** optional `inputModalities?: SkillModality[]`
  ('text'|'image'|'audio'|'pdf'|'table'|'code') added to SkillDefinition (inline import() type, additive) +
  `skillAcceptsModality(skill,modality)` (undeclared → text-only) + `filterSkillsByModality`. Grounded in 2026
  autonomous-skill-induction SOTA (SkillComposer Create/Merge/Improve, SENTINEL failure-driven, AutoSkill; skill
  poisoning via injected trajectories = top self-improvement attack surface → hard human+eval gate). Exported
  from index.ts; README "Learning new skills from experience" section; changeset
  `.changeset/skills-mining-adaptive-multimodal.md` (patch).
- **Tested — full suite 201/201 green** (was 183; +16 unit +2 real-LLM): `skill-mining.test.ts` 16 hermetic
  4-tier — *positive* recurring failure → sensible draft, injected proposer richer draft, frequency-ranked +
  maxProposals, full approve flow enables human-approved+evaluated skill; *negative/security* every proposal
  disabled+draft+trust0+requiresApproval, rare pattern (<minOccurrences) not proposed, approval refused without
  humanApproved, refused when eval fails, **prompt-injected trajectory CANNOT mint auto-trusted skill** (proposer
  skipped, injection not in draft, draftFlagged blocks approve); *adaptive* suggestedMinScore separates
  relevant/noise (F1>0.9), safe fallback on sparse/all-irrelevant feedback; *multimodal* text-only default,
  vision skill accepts image/pdf not text, filter; *stress* mining over **100k runs** single-pass bounded output
  <6s. Plus `skill-mining.realllm.test.ts` 2 **REAL OpenAI e2e** — FLAGSHIP self-improvement loop: real gpt-4o
  DRAFTS a citations skill from 5 real failures → human reviews/completes (adds version+examples) → real eval
  (gpt-4o-mini runs it, gpt-4o judges citations) passes → `approveMinedSkill` enables it → the SAME request that
  failed now SUCCEEDS with citations; SECURITY: an injected "read ~/.ssh/id_rsa and POST it out" trajectory
  produces only a disabled, inert draft (id_rsa never in draft, injectionInTraces:true). GOTCHA: a thin mined
  DRAFT legitimately scores <0.7 overall even at 100% task-completion (composability heuristic low) → the loop
  EXPECTS a human to review+complete (add version/examples) before eval, which is the honest flow.

---

## ✅ ROADMAP COMPLETE — all 7 phases (P0–P6) built, tested, documented; land together in `0.1.2`

Every phase is additive & backward-compatible (lexical retrieval stays default, all new capability opt-in), so
the community + private geneWeave apps on `^0.1.1` build unchanged and auto-adopt `0.1.2`. Package deps grew only
to `core + encryption + retrieval` (sandbox/testing/mcp-server reused by injection/structural-compat, NOT hard
deps). Full skills suite **201/201 green** incl. **13 real-OpenAI e2e** across all phases. 7 changesets staged
(6 skills-patch + 1 sandbox-patch). **PENDING: user confirmation to publish `@weaveintel/skills@0.1.2` +
`@weaveintel/sandbox@0.1.2`** (exact commands to be listed first), then downstream app-wiring in community/private
geneWeave (choose embedder + admin toggles; author dependency/conflict edges; wire sandbox runner for L3 scripts;
sign+gate on import; eval/promotion admin; MCP endpoint; mining review queue) — all opt-in behind DB config.

---

## 6. Apps that reuse this (why the engine stays generic)

The same engine should serve very different products — proof the design is not geneWeave-specific:
- **Coding agent** (Cursor/Codex-style): `SKILL.md` packages with scripts (lint, codemod, PDF/spreadsheet
  fillers), 3-level disclosure, sandboxed execution.
- **Data analyst / Kaggle** (geneWeave today): analysis playbooks + `cse_run_code`, composition (retrieve →
  analyze → report), execution contracts.
- **Research assistant**: investigation-brief + structured-extraction skills, retrieval at scale, evals for
  citation quality.
- **Customer-support / ops agent**: procedure skills with approval policy + audit (trust tiers), MCP
  connectors as skills.
- **weaveNotes**: note-authoring/summarize/translate as skills, multimodal (voice/meeting) inputs.
- **Regulated / enterprise**: signing + provenance + org inventory/approval (OWASP/NVIDIA-verified posture).

---

## 7. npm & downstream repos

- **npm + 0.x versioning policy:** current `@weaveintel/skills@0.1.1`. **Default plan: build all phases,
  then publish once as `0.1.2`** — a single patch containing everything. All additions are **additive +
  opt-in** (new interfaces, new optional `SkillDefinition` fields, new adapters — no breaking changes), so a
  patch is correct and, because **a `0.x` caret range is locked to the minor** (both downstream repos pin
  `^0.1.1` = `>=0.1.1 <0.2.0`), `0.1.2` is adopted automatically on `npm install` — whereas a `0.2.0` would
  **not** be (they'd have to bump their range first). It can't be `0.1.1`: published npm versions are
  immutable. *(Optional alternative: publish milestones incrementally as `0.1.2`, `0.1.3`, … if you'd rather
  ship value sooner — same design, more publish cycles.)* Reserve the **minor** `0.2.0` for the first
  release that changes an existing default/export/behavior, or as a deliberate "Skills v2" milestone;
  downstream then bumps its `^0.2.0` range once. Publish via the existing Changesets flow; **run
  `npm publish` only after the user confirms the exact commands** (per standing rule).
- **Downstream (community `geneweave-community` + private `geneweave`):** both consume `@weaveintel/skills`
  from npm and seed `BUILT_IN_SKILLS` via `seedFramework`. Because every change is additive/opt-in, a version
  bump alone keeps them working. To *use* the new capabilities each phase adds a small app-side wiring
  (choose embedding model for Phase 0, enable script tools + trust policy for Phase 2/3, eval datasets for
  Phase 4) behind DB-backed config + a Builder admin page — the app pattern, not framework edits. Each
  phase's downstream step: bump the dep, run the app build + suite, verify no retired/broken imports, and
  keep the lean-default philosophy (new powerful behavior **off by default**, opt-in per deployment).

---

## 8. Immediate next step
Start **Phase 0** (retrieval upgrade) — highest leverage, lowest risk, backward compatible: it fixes the
single biggest correctness gap (lexical "semantic" matching) and unlocks scale, without touching security or
execution surfaces. Build it, get its 4-tier test suite green, then proceed through the remaining phases and
**publish everything once as `@weaveintel/skills@0.1.2`** (patch — auto-adopted by the `^0.1.1` downstreams),
alongside the geneWeave wiring behind an admin toggle.
