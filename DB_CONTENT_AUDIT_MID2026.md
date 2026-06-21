# geneWeave Database Content Audit — Mid-2026 Gap Analysis

> **Audit date**: 2026-06-21  
> **Scope**: All seeded tables for agents, skills, models, handler kinds, guardrails, scientific validation, and Kaggle mesh  
> **Method**: Read every migration (m40–m67), every seed file, every schema file, and compared field-by-field against mid-2026 state of the AI ecosystem  
> **Files audited**: 29 files across `apps/geneweave/src/migrations/`, `apps/geneweave/src/seed/`, `packages/routing/src/seed.ts`, `packages/skills/src/seed.ts`, `packages/guardrails/src/seed.ts`, `apps/geneweave/src/features/scientific-validation/sv-seed.ts`, `apps/geneweave/src/live-agents/`

---

## 1. Model Registry (`model_pricing` + `model_capability_scores`)

### 1.1 What's in the DB now

**23 models across 4 providers:**

| model_id | provider | input $/1M | output $/1M | quality | Issues |
|---|---|---|---|---|---|
| `claude-sonnet-4-6` | anthropic | $3.00 | $15.00 | 0.87 | ✅ Current |
| `claude-opus-4-7` | anthropic | $15.00 | $75.00 | 0.95 | ✅ Current |
| `claude-haiku-4-5-20251001` | anthropic | $0.80 | $4.00 | 0.72 | ✅ Current |
| `gpt-4o` | openai | $2.50 | $10.00 | 0.90 | ✅ Current |
| `gpt-4o-mini` | openai | $0.15 | $0.60 | 0.75 | ✅ Current |
| `gpt-4.1` | openai | $2.00 | $8.00 | 0.90 | ✅ Current |
| `gpt-4.1-mini` | openai | $0.40 | $1.60 | 0.75 | ✅ Current |
| `gpt-4.1-nano` | openai | $0.10 | $0.40 | 0.60 | ✅ Current |
| `o3` | openai | $2.00 | $8.00 | 0.85 | ❌ **Pricing wrong** — o3 is ~$10/$40 (mini-tier shown) |
| `o4-mini` | openai | $1.10 | $4.40 | 0.75 | ⚠️ Check pricing |
| `gemini-2.5-pro` | google | $1.25 | $10.00 | 0.92 | ⚠️ Pricing stale (tiered in/out by context) |
| `gemini-2.5-flash` | google | $0.30 | $2.50 | 0.82 | ✅ ~Correct |
| `gemini-2.5-flash-lite` | google | $0.10 | $0.40 | 0.72 | ✅ Correct |
| `gemini-1.5-pro` | google | $1.25 | $5.00 | 0.85 | ❌ **Deprecated** — disable |
| `gemini-1.5-flash` | google | $0.075 | $0.30 | 0.72 | ❌ **Deprecated** — disable |
| `llama3.1` | ollama | $0 | $0 | 0.72 | ❌ Outdated (Llama 3.3 / Llama 4 current) |
| `llama3` | ollama | $0 | $0 | 0.70 | ❌ **Very outdated** — disable |
| `qwen2.5` | ollama | $0 | $0 | 0.74 | ❌ Outdated (Qwen 3 released) |
| `mistral` | ollama | $0 | $0 | 0.68 | ⚠️ Ambiguous version — should be mistral-nemo or mistral-large |
| `phi3` | ollama | $0 | $0 | 0.65 | ❌ Outdated (Phi-4 released 2024) |
| `gemma2` | ollama | $0 | $0 | 0.66 | ❌ Outdated (Gemma 3 released 2025) |
| `deepseek-r1` | ollama | $0 | $0 | 0.80 | ✅ Still relevant locally |
| `local` | llamacpp | $0 | $0 | 0.65 | ✅ Generic (disabled) |

### 1.2 Missing Models (mid-2026)

**Anthropic:**
- `claude-fable-5` — Claude Fable 5; current frontier model per system-reminder; $?/$? (flagship tier); quality ~0.97
- `claude-opus-4-8` — Latest Opus; $15/$75 range; quality ~0.96; supports_thinking=1

**OpenAI:**
- `o3-mini` — was replaced by o4-mini (already in DB) ✓
- `o4` — Full o4 (non-mini); $12/$60; quality ~0.93; supports_thinking=1
- `gpt-5` — If released by mid-2026 (likely); $10–$15/$30–$50; quality ~0.96

**Google:**
- `gemini-2.0-flash` — Released 2025; bridge model between 1.5 and 2.5; still in use
- `gemini-2.5-ultra` — If released; Google's frontier tier

**xAI:**
- `grok-3` — xAI Grok-3; $3/$15; quality ~0.89; supports_vision=1; strong in reasoning/code
- `grok-3-mini` — $0.30/$0.50; quality ~0.75

**Mistral AI (API, not Ollama):**
- `mistral-large-2` — $2/$6; quality ~0.87; strong multilingual + code
- `mistral-medium-3` — $0.40/$2; quality ~0.80
- `codestral` — $0.20/$0.60; quality ~0.85; specialized code generation
- `mistral-small-3` — $0.10/$0.30; quality ~0.70

**DeepSeek (API):**
- `deepseek-v3` — DeepSeek-V3 via API; $0.27/$1.10; quality ~0.88; game-changing cost/quality ratio
- `deepseek-r1-api` — DeepSeek R1 via API (not just Ollama); $0.55/$2.19; quality ~0.87; supports_thinking=1

**Amazon (Bedrock/Nova):**
- `amazon-nova-pro` — $0.80/$3.20; quality ~0.82; native AWS model
- `amazon-nova-lite` — $0.06/$0.24; quality ~0.72
- `amazon-nova-micro` — $0.035/$0.14; quality ~0.60

**Meta (Llama 4, via API or Ollama):**
- `meta-llama-4-scout` — 17B/16E MoE; $0.11/$0.34; quality ~0.81
- `meta-llama-4-maverick` — 17B/128E MoE; $0.19/$0.49; quality ~0.87
- `llama3.3` — Ollama local; quality ~0.77 (replaces llama3.1)
- `llama4-scout` — Ollama local; quality ~0.81

**Updated local (Ollama):**
- `qwen3:8b`, `qwen3:30b-a3b`, `qwen3:235b-a22b` — Qwen 3 family (2025); quality 0.73/0.81/0.88
- `phi4` — Microsoft Phi-4; quality ~0.74; strong reasoning for size
- `gemma3:12b`, `gemma3:27b` — Gemma 3 (2025); quality 0.73/0.78
- `mistral-nemo` — Mistral NeMo 12B; quality ~0.75; multilingual
- `codestral:22b` — Code specialist local; quality ~0.82

### 1.3 Pricing Corrections

| model_id | DB input | Correct input | DB output | Correct output |
|---|---|---|---|---|
| `o3` | $2.00 | $10.00 | $8.00 | $40.00 |
| `o4-mini` | $1.10 | $1.10 ✅ | $4.40 | $4.40 ✅ |
| `gemini-2.5-pro` | $1.25 | $1.25 (<200K) / $2.50 (>200K) | $10.00 | $10.00 ✅ |
| `claude-opus-4-7` | $15.00 | Verify — may be $15 or higher | $75.00 | Verify |

### 1.4 Context Window — Not seeded at all

The `model_pricing` table likely has a `context_window` column but no values are seeded. This should be added:

| model | context_window (tokens) |
|---|---|
| claude-sonnet-4-6 | 200,000 |
| claude-opus-4-7 | 200,000 |
| claude-fable-5 | 200,000+ |
| gpt-4.1 | 1,047,576 |
| gpt-4o | 128,000 |
| o3 | 200,000 |
| gemini-2.5-pro | 1,048,576 |
| gemini-2.5-flash | 1,048,576 |
| deepseek-v3 | 128,000 |
| grok-3 | 131,072 |

### 1.5 Capability Flag Gaps

Only `supports_thinking`, `supports_vision`, `supports_json_mode` flags exist. Missing:

| flag | purpose | models that should have it=1 |
|---|---|---|
| `supports_computer_use` | Drives agentic.computer-use handler kind | claude-* (Anthropic added this) |
| `supports_realtime_audio` | Voice/realtime pipeline | gpt-4o (GPT-4o Realtime), claude (future) |
| `supports_long_context` | >200K tokens reliable | gemini-2.5-pro, gpt-4.1 |
| `supports_code_execution` | Native code interpreter | gpt-4o (with tools), claude (artifacts) |
| `supports_image_generation` | Generates images natively | gpt-4o (DALL-E integrated) |
| `max_output_tokens` | Different per model | 8K / 16K / 32K / 64K / 128K |

---

## 2. A2A Skills Table (`a2a_skills`)

### 2.1 What's in the DB now (3 skills)

| id | name | mode | input_content_types |
|---|---|---|---|
| `general-chat` | General Chat (Agent) | agent | text, audio, image, pdf, csv, json |
| `supervisor-orchestration` | Supervisor Orchestration | supervisor | text, audio, image, pdf, csv, json |
| `ensemble-reasoning` | Ensemble Reasoning | ensemble | text, audio, image, pdf, csv, json |

### 2.2 What's Missing (mid-2026 A2A ecosystem)

The Google A2A spec (April 2024) and ecosystem by mid-2026 defines many standard skill types. Only 3 are seeded:

| proposed_id | name | mode | why_needed |
|---|---|---|---|
| `computer-use` | Computer Use Agent | agent | Anthropic computer use; controlling UI via screenshots |
| `browser-automation` | Web Browser Agent | agent | Browse/scrape/interact with live websites |
| `code-execution` | Code Interpreter | agent | Execute Python/JS in sandboxed env; data analysis |
| `document-intelligence` | Document Processing | agent | PDF/DOCX/XLSX extraction, summarization, QA |
| `image-analysis` | Vision & Image Analysis | agent | Multi-image reasoning, OCR, chart interpretation |
| `image-generation` | Image Generation | agent | DALL-E / Stable Diffusion / Imagen generation |
| `voice-interaction` | Voice Agent | agent | Real-time audio, transcription, TTS |
| `data-pipeline` | Data Pipeline Agent | agent | ETL, transformation, pandas/SQL/dbt |
| `memory-retrieval` | Memory & RAG Agent | agent | Vector search, knowledge base retrieval |
| `workflow-orchestration` | Workflow Orchestrator | supervisor | Complex multi-step durable workflow execution |
| `research-synthesis` | Research Synthesis | agent | Literature search + synthesis (broader than HV) |
| `code-review` | Code Review Agent | agent | PR review, security scanning, refactoring |
| `hypothesis-validation` | Scientific Validation | agent | Existing as a skill (currently only as a feature, not an A2A skill) |

### 2.3 Agent Worker Subtype Gap (m61)

The `agent_workers` JSON in `supervisor-orchestration` only defines 3 worker types:
- `code_executor` — CSE tools
- `analyst` — calculator, web_search, memory_recall
- `researcher` — web_search, memory_recall

Missing workers for a full mid-2026 supervisor:
- `computer_use_worker` — with `computer_use_screenshot`, `computer_use_click`, `computer_use_type` tools
- `document_worker` — with `pdf_extract`, `docx_parse`, `excel_read` tools
- `image_worker` — with `image_analyze`, `ocr_extract`, `chart_parse` tools

### 2.4 MIME Type Gaps

Current input_content_types covers `text/plain, audio/*, image/*, application/pdf, text/csv, application/json`.

Missing:
- `application/vnd.openxmlformats-officedocument.*` — Word/Excel/PowerPoint
- `text/html` — HTML pages (for web browsing skills)
- `video/*` — Video analysis (Gemini 2.5 supports this)
- `application/octet-stream` — Binary data/files

---

## 3. Handler Kinds (`live_handler_kinds`)

### 3.1 What's in the DB (7 kinds)

| kind | type | uses LLM |
|---|---|---|
| `agentic.react` | ReAct loop | Yes |
| `agentic.scripted` | Fixed pipeline | Yes |
| `deterministic.template` | Mustache render | No |
| `deterministic.forward` | Queue forward | No |
| `deterministic.observer` | Audit-only | No |
| `human.approval` | HITL pause | No |
| `external.webhook` | HTTP POST | No |

### 3.2 Missing Handler Kinds (mid-2026)

| proposed_kind | description | priority |
|---|---|---|
| `agentic.computer-use` | Uses `computer_use_screenshot` + click/type tools; Anthropic-native; cycles screenshot → action | HIGH |
| `agentic.browser` | Playwright/Puppeteer integration; navigate, click, scrape, fill forms | HIGH |
| `agentic.code-interpreter` | Spawns CSE session for data analysis; auto-installs libs; returns artifacts | HIGH |
| `agentic.voice-realtime` | OpenAI Realtime API / Gemini Live; streaming audio in/out | MEDIUM |
| `agentic.multimodal` | Accepts images/PDFs natively in each inference step | MEDIUM |
| `deterministic.mapreduce` | Fans out to N parallel workers, collects and reduces | MEDIUM |
| `multi-agent.swarm` | Peer-to-peer agent collaboration (no single supervisor); consensus-based | LOW |
| `external.mcp-tool` | Invokes an MCP server tool directly without LLM reasoning | MEDIUM |

### 3.3 Attention Policy Gaps

Current 3 policies: `heuristic.inbox-first`, `cron.rest-only`, `model.adaptive`

Missing:
- `event.webhook-trigger` — activate on external webhook event (Zapier, n8n style)
- `event.file-watcher` — activate on new file in watched path/bucket
- `event.db-change` — activate on DB row insert/update (CDC-style)
- `model.llm-relevance` — LLM judges if incoming message is relevant to THIS agent's skill before waking

---

## 4. Routing Policies & Task Types

### 4.1 Current State

3 routing policies (Cost Optimized, Quality First, Balanced) and 16 task types.

### 4.2 Missing Task Types

| task_type | why_needed |
|---|---|
| `computer_use` | Route to computer-use capable models (claude-*) |
| `audio_understanding` | Transcription + audio analysis |
| `video_understanding` | Gemini 2.5 Pro has this natively |
| `long_document_analysis` | Route to 1M context models (gemini-2.5-pro, gpt-4.1) |
| `structured_extraction` | Route to models strong at JSON mode |
| `multi_turn_agent` | Route to models with strong instruction following over many turns |
| `mathematical_reasoning` | Distinct from generic reasoning; route to o3/o4-mini |
| `scientific_analysis` | Route to models with strong STEM (claude-opus, gemini-2.5-pro) |

### 4.3 Missing Routing Policies

| name | strategy | use_case |
|---|---|---|
| Reasoning-First | reasoning | Route to o3/o4-mini/claude-opus-4-7 for math/logic |
| Long-Context | quality+context | Prefer 1M-token models for large documents |
| Vision-Only | quality | Must support_vision=1; route to GPT-4o/claude/gemini |
| Local-First | cost | Prefer Ollama models; fallback to cloud only if needed |
| GDPR-Safe | compliance | Only use EU-region or on-prem models |

### 4.4 Provider Tool Adapter Gaps

Currently 4 adapters: `openai`, `anthropic`, `google`, `ollama`. Missing:
- `xai` — xAI Grok uses OpenAI-compatible API but needs its own adapter entry for correct model enumeration
- `mistral` — Mistral API (separate from OpenAI-compat format for function calling)
- `amazon-bedrock` — Converse API format differs from others
- `deepseek` — DeepSeek uses OpenAI-compat but separate entry needed

---

## 5. Scientific Validation (SV) Tables

### 5.1 Current State

7 agents (supervisor disabled, 6 worker agents), 7 system prompts, 18 tool catalog entries, 2 budget envelopes, 1 workflow definition.

### 5.2 Gaps in SV Tool Catalog

**Mathematical tools (both disabled):**
- `sympy_simplify`, `sympy_solve`, `sympy_integrate` — disabled due to no sandbox image. Should be enabled now that CSE is live.
- `wolfram_query` — disabled (no API key). Should at minimum be optionally enabled with configuration.

**Missing tools as of mid-2026:**

| tool_key | category | why_needed |
|---|---|---|
| `preprint_search` | literature | bioRxiv, medRxiv, chemRxiv — preprints are critical in 2026 |
| `unpaywall_fetch` | literature | Full-text open access retrieval |
| `retraction_watch` | literature | Check if cited papers have been retracted |
| `clinicaltrials_search` | literature | ClinicalTrials.gov for medical hypotheses |
| `cochrane_search` | literature | Cochrane systematic reviews (gold standard) |
| `pymc5_bayes` | statistical | PyMC 5.x (major API change from 4.x — current tool key `pymc_mcmc` is PyMC 4) |
| `arviz_diagnostics` | statistical | ArviZ 0.18+ for Bayesian model diagnostics |
| `causalml_estimate` | statistical | Causal inference (DoWhy, EconML) |
| `rapids_cuml` | simulation | GPU-accelerated ML for large-scale simulation |
| `mesa_abm` | simulation | Agent-based modelling (Mesa 3.x) |
| `dspy_optimize` | utility | Optimise prompts for sub-agents using DSPy |
| `replication_check` | quality | Compare methodology with original study protocol |

**Literature database gap:**
- Missing `dimensions_search` — Dimensions.ai is now larger than Semantic Scholar for biomedical
- Missing `lens_search` — The Lens open scholarly database
- Missing `core_search` — CORE aggregates millions of open access papers

### 5.3 SV Agent Gaps

**Supervisor is disabled** (`enabled: 0`). The orchestration is currently driven by the workflow engine. This is a design choice, but the supervisor agent should be enabled for standalone A2A skill usage.

**Missing agent roles:**
| proposed_id | name | role |
|---|---|---|
| `sv-replication` | Rex | Replication Validator — checks if methodology matches the original study; runs replication protocols |
| `sv-data-quality` | Dana | Data Quality Agent — assesses dataset integrity, completeness, preprocessing decisions |
| `sv-bias-detector` | Bianca | Bias & Fairness Agent — p-hacking, HARKing, publication bias, selection bias |

### 5.4 SV Budget Gaps

Standard budget: max_llm_cents=50, max_wall_seconds=300 — this is **very tight** for complex hypotheses. Literature search alone can take 60–90s.

Suggested tiers:
- **Express** (new): max_llm_cents=15, max_wall_seconds=90, max_rounds=2 (quick feasibility check)
- **Standard**: max_llm_cents=50 → raise to **100**, max_wall_seconds=300 → raise to **600**
- **Premium**: max_llm_cents=200 → raise to **500**, max_wall_seconds=900 → raise to **1800**
- **Research** (new): max_llm_cents=2000, max_sandbox_cents=500, max_wall_seconds=7200, max_rounds=10

### 5.5 SV System Prompt Gaps

| prompt_key | gap |
|---|---|
| `sv.literature` | Doesn't reference preprint servers (bioRxiv, medRxiv) — critical since ~40% of COVID-era literature started as preprints |
| `sv.statistical` | `pymc_mcmc` references PyMC 4.x API — needs update to PyMC 5.x (`pm.sample()` signature changed) |
| `sv.mathematical` | No reference to Lean 4 / Coq for formal verification — by 2026 these are viable for proof checking |
| `sv.adversarial` | Missing AI-generated paper detection — a 2026-critical concern where LLMs write fake studies |
| `sv.supervisor` | GRADE framework version not specified; GRADE Working Group released updates in 2025 |
| `sv.supervisor` | Missing replication crisis context — should flag when testing claims from high-profile failed replications |

---

## 6. Guardrails (`guardrails`)

### 6.1 Current State

30 guardrails across 8 categories. Good baseline coverage.

### 6.2 Missing Guardrails (mid-2026)

**EU AI Act Compliance (mandatory from August 2025):**

| proposed_key | phase | action | priority |
|---|---|---|---|
| `eu_ai_act.high_risk_classification` | pre | warn/log | 90 |
| `eu_ai_act.prohibited_manipulation` | pre | deny | 100 |
| `eu_ai_act.biometric_data_check` | pre | deny | 98 |
| `eu_ai_act.transparency_disclosure` | post | warn | 70 |

**AI-Generated Content Detection (critical 2026 concern):**

| proposed_key | phase | action | priority |
|---|---|---|---|
| `aidet.llm_generated_paper` | post | warn | 75 |
| `aidet.deepfake_reference` | post | warn | 80 |
| `aidet.synthetic_data_flag` | pre | warn | 65 |

**Memory/Agent-Specific (new for agentic era):**

| proposed_key | phase | action | priority |
|---|---|---|---|
| `agent.memory_poisoning` | pre | deny | 96 |
| `agent.goal_hijacking` | pre | deny | 97 |
| `agent.tool_call_injection` | pre | deny | 99 |
| `agent.excessive_resource_use` | pre | warn | 78 |
| `agent.unauthorized_delegation` | pre | deny | 95 |

**Copyright & IP:**

| proposed_key | phase | action | priority |
|---|---|---|---|
| `ip.verbatim_reproduction` | post | warn | 72 |
| `ip.code_license_mismatch` | post | warn | 68 |

**Data Residency (enterprise):**

| proposed_key | phase | action | priority |
|---|---|---|---|
| `compliance.data_residency_eu` | pre | deny | 95 |
| `compliance.data_residency_us` | pre | warn | 85 |

### 6.3 Existing Guardrail Corrections

- `Hallucination Check` (post/factuality, priority 70) — needs model updated to a 2026 grader model (currently unspecified)
- `Model-Graded` guardrails don't specify which model to use as judge — should be `claude-haiku-4-5-20251001` for cost-effective judging
- `Sycophancy Judge` priority 59 is too low — should be 72 given how problematic this is with long multi-turn conversations

---

## 7. Kaggle Live Mesh

### 7.1 Current State

1 mesh (`kaggle`), 6 agent roles, 5 delegation edges, 4 playbooks (default discovery, ARC-AGI-3, Orbit Wars, generic ML).

### 7.2 Model Assignments

None of the Kaggle agents specify which model to use — they rely on global routing. For 2026, the strategist should explicitly use `claude-opus-4-7` or `o3` (best at multi-step planning), while the implementer should use `claude-sonnet-4-6` or `gpt-4.1` for cost-efficiency.

### 7.3 Playbook Content Gaps

**`KAGGLE_GENERIC_ML_SOLVER` (Python template):**
- Uses `HistGradientBoosting*` — this was state-of-the-art 2022–2023 but by 2026:
  - `lightgbm` or `xgboost` is still faster and often better (already in Kaggle kernels)
  - `tabpfn` (TabPFN v2, 2025) achieves competitive results on small-medium tabular data with zero tuning
  - `autogluon` with `TabularPredictor` is a near-universal Kaggle baseline that beats HistGBM
  - LLM-based feature engineering (prompting an LLM to suggest features) is now viable
- Missing: cross-validation with early stopping
- Missing: feature importance logging for debugging
- Missing: optuna-based hyperparameter search for iteration 2+

**`KAGGLE_ARC_AGI_3_WORKFLOW`:**
- References `kaggle_environments` v0.9.3 API — need to verify this is current
- ARC-AGI-3 competition may have ended or been replaced by ARC-AGI-4 by mid-2026
- The "5-rung improvement ladder" is solid but missing: test-time compute (chain-of-thought over ARC tasks is now standard)

**`KAGGLE_DEFAULT_DISCOVERY`:**
- The SUBMISSION CONTRACT block pattern is excellent
- Anti-thrash `kernelRef` rule is critical ✅
- Missing: GPU tier detection — Kaggle now has P100/T4/P100×2/TPU sessions; the playbook should probe and adapt

**Missing playbooks for 2026 competition types:**
- `KAGGLE_NLP_SEQUENCE` — for NLP classification/generation tasks (fine-tune a HuggingFace model)
- `KAGGLE_VISION_CNN` — for image classification/segmentation (timm + PyTorch Lightning baseline)
- `KAGGLE_TIME_SERIES` — for forecasting competitions (LGBM + lag features + statsmodels ETS)
- `KAGGLE_LLM_BENCHMARK` — the growing category of LLM-judged competitions

### 7.4 Kaggle Mesh Topology Gaps

Current: linear pipeline (discoverer → strategist → implementer → validator → submitter) with observer side-channel.

Missing:
- **Parallel implementer workers** — one implementer per approach being tried simultaneously
- **Leaderboard monitor** — dedicated agent that polls public leaderboard hourly and routes insights back to strategist
- **Debrief role** — after submission, analyzes what worked/failed for future runs

### 7.5 Role Capability Gaps

`kaggle_role_capabilities` seeds RBAC for 6 roles but:
- Missing `KAGGLE_READ_LEADERBOARD` for `strategist` (only observer has it — strategist needs it to adjust strategy)
- Missing `KAGGLE_LOCAL_COMPUTE` for `implementer` (only validator has it — implementer needs to run CSE locally)
- `submitter` has `KAGGLE_SUBMIT` but no `KAGGLE_READ_LEADERBOARD` — should check submission score after submitting

---

## 8. Agent Strategy Settings

### 8.1 Current State

1 row: `global` scope, all strategies disabled:
- `reflect_enabled=0`
- `verify_enabled=0`
- `supervisor_replan_on_failure=0`
- `supervisor_parallel_delegation=0`
- `a2a_enabled=0`

### 8.2 Recommended Changes

By mid-2026, these defaults are too conservative for production:
- `a2a_enabled` should default to `1` — A2A is now stable (spec v0.9+)
- `supervisor_parallel_delegation` should default to `1` — parallel delegation is the norm for speed
- `reflect_enabled` should default to `1` — reflection improves quality significantly for complex tasks
- Missing settings that need new columns:
  - `hitl_threshold` — minimum risk score to require human approval (currently hardcoded)
  - `max_agent_hops` — maximum depth of A2A delegation chain (prevent infinite loops)
  - `tool_confirmation_level` — none/medium/high-risk-only
  - `memory_policy` — none/session/persistent (controls what gets saved to vector/graph memory)

---

## 9. Phase-by-Phase Implementation Plan

### Phase 1 — Model Registry Refresh
**Priority: Critical | Effort: Medium | Risk: Low**  
**Rationale**: Incorrect pricing/missing models affect every routing decision. o3 is priced 5× too low. Gemini 1.5 models are deprecated. Fable 5/Opus 4.8 are missing entirely.

**Migration**: `m68-model-registry-refresh.ts`

```
Actions:
1. UPDATE model_pricing SET input_cost_per_1m=10.00, output_cost_per_1m=40.00 WHERE model_id='o3'
2. UPDATE model_pricing SET enabled=0 WHERE model_id IN ('gemini-1.5-pro','gemini-1.5-flash','llama3','phi3','gemma2')
3. UPDATE model_pricing SET quality_score=0.77 WHERE model_id='llama3.1' (and rename hint to 3.3)
4. INSERT 20 new model rows: claude-fable-5, claude-opus-4-8, grok-3, grok-3-mini, 
   deepseek-v3, deepseek-r1-api, mistral-large-2, mistral-medium-3, codestral,
   amazon-nova-pro, amazon-nova-lite, amazon-nova-micro,
   meta-llama-4-scout, meta-llama-4-maverick, gpt-4.1 (context_window),
   llama3.3, qwen3:8b, qwen3:30b-a3b, phi4, gemma3:27b
5. ADD context_window column to model_pricing (if not present)
6. SEED context windows for all 30+ models
7. ADD capability flags: supports_computer_use, supports_realtime_audio, 
   supports_long_context, supports_code_execution, max_output_tokens
8. SEED capability flags for all new models
9. INSERT capability scores for all new models × task types
10. UPDATE routing policy fallbacks to use current models
```

**Seed updates**: `packages/routing/src/seed.ts` — add all new models, fix pricing, add context windows

---

### Phase 2 — A2A Skills Taxonomy Expansion
**Priority: High | Effort: Medium | Risk: Low**  
**Rationale**: 3 skills is insufficient for a 2026 AI platform. Browser, computer use, code execution, voice, document processing are all mainstream by now. These skills are required for the `computer-use` and `browser-automation` handler kinds to work.

**Migration**: `m69-a2a-skills-v2.ts`

```
Actions:
1. INSERT 12 new a2a_skills rows:
   - computer-use, browser-automation, code-execution,
     document-intelligence, image-analysis, image-generation,
     voice-interaction, data-pipeline, memory-retrieval,
     workflow-orchestration, research-synthesis, hypothesis-validation
2. UPDATE existing supervisor-orchestration agent_workers JSON:
   - Add computer_use_worker, document_worker, image_worker
3. ADD MIME types to all skills: video/*, text/html, application/vnd.openxmlformats-*
4. UPDATE security_scopes for new skills (separate permission namespaces)
5. UPDATE enabled=0 for skills without prerequisite tools wired
```

**New files needed**: 
- `packages/skills/src/a2a-skill-catalog.ts` — typed catalog of all skill definitions
- Add skill entries to the skills table via seed

---

### Phase 3 — Handler Kinds & Attention Policies
**Priority: High | Effort: High | Risk: Medium**  
**Rationale**: `agentic.react` covers most cases but computer use, browser, and code-interpreter patterns are fundamentally different execution loops that need distinct handler kinds to route correctly.

**Migration**: `m70-handler-kinds-v2.ts`

```
Actions:
1. INSERT 8 new live_handler_kinds:
   - agentic.computer-use (config: model, screenshot_interval_ms, max_steps)
   - agentic.browser (config: model, playwright_config, max_pages, allowed_domains)
   - agentic.code-interpreter (config: model, runtime, max_cells, auto_install_libs)
   - agentic.voice-realtime (config: model, voice, turn_detection, max_duration_s)
   - agentic.multimodal (config: model, image_detail, max_images_per_turn)
   - deterministic.mapreduce (config: fan_out_role_key, reduce_fn)
   - multi-agent.swarm (config: peer_role_keys, consensus_threshold, max_rounds)
   - external.mcp-tool (config: mcp_server_url, tool_name, headers)
2. INSERT 4 new live_attention_policies:
   - event.webhook-trigger
   - event.file-watcher
   - event.db-change
   - model.llm-relevance (needs LLM call to decide wake)
```

**New handler implementations needed**:
- `apps/geneweave/src/live-agents/handlers/computer-use-handler.ts`
- `apps/geneweave/src/live-agents/handlers/browser-handler.ts`
- `apps/geneweave/src/live-agents/handlers/code-interpreter-handler.ts`

---

### Phase 4 — Guardrails Modernization
**Priority: High | Effort: Medium | Risk: Low**  
**Rationale**: EU AI Act compliance has been mandatory since August 2025. Memory/agent guardrails are needed now that multi-agent A2A runs are live. AI-generated content detection is a genuine 2026 concern (fake papers, deepfakes in evidence).

**Migration**: `m71-guardrails-2026.ts`

```
Actions:
1. INSERT 18 new guardrail rows:
   EU AI Act: eu_ai_act.high_risk_classification, eu_ai_act.prohibited_manipulation,
              eu_ai_act.biometric_data_check, eu_ai_act.transparency_disclosure
   AI-Content: aidet.llm_generated_paper, aidet.deepfake_reference, aidet.synthetic_data_flag
   Agent-Safety: agent.memory_poisoning, agent.goal_hijacking, agent.tool_call_injection,
                 agent.excessive_resource_use, agent.unauthorized_delegation
   IP: ip.verbatim_reproduction, ip.code_license_mismatch
   Residency: compliance.data_residency_eu, compliance.data_residency_us
   
2. UPDATE existing:
   - sycophancy_judge priority: 59 → 72
   - model-graded guardrails: add judge_model='claude-haiku-4-5-20251001'
   - hallucination_check: add grader_model field
   
3. ADD column: `judge_model TEXT` to guardrails table (for model-graded types)
4. ADD column: `compliance_framework TEXT` (for EU AI Act, GDPR, CCPA tagging)
```

**New seed file**: `packages/guardrails/src/seed-2026.ts`

---

### Phase 5 — Scientific Validation Enhancement
**Priority: Medium | Effort: High | Risk: Low**  
**Rationale**: The SV system is well-designed but the tool catalog is stale. PyMC 5 has breaking API changes. The literature search is missing 3 major databases. Both math tools are disabled despite CSE being live. The budget envelopes are too tight for real research workflows.

**Migration**: `m72-sv-tools-v2.ts`

```
Actions:
1. ENABLE sympy tools (now that CSE is live):
   UPDATE tool_catalog SET enabled=1 WHERE tool_key IN 
   ('sympy_simplify','sympy_solve','sympy_integrate')

2. INSERT 12 new SV tool catalog entries:
   Literature: preprint_search, unpaywall_fetch, retraction_watch,
               clinicaltrials_search, cochrane_search, dimensions_search, lens_search
   Statistical: pymc5_bayes, arviz_diagnostics, causalml_estimate  
   Simulation: mesa_abm, rapids_cuml (disabled until GPU sandbox ready)

3. UPDATE sv_budget_envelopes:
   - 'default': max_llm_cents 50→100, max_wall_seconds 300→600
   - 'premium': max_llm_cents 200→500, max_wall_seconds 900→1800
   
4. INSERT 2 new budget envelopes:
   - 'express': max_llm_cents=15, max_sandbox_cents=5, max_wall_seconds=90, max_rounds=2
   - 'research': max_llm_cents=2000, max_sandbox_cents=500, max_wall_seconds=7200, max_rounds=10

5. INSERT 3 new SV worker agents:
   - sv-replication (Rex), sv-data-quality (Dana), sv-bias-detector (Bianca)
   
6. UPDATE sv-supervisor: enabled=1 (for A2A skill usage)

7. INSERT new tool assignments for 3 new agents
```

**Prompt updates** (`packages/prompts/src/records.ts` or SV seed):
- `sv.literature`: Add bioRxiv, medRxiv, chemRxiv, dimensions, retraction watch instructions
- `sv.statistical`: Update PyMC syntax from v4 to v5 API (`pm.sample()`, `pm.Model()` changes)
- `sv.adversarial`: Add AI-generated paper detection instructions
- `sv.supervisor`: Add replication crisis context, specify GRADE version

---

### Phase 6 — Kaggle Mesh & Playbook Modernization
**Priority: Medium | Effort: High | Risk: Medium**  
**Rationale**: The generic ML solver baseline uses 2022-era libraries. By 2026, AutoGluon, LightGBM, and TabPFN v2 are the dominant Kaggle baselines. The mesh topology needs parallel implementers and a leaderboard monitor.

**Migration**: `m73-kaggle-mesh-v2.ts`

```
Actions:
1. UPDATE kaggle mesh blueprint:
   - Add leaderboard_monitor agent (observer.agentic handler)
   - Add parallel_implementer agent pool (config: max_parallel=3)
   - Add debrief agent (deterministic.template handler)
   - Add delegation edges for new agents
   
2. UPDATE kaggle_role_capabilities:
   - Add KAGGLE_READ_LEADERBOARD to strategist
   - Add KAGGLE_LOCAL_COMPUTE to implementer
   - Add KAGGLE_READ_LEADERBOARD to submitter
   
3. UPDATE playbook content (no DDL — content update):
   - KAGGLE_GENERIC_ML_SOLVER: replace HistGBM with autogluon/lightgbm + TabPFN v2 fallback
   - KAGGLE_DEFAULT_DISCOVERY: add GPU tier probe block
   - KAGGLE_ARC_AGI_3_WORKFLOW: update for potential ARC-AGI-4 shape detection
   
4. INSERT 3 new playbook rows:
   - KAGGLE_NLP_SEQUENCE
   - KAGGLE_VISION_CNN
   - KAGGLE_TIME_SERIES
```

**Content updates** (`apps/geneweave/src/live-agents/kaggle/playbook-seed-content.ts`):
- Update GENERIC_ML_SOLVER to use autogluon + LightGBM + TabPFN v2 as a 3-tier fallback chain
- Add GPU probe to DISCOVERY playbook
- Add 3 new competition-type playbooks

---

### Phase 7 — Agent Strategy Defaults & New Settings
**Priority: Low | Effort: Low | Risk: Low**  
**Rationale**: The global strategy defaults are 2023-era conservative defaults. A2A is now stable. Parallel delegation improves wall-clock time significantly.

**Migration**: `m74-agent-strategy-defaults-2026.ts`

```
Actions:
1. UPDATE agent_strategy_settings SET
   a2a_enabled=1,
   supervisor_parallel_delegation=1,
   reflect_enabled=1
   WHERE id='global'

2. ADD columns to agent_strategy_settings:
   - hitl_threshold REAL DEFAULT 0.75
   - max_agent_hops INTEGER DEFAULT 5
   - tool_confirmation_level TEXT DEFAULT 'high-risk-only'
   - memory_policy TEXT DEFAULT 'session'
   
3. UPDATE model mode_labels:
   - Add 'web/operator' mode for enterprise admin users
   - Add 'api/headless' mode for programmatic API usage
```

---

## 10. Summary Matrix

| Domain | Current Rows | Missing / Stale | Phase |
|---|---|---|---|
| Models (cloud) | 13 enabled | 12 missing, 2 mispriced, 2 deprecated | 1 |
| Models (local/ollama) | 7 enabled | 7 outdated/missing | 1 |
| Model capability flags | 3 flags | 6 more needed | 1 |
| A2A Skills | 3 | 12 missing | 2 |
| Handler Kinds | 7 | 8 missing | 3 |
| Attention Policies | 3 | 4 missing | 3 |
| Task Types | 16 | 8 missing | 1 |
| Routing Policies | 3 | 5 missing | 1 |
| Provider Adapters | 4 | 4 missing (xAI, Mistral, Bedrock, DeepSeek) | 1 |
| Guardrails | 30 | 18 new needed, 3 to update | 4 |
| SV Tools | 18 (2 disabled) | 12 new, 2 to enable | 5 |
| SV Budget Envelopes | 2 | 2 new, 2 to update | 5 |
| SV Agents | 7 (1 disabled) | 3 new, 1 to enable | 5 |
| Kaggle Playbooks | 4 | 3 new, 2 to update | 6 |
| Kaggle Agent Roles | 6 | 2 new, 3 capability fixes | 6 |
| Agent Strategy Settings | 1 global (all-off) | 4 new columns, 3 defaults to flip | 7 |

**Total new migrations needed**: 7 (m68–m74)  
**Total new model rows**: ~30  
**Total new guardrail rows**: 18  
**Total new skill rows**: 12  
**Total new handler kind rows**: 8

---

## 11. Quick Wins (No Migration Required)

These can be fixed by updating seed files without DDL changes:

1. **Fix o3 pricing** in `packages/routing/src/seed.ts` — 5-minute change, prevents systematic under-billing
2. **Disable deprecated models** (Gemini 1.5, llama3, phi3, gemma2) — routing quality improvement
3. **Update ARC-AGI-3 workflow** version check in playbook — competition format validation
4. **Update sv.statistical prompt** PyMC v5 syntax — prevents runtime errors in mathematical agents
5. **Add bioRxiv/medRxiv to sv.literature prompt** — higher recall on recent findings
6. **Enable sympy tools** (CSE is live) — math tools were just forgotten

---

*Generated 2026-06-21 by geneWeave content audit. Next review: 2026-Q4 or after any major model release.*
