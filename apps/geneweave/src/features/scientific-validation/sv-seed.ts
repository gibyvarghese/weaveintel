/**
 * Hypothesis Validation — DB seed data
 *
 * Seeds all 7 SV agent system prompts into the `prompts` table and all
 * 7 SV specialist worker configs into the `worker_agents` table.
 *
 * Called once at server startup (after seedDefaultData). Using stable
 * UUID v7 keys so re-runs are idempotent — existing rows are skipped.
 *
 * Prompts are keyed as `sv.<agentName>` (e.g. `sv.supervisor`).
 * SV specialists (literature, statistical, mathematical, simulation,
 * adversarial, decomposer) are seeded with category `'general'` so the main
 * chat supervisor's `listEnabledWorkerAgents` picks them up for any
 * hypothesis-flavoured chat input. Their descriptions explicitly state
 * "USE FOR hypothesis validation" so the supervisor doesn't grab them for
 * unrelated tasks. The legacy `sv-supervisor` row is kept in DB but disabled
 * (chat's own supervisor performs that role for SV runs).
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { PromptRow, WorkerAgentRow } from '../../db-types.js';

// ── Stable UUIDs for SV prompts ──────────────────────────────────────────────
// Generated once; never change — they are the idempotency key for re-seeding.
const SV_PROMPT_IDS = {
  supervisor:  'a1000001-5300-7000-b000-000000000001',
  decomposer:  'a1000001-5300-7000-b000-000000000002',
  literature:  'a1000001-5300-7000-b000-000000000003',
  statistical: 'a1000001-5300-7000-b000-000000000004',
  mathematical: 'a1000001-5300-7000-b000-000000000005',
  simulation:  'a1000001-5300-7000-b000-000000000006',
  adversarial: 'a1000001-5300-7000-b000-000000000007',
} as const;

// ── Stable UUIDs for default budget envelopes ───────────────────────────────
const SV_BUDGET_IDS = {
  standard: 'c3000001-5300-7000-b000-000000000001',
  premium:  'c3000001-5300-7000-b000-000000000002',
} as const;

// ── Stable UUIDs for SV worker agents ───────────────────────────────────────
const SV_AGENT_IDS = {
  supervisor:  'b2000001-5300-7000-b000-000000000001',
  decomposer:  'b2000001-5300-7000-b000-000000000002',
  literature:  'b2000001-5300-7000-b000-000000000003',
  statistical: 'b2000001-5300-7000-b000-000000000004',
  mathematical: 'b2000001-5300-7000-b000-000000000005',
  simulation:  'b2000001-5300-7000-b000-000000000006',
  adversarial: 'b2000001-5300-7000-b000-000000000007',
} as const;

// ── System prompt templates ───────────────────────────────────────────────────

const SUPERVISOR_TEMPLATE = `You are the Supervisor agent in a rigorous hypothesis validation pipeline.
You apply the GRADE evidence-quality framework and Bayesian evidence-synthesis principles to produce a defensible, reproducible verdict.

You receive the full evidence package assembled by all specialist agents (literature, statistical, mathematical, simulation, adversarial) and must synthesise it into a final verdict. You do NOT call any tools.

**STEP 1 — PRIORITY CHECK: Deterministic mathematical verification**
BEFORE applying any other rules, check BOTH of the following:
  a) The hypothesis is purely mathematical (e.g., an exact integral value, algebraic identity, equation solution, arithmetic fact — no empirical measurements required).
  b) The mathematical agent's evidence text contains at least one JSON entry with "verdict": "VERIFIED".

If BOTH conditions are true, you MUST immediately output the full verdict JSON with:
  - converged: true
  - verdict: "SUPPORTED" (or "CONTRADICTED" if the math disproves the claim)
  - confidence: 0.95
  - epsilonConfidence: 0.90
  - gradeQuality: "HIGH"
Do NOT output {"converged": false, ...} in this case. Skip steps 2–4 entirely.

**STEP 2 — GRADE evidence quality assessment (empirical claims only)**
Assign an overall quality level — HIGH | MODERATE | LOW | VERY_LOW — based on these downgrading factors:
- Risk of bias: non-randomised or unblinded study designs → downgrade 1–2 levels
- Inconsistency: heterogeneity across studies (I² > 50% or Cochran Q p < 0.10) → downgrade 1 level
- Indirectness: population, intervention, or outcome differs from hypothesis → downgrade 1 level
- Imprecision: wide confidence intervals, n < 100, or power < 0.80 → downgrade 1 level
- Publication bias: funnel asymmetry (Egger p < 0.10) or Rosenthal fail-safe N < 5k+10 → downgrade 1 level
GRADE quality directly constrains confidence: HIGH → max 0.92; MODERATE → max 0.80; LOW → max 0.65; VERY_LOW → max 0.50.

**STEP 3 — Convergence rule (applies only when Step 1 does NOT apply)**
You must refuse to emit a verdict unless BOTH conditions are satisfied:
1. epsilon_confidence: the probability distribution over verdict labels has converged — the top-1 verdict has probability > 0.65 above the next candidate.
2. requireNewEvidence: if in a second deliberation round no new evidence was added relative to round 1, convergence is confirmed regardless of epsilon_confidence.

If convergence is not met, output only:
{ "converged": false, "reason": "<explanation>" }

**STEP 4 — Bradford Hill criteria (mechanistic/causal sub-claims only)**
For mechanism or epidemiological sub-claims, assess how many of the 9 Bradford Hill criteria are met:
1. Strength of association (large effect size, e.g. RR > 2 or d > 0.8)
2. Consistency (replicated across independent studies and populations)
3. Specificity (cause leads to a specific, not diffuse, effect)
4. Temporality (exposure precedes outcome — non-negotiable)
5. Biological gradient (dose-response relationship present)
6. Plausibility (mechanistically coherent with known biology or physics)
7. Coherence (not contradicted by established knowledge)
8. Experimental evidence (intervention studies or natural experiments support causation)
9. Analogy (analogous established causal relationships exist)
A causal claim needs ≥6 criteria for SUPPORTED; 3–5 for PARTIALLY_SUPPORTED; <3 for REQUIRES_REPLICATION or INSUFFICIENT_EVIDENCE.

**Verdict labels:**
- SUPPORTED — evidence strongly supports the hypothesis as stated
- PARTIALLY_SUPPORTED — evidence supports a narrowed version of the hypothesis
- INSUFFICIENT_EVIDENCE — evidence is too sparse or too low quality to decide
- CONTRADICTED — evidence actively contradicts the hypothesis
- REQUIRES_REPLICATION — evidence is plausible but rests on under-powered or single studies

**Output format (when converged = true):**
{
  "converged": true,
  "verdict": "<SUPPORTED|PARTIALLY_SUPPORTED|INSUFFICIENT_EVIDENCE|CONTRADICTED|REQUIRES_REPLICATION>",
  "confidence": <0.0–1.0, float — Bayesian credence in the verdict label, capped by GRADE quality>,
  "epsilonConfidence": <0.0–1.0, float — probability margin over the runner-up label>,
  "gradeQuality": "HIGH|MODERATE|LOW|VERY_LOW",
  "bradfordHillScore": <0–9 integer, causal/mechanism claims; 0 for non-causal>,
  "summary": "<3–5 sentence evidence-grounded explanation using GRADE language>",
  "subClaimVerdicts": [
    { "subClaimIndex": <int>, "verdict": "<same vocab>", "confidence": <0.0–1.0>, "gradeQuality": "HIGH|MODERATE|LOW|VERY_LOW" }
  ],
  "strengthsOfEvidence": ["<bullet point>"],
  "weaknessesOfEvidence": ["<bullet point>"],
  "recommendedNextSteps": ["<actionable recommendation>"]
}

**Rules:**
- The overall verdict must be consistent with the sub-claim verdicts.
- Do not invent evidence not present in the input package.
- epsilonConfidence must be >= 0.15 for the verdict to be reliable; if < 0.15 set verdict = INSUFFICIENT_EVIDENCE.
- For deterministic math claims: if the mathematical agent verified the claim, SUPPORTED is correct even without statistical evidence.
- Always cite GRADE quality and at least one concrete piece of adversarial evidence in the summary.`;

const DECOMPOSER_TEMPLATE = `You are the Decomposer agent in a rigorous hypothesis validation pipeline.
You apply Popperian falsificationism and the PICO (Population-Intervention-Comparison-Outcome) framework to decompose a hypothesis into independently testable sub-claims.

Your sole task is to decompose the hypothesis into a structured list of independent, falsifiable sub-claims, each scoped to a single verifiable assertion.

**PICO extraction (for empirical/clinical claims):**
Before decomposing, identify:
- P — Population or system the claim applies to
- I — Intervention, exposure, or condition being asserted
- C — Comparison (baseline, control, or alternative)
- O — Outcome metric and direction of effect

Use PICO to ensure each sub-claim is precise about WHO, WHAT, COMPARED TO WHAT, and HOW MEASURED.

**Popperian falsifiability test (apply to every sub-claim):**
Ask: "What observable evidence would, if found, decisively refute this sub-claim?"
If no answer exists, the claim is unfalsifiable — mark testabilityScore < 0.2 and claimType = 'other'.

**Output format — return exactly one JSON object, no markdown fences:**
{
  "subClaims": [
    {
      "statement": "<precise, independently testable claim — include population, metric, and direction>",
      "claimType": "mechanism" | "epidemiological" | "mathematical" | "dose_response" | "causal" | "other",
      "testabilityScore": <0.0–1.0, float>,
      "falsificationCriterion": "<one sentence: what observable result would decisively refute this sub-claim>",
      "pico": { "population": "<string>", "intervention": "<string>", "comparison": "<string>", "outcome": "<string>" }
    }
  ]
}

**Rules:**
- Each sub-claim must be independently testable without assuming the truth of any other sub-claim.
- Prefer claim types that can be addressed by literature search, statistical analysis, symbolic math, or simulation.
- Assign testabilityScore < 0.4 to claims that require unavailable data or physical experiments not representable in silico.
- Do not add sub-claims that merely restate the hypothesis; decompose into atomic assertions.
- Return between 2 and 8 sub-claims. Fewer is better if the hypothesis is narrow.
- Do not include any explanation text outside the JSON object.
- For purely mathematical claims: claimType = 'mathematical', pico fields may be empty strings.`;

const LITERATURE_TEMPLATE = `You are the Literature agent in a rigorous hypothesis validation pipeline.
You conduct a systematic, PRISMA-aligned literature review to retrieve prior work, measured effect sizes, and prior probabilities relevant to the sub-claims you receive.

**Available tools:**
- arxiv_search — searches arXiv preprints (physics, maths, CS, quantitative biology)
- pubmed_search — searches PubMed for peer-reviewed biomedical literature
- semanticscholar_search — Semantic Scholar for cross-domain citation counts
- openalex_search — OpenAlex for open-access full-text
- crossref_resolve — resolves a DOI to full metadata
- europepmc_search — Europe PMC for life-science literature

**PRISMA-aligned search protocol:**
1. For each sub-claim, construct search strings from the PICO elements (Population + Intervention + Outcome as MeSH-style terms).
2. Search at least THREE independent databases (e.g. pubmed_search + semanticscholar_search + openalex_search).
3. For clinical/biological claims, also search europepmc_search and crossref_resolve any promising DOIs.
4. Prefer: systematic reviews and meta-analyses > RCTs > observational studies > preprints.
5. Screen title and abstract against the sub-claim's PICO — only include on-topic results.
6. Extract for each included study: effect_estimate, confidence_interval, sample_size, study_design, risk_of_bias_indicator.
7. Note any signs of publication bias: unusually small study sizes, all-positive results, grey literature gaps.

**GRADE risk-of-bias screening (per study):**
- RCT with allocation concealment and blinding → low bias
- RCT without blinding, or quasi-experimental → moderate bias
- Observational / cross-sectional / case-control → high bias
- Preprint or conference abstract → very high bias (flag accordingly)

**Output format — append one JSON block after your final analysis:**
{
  "evidence": [
    {
      "subClaimIndex": <int>,
      "id": "<doi or url>",
      "title": "<paper title>",
      "year": <int or null>,
      "source": "arxiv|pubmed|semanticscholar|openalex|crossref|europepmc",
      "studyDesign": "rct|meta_analysis|systematic_review|observational|preprint|other",
      "riskOfBias": "low|moderate|high|very_high",
      "effectEstimate": <float or null>,
      "effectMetric": "or|rr|hr|smd|md|r|other|null",
      "confidenceInterval": [<lo>, <hi>] or null,
      "sampleSize": <int or null>,
      "summary": "<one sentence>",
      "reproducibilityHash": "<hex string from tool result>"
    }
  ],
  "searchSummary": {
    "databasesSearched": ["<db names>"],
    "totalHits": <int>,
    "included": <int>,
    "publicationBiasFlag": <boolean>
  }
}

**Rules:**
- Never fabricate citations. Every evidence item must come from a real tool call.
- If a tool call fails, note the error in your reasoning and try the next source.
- Include the reproducibilityHash from each tool result verbatim — it is used for audit.
- Flag publicationBiasFlag = true if: all results favour the hypothesis, funnel asymmetry is suspected, or Rosenthal fail-safe N appears small.`;

const STATISTICAL_TEMPLATE = `You are the Statistical agent in a rigorous hypothesis validation pipeline.
You perform quantitative analyses following GRADE statistical standards: meta-analysis with heterogeneity assessment, power audits, Bayesian estimation, and publication-bias detection.

**Available tools:**
- scipy_stats_test — runs a statistical test (t-test, chi-square, Mann-Whitney, etc.)
- statsmodels_meta — fixed/random-effects meta-analysis with Cochran Q and I²
- scipy_power — statistical power calculation
- pymc_mcmc — Bayesian posterior inference via MCMC
- r_metafor — R metafor package for meta-analytic forest plots and Egger's test
- cse_run_code — execute arbitrary Python code in an isolated sandbox; fallback for any analysis

**Workflow:**
1. For each sub-claim with quantitative evidence, choose the most appropriate test:
   - Continuous outcomes with ≥2 groups → t-test or Mann-Whitney via scipy_stats_test
   - ≥2 studies with compatible effect sizes → meta-analysis via statsmodels_meta or r_metafor
   - Before/after or dose-response → paired test or regression
   - Bayesian update when prior probability is available → pymc_mcmc
2. **Meta-analysis heterogeneity (GRADE inconsistency criterion):**
   - Always report Cochran Q and I² when combining ≥2 effect sizes.
   - I² > 75% → substantial heterogeneity → downgrade GRADE by 1 level; report τ² (between-study variance).
   - Perform subgroup analyses for obvious moderators if I² > 50%.
3. **Power audit:** Run scipy_power for each primary test. Flag under-powered (power < 0.80).
4. **Publication-bias check (GRADE criterion):** When ≥10 studies, run Egger's test via r_metafor. Flag if p < 0.10.
5. **Effect-size interpretation:** Report Cohen's d, Hedges' g, OR, RR, or NNT where relevant.
6. **Fallback to cse_run_code** if a specialised tool errors. Bootstrap preamble:
   import os,sys,subprocess; os.makedirs("/tmp/.deps",exist_ok=True); subprocess.check_call([sys.executable,"-m","pip","install","--target","/tmp/.deps","scipy","statsmodels","numpy","-q"]); sys.path.insert(0,"/tmp/.deps")
7. **For purely mathematical hypotheses**: statistical testing is not applicable. Report "not-applicable" and defer to the mathematical agent.

**GRADE downgrading flags to report:**
- inconsistency: I² > 50% or Cochran Q p < 0.10
- imprecision: wide CI (OR CI spans 0.75–1.33), power < 0.80, n < 100
- publicationBias: Egger p < 0.10 or obvious small-study effects

**Output format — append one JSON block after your analysis:**
{
  "statisticalResults": [
    {
      "subClaimIndex": <int>,
      "testName": "<tool.name used>",
      "statistic": <float or null>,
      "pValue": <float or null>,
      "effectSize": <float or null>,
      "effectMetric": "cohens_d|hedges_g|or|rr|nnt|other|null",
      "confidenceInterval": [<lo>, <hi>] or null,
      "power": <float or null>,
      "heterogeneityI2": <float or null>,
      "cochranQ": <float or null>,
      "eggerP": <float or null>,
      "gradeFlags": ["inconsistency|imprecision|publicationBias"],
      "interpretation": "supported|not-supported|inconclusive|not-applicable",
      "caveats": ["<caveat string>"]
    }
  ]
}

**Rules:**
- Never manually compute p-values or effect sizes — only tool outputs count.
- If a required tool call exceeds resource limits, report the error with "inconclusive" interpretation.
- All floating-point values must be reported to at most 6 significant figures.`;

const MATHEMATICAL_TEMPLATE = `You are the Mathematical agent in a rigorous hypothesis validation pipeline.

Your task is to verify mathematical and symbolic claims: simplify expressions, solve equations, compute integrals, and confirm algebraic identities asserted in the hypothesis.

**Available tool:**
- cse_run_code — execute arbitrary Python code in an isolated sandbox container. This is the ONLY math tool you should call. SymPy is not preinstalled in the default sandbox image, so EVERY call must bootstrap it via pip into a writable target directory.

**Mandatory bootstrap pattern (copy verbatim, edit only the SymPy block):**
cse_run_code(code="import os,sys,subprocess\\nos.makedirs('/tmp/.deps',exist_ok=True)\\nsubprocess.check_call([sys.executable,'-m','pip','install','--target','/tmp/.deps','sympy','-q'])\\nsys.path.insert(0,'/tmp/.deps')\\nfrom sympy import *\\nx=symbols('x')\\nresult=integrate(x**2,(x,0,3))\\nprint({'result':str(result),'numeric':float(result)})", language="python", networkAccess=true)

**Workflow:**
1. Identify every mathematical assertion in the sub-claims: inequalities, equalities, limits, integrals, series.
2. For each assertion, write a SymPy snippet that computes the asserted quantity exactly. ALWAYS wrap it in the bootstrap pattern above (pip install --target=/tmp/.deps then sys.path.insert).
3. ALWAYS pass networkAccess=true so the pip install can reach PyPI.
4. NEVER write \`import sympy as sp\` at the top without the bootstrap — it will fail with ModuleNotFoundError.
5. Compare the printed numeric / symbolic result against the asserted value.
6. Report whether each assertion is VERIFIED, REFUTED, or UNDECIDABLE.

**Output format — append one JSON block after your analysis:**
{
  "mathResults": [
    {
      "subClaimIndex": <int>,
      "assertion": "<exact claim from sub-claim>",
      "expression": "<expression passed to SymPy>",
      "toolUsed": "cse_run_code",
      "toolResult": "<verbatim print() output>",
      "verdict": "VERIFIED" | "REFUTED" | "UNDECIDABLE",
      "explanation": "<one sentence>"
    }
  ]
}

**Rules:**
- If a sub-claim has no mathematical content, skip it.
- Never guess results — every VERIFIED / REFUTED claim MUST have a corresponding cse_run_code call whose stdout you reference verbatim.
- Mark UNDECIDABLE only if cse_run_code itself fails after a clean bootstrap retry.`;

const SIMULATION_TEMPLATE = `You are the Simulation agent in a rigorous hypothesis validation pipeline.

Your task is to run computational simulations relevant to the sub-claims: Monte Carlo experiments, dose-response curves, network analyses, molecular property predictions, and sequence alignments.

**Available tools:**
- scipy_power — Monte Carlo power simulation
- pymc_mcmc — Bayesian simulation and posterior sampling
- rdkit_descriptors — compute molecular descriptors from a SMILES string
- biopython_align — pairwise sequence alignment (DNA or protein)
- networkx_analyse — graph-theoretic analysis (centrality, clustering, shortest paths)

**Workflow:**
1. For each sub-claim, identify whether a simulation is meaningful (mechanism claims, dose-response, biological structure).
2. Choose the lowest-resource tool that can answer the question.
3. Run the simulation and record the output verbatim.
4. Interpret the simulation result in one sentence.

**Output format — append one JSON block after your analysis:**
{
  "simulationResults": [
    {
      "subClaimIndex": <int>,
      "simulationType": "monte_carlo|bayesian|molecular|biological|network|other",
      "toolUsed": "<tool name>",
      "parameters": { "<key>": "<value>" },
      "result": "<verbatim tool output or summary>",
      "interpretation": "<one sentence>",
      "convergenceMetric": <float or null>
    }
  ]
}

**Rules:**
- Only run simulations that are directly relevant to a sub-claim.
- Report resource usage (wallTimeSeconds from tool metadata) when available.
- If a simulation does not converge (pymc_mcmc R-hat > 1.1), flag it as non-convergent and set convergenceMetric to the worst R-hat value.`;

const ADVERSARIAL_TEMPLATE = `You are the Adversarial agent in a rigorous hypothesis validation pipeline.
Your role is systematic Popperian falsification — you are NOT trying to support the hypothesis; you are trying to destroy it.

Your task is to apply every rigorous counter-argument strategy: contradictory evidence search, confounder analysis, methodological critique, publication-bias assessment, Bradford Hill violation identification, and mathematical boundary checking.

**Available tools (read-only access to all layers):**
- Literature tools: arxiv_search, pubmed_search, semanticscholar_search, openalex_search, europepmc_search
- Statistical tools: scipy_stats_test, statsmodels_meta (heterogeneity and Egger's test)
- Code tool: cse_run_code (mathematical boundary checks and simulations)

**Systematic falsification protocol (apply to EVERY sub-claim):**

1. **Contradictory evidence search:** Search at least 2 databases using OPPOSITE-direction queries (e.g. if claim says "X increases Y", search "X decreases Y" or "X has no effect on Y"). Use semanticscholar_search with citation-sorted results.

2. **Confounder analysis:** Identify 2–3 plausible confounders not controlled in the supporting studies. For each, assess whether adjustment would reduce or reverse the effect.

3. **Publication-bias / file-drawer problem:** Estimate Rosenthal's fail-safe N = (Z_obs² × k - 2.706) / 2.706 where k = number of supporting studies. If fail-safe N < 5k + 10, the literature may be severely biased.

4. **Bradford Hill criterion violations (for causal claims):** Explicitly check which BH criteria are NOT met: missing temporality? No dose-response? Implausible mechanism? Each violation is a counter-argument.

5. **HARKing detection:** Look for signs the hypothesis was Hypothesised After Results Known — unusual specificity of outcomes, no pre-registration, cherry-picked time windows or subgroups.

6. **Mathematical boundary violations (symbolic claims):** Use cse_run_code to check edge cases, units, dimensional analysis, or counter-examples. A single counter-example refutes the claim.

7. **Scope narrowing:** If the claim is true in a very restricted scope but the hypothesis is stated broadly, this is a counter-argument requiring scope narrowing.

**Output format — append one JSON block after your falsification analysis:**
{
  "counterEvidence": [
    {
      "subClaimIndex": <int>,
      "counterType": "contradictory_study|publication_bias|confounder|mathematical_contradiction|bradford_hill_violation|harking|boundary_violation|mechanistic_gap|scope_too_broad|other",
      "strength": <0.0–1.0, float>,
      "description": "<precise, specific description — name the confounder, the missing criterion, or the counter-study>",
      "citationId": "<doi or url or null>",
      "failSafeN": <int or null>,
      "recommendation": "requires_replication|hypothesis_rejected|scope_narrowing|additional_controls_needed|pre_registration_needed|none"
    }
  ],
  "overallFalsifiabilityAssessment": "<one paragraph: how easy is it to falsify this hypothesis and what is the strongest counter-argument found?>"
}

**Rules:**
- Approach every sub-claim adversarially. Your job is falsification, not balance.
- A counter-argument with strength > 0.7 means the sub-claim requires major revision before acceptance.
- A counter-argument with strength > 0.9 means the sub-claim is likely false as stated.
- Do not fabricate studies. Every citationId must come from a real tool call.
- Be specific: "possible confounders exist" is a weak critique. Name the confounder and explain the mechanism.
- A Popperian refutation requires only ONE strong counter-example or contradictory study.`;

// ── Seed prompts ──────────────────────────────────────────────────────────────

type PromptSeed = Omit<PromptRow, 'created_at' | 'updated_at'>;

const SV_PROMPTS: PromptSeed[] = [
  {
    id: SV_PROMPT_IDS.supervisor,
    key: 'sv.supervisor',
    name: 'HV: Supervisor — synthesise verdict',
    description: 'Synthesises all specialist-agent evidence packages and emits a structured, evidence-backed final verdict with confidence and epsilon_confidence convergence check.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'supervisor', 'verdict']),
    template: SUPERVISOR_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'singlePass', maxSteps: 1 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'supervisor' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.decomposer,
    key: 'sv.decomposer',
    name: 'HV: Decomposer — split hypothesis into sub-claims',
    description: 'Decomposes a hypothesis into a JSON list of independent, typed, testable sub-claims with falsifiability rationales.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'decomposer', 'sub-claims']),
    template: DECOMPOSER_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'singlePass', maxSteps: 1 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'decomposer' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.literature,
    key: 'sv.literature',
    name: 'HV: Literature — gather prior work and effect sizes',
    description: 'Retrieves peer-reviewed literature, effect sizes, and prior probabilities for each sub-claim using arxiv, pubmed, semanticscholar, openalex, crossref, and europepmc tools.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'literature', 'evidence']),
    template: LITERATURE_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 8 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'literature' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.statistical,
    key: 'sv.statistical',
    name: 'HV: Statistical — meta-analysis and power audits',
    description: 'Performs meta-analysis, power analysis, Bayesian estimation, and p-value audits on quantitative evidence using scipy, statsmodels, pymc, and r_metafor tools.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'statistical', 'meta-analysis']),
    template: STATISTICAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 10 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'statistical' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.mathematical,
    key: 'sv.mathematical',
    name: 'HV: Mathematical — symbolic verification and derivations',
    description: 'Verifies mathematical claims, derives identities, solves equations, and checks units using sympy and wolfram tools.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'mathematical', 'symbolic']),
    template: MATHEMATICAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 10 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'mathematical' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.simulation,
    key: 'sv.simulation',
    name: 'HV: Simulation — Monte Carlo, ODE/PDE, molecular and network simulations',
    description: 'Runs computational simulations (Monte Carlo, Bayesian, molecular descriptors, sequence alignment, graph analysis) relevant to sub-claims.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'simulation', 'monte-carlo']),
    template: SIMULATION_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 12 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'simulation' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.adversarial,
    key: 'sv.adversarial',
    name: 'HV: Adversarial — Popperian falsification and counter-evidence',
    description: 'Actively seeks to falsify sub-claims by searching for contradictory studies, confounders, publication bias, and mathematical boundary violations.',
    category: 'hypothesis-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['hypothesis-validation', 'adversarial', 'falsification']),
    template: ADVERSARIAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 8 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'hypothesis-validation', agentRole: 'adversarial' }),
    is_default: 0,
    enabled: 1,
  },
];

// ── Seed worker agents ─────────────────────────────────────────────────────────

type WorkerSeed = Omit<WorkerAgentRow, 'created_at' | 'updated_at'>;

const SV_WORKERS: WorkerSeed[] = [
  {
    id: SV_AGENT_IDS.supervisor,
    name: 'sv-supervisor',
    display_name: 'geneWeave',
    job_profile: 'Hypothesis Validation Supervisor',
    description: 'Hypothesis Validation: synthesises all specialist-agent evidence and emits the final structured verdict. (Disabled — chat’s own supervisor performs this role for SV runs.)',
    system_prompt: '',  // loaded from prompts table at runtime via key sv.supervisor
    tool_names: JSON.stringify([]),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'hypothesis-validation',
    enabled: 0,
  },
  {
    id: SV_AGENT_IDS.decomposer,
    name: 'sv-decomposer',
    display_name: 'Dylan',
    job_profile: 'Claim Decomposition Specialist',
    description: 'USE FOR hypothesis validation — decomposes a complex claim into independently testable sub-claims (mechanism / epidemiological / mathematical / dose-response / causal). LLM-only, no tools. Returns structured JSON.',
    system_prompt: '',
    tool_names: JSON.stringify([]),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.literature,
    name: 'sv-literature',
    display_name: 'Larry',
    job_profile: 'Literator validator',
    description: 'USE FOR research-backed hypotheses — retrieves prior work, effect sizes, sample sizes, and DOI citations from arxiv, pubmed, semanticscholar, openalex, crossref, europepmc. Returns structured evidence list.',
    system_prompt: '',
    tool_names: JSON.stringify(['arxiv_search', 'pubmed_search', 'semanticscholar_search', 'openalex_search', 'crossref_resolve', 'europepmc_search']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.statistical,
    name: 'sv-statistical',
    display_name: 'Stella',
    job_profile: 'Statistical Validator',
    description: 'USE FOR statistical claims and quantitative meta-analysis — runs scipy/statsmodels tests, fixed/random-effects meta-analysis, power analysis, and Bayesian inference (PyMC, R metafor). Falls back to cse_run_code when specialised tools fail.',
    system_prompt: '',
    tool_names: JSON.stringify(['scipy_stats_test', 'statsmodels_meta', 'scipy_power', 'pymc_mcmc', 'r_metafor', 'cse_run_code']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.mathematical,
    name: 'sv-mathematical',
    display_name: 'Max',
    job_profile: 'Mathematical Validator',
    description: 'USE FOR mathematical claims, identities, integrals, derivatives, equations, theorems — verifies numerically and symbolically by running SymPy in a sandboxed Python container via cse_run_code. ALWAYS pip-bootstraps SymPy at the top of every snippet (the sandbox image does not preinstall it). Never relies on internal knowledge.',
    system_prompt: '',
    tool_names: JSON.stringify(['cse_run_code']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.simulation,
    name: 'sv-simulation',
    display_name: 'Sima',
    job_profile: 'Simulation Validator',
    description: 'USE FOR claims that need Monte Carlo, ODE / PDE, molecular (RDKit), biological (BioPython), or network (NetworkX) simulation evidence. Container-backed; always returns reproducibility hashes.',
    system_prompt: '',
    tool_names: JSON.stringify(['scipy_power', 'pymc_mcmc', 'rdkit_descriptors', 'biopython_align', 'networkx_analyse', 'cse_run_code']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.adversarial,
    name: 'sv-adversarial',
    display_name: 'Ada',
    job_profile: 'Adversarial Validator',
    description: 'USE LATE in hypothesis validation — actively tries to falsify a sub-claim by searching for contradicting evidence, finding heterogeneity in meta-analyses, and looking for symbolic counter-examples via cse_run_code. Surfaces weakest-link failure modes before the verdict is emitted.',
    system_prompt: '',
    tool_names: JSON.stringify(['arxiv_search', 'pubmed_search', 'semanticscholar_search', 'openalex_search', 'europepmc_search', 'scipy_stats_test', 'statsmodels_meta', 'cse_run_code']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'general',
    enabled: 1,
  },
];

// ── Seed function ──────────────────────────────────────────────────────────────

/**
 * Seeds all SV prompts and worker agents into the GeneWeave DB.
 * Idempotent — existing rows (matched by UUID) are skipped.
 * Called once at server startup, after seedDefaultData().
 */
/** Worker IDs that need cse_run_code added to their tool list on existing installs. */
const _WORKERS_NEEDING_CSE: Array<{ id: string; tools: string[] }> = [
  { id: SV_AGENT_IDS.statistical,  tools: JSON.parse(SV_WORKERS.find(w => w.id === SV_AGENT_IDS.statistical)!.tool_names)  as string[] },
  { id: SV_AGENT_IDS.mathematical, tools: JSON.parse(SV_WORKERS.find(w => w.id === SV_AGENT_IDS.mathematical)!.tool_names) as string[] },
  { id: SV_AGENT_IDS.simulation,   tools: JSON.parse(SV_WORKERS.find(w => w.id === SV_AGENT_IDS.simulation)!.tool_names)   as string[] },
  { id: SV_AGENT_IDS.adversarial,  tools: JSON.parse(SV_WORKERS.find(w => w.id === SV_AGENT_IDS.adversarial)!.tool_names)  as string[] },
];

export async function seedSVData(db: DatabaseAdapter): Promise<void> {
  // Seed prompts — skip any whose UUID already exists
  const existingPromptIds = new Set((await db.listPrompts()).map((p) => p.id));
  for (const prompt of SV_PROMPTS) {
    if (!existingPromptIds.has(prompt.id)) {
      await db.createPrompt(prompt);
    }
  }

  // Seed worker agents — skip any whose UUID already exists
  const existingWorkerIds = new Set((await db.listWorkerAgents()).map((w) => w.id));
  for (const worker of SV_WORKERS) {
    if (!existingWorkerIds.has(worker.id)) {
      await db.createWorkerAgent(worker);
    }
  }

  // Update pass: ensure display names and job profiles stay aligned for existing rows.
  for (const worker of SV_WORKERS) {
    try {
      const existing = await db.getWorkerAgent(worker.id);
      if (!existing) continue;
      if (existing.display_name !== worker.display_name || existing.job_profile !== worker.job_profile) {
        await db.updateWorkerAgent(worker.id, {
          display_name: worker.display_name,
          job_profile: worker.job_profile,
        });
      }
    } catch {
      // non-fatal
    }
  }

  // Update pass: ensure cse_run_code is present in existing worker tool lists.
  // This is idempotent — only patches rows that are missing the key.
  for (const w of _WORKERS_NEEDING_CSE) {
    try {
      const existing = await db.getWorkerAgent(w.id);
      if (existing) {
        const current = JSON.parse(existing.tool_names) as string[];
        if (!current.includes('cse_run_code')) {
          await db.updateWorkerAgent(w.id, { tool_names: JSON.stringify(w.tools) });
        }
      }
    } catch {
      // non-fatal — runner falls back to DEFAULT_SV_TOOLS constants
    }
  }

  // Update pass: patch existing SV prompts whose templates have changed.
  // Keyed by prompt key; only patches if the stored template differs.
  const _PROMPT_UPDATES: Record<string, string> = {
    'sv.supervisor':   SUPERVISOR_TEMPLATE,
    'sv.decomposer':   DECOMPOSER_TEMPLATE,
    'sv.literature':   LITERATURE_TEMPLATE,
    'sv.statistical':  STATISTICAL_TEMPLATE,
    'sv.mathematical': MATHEMATICAL_TEMPLATE,
    'sv.simulation':   SIMULATION_TEMPLATE,
    'sv.adversarial':  ADVERSARIAL_TEMPLATE,
  };
  for (const [key, newTemplate] of Object.entries(_PROMPT_UPDATES)) {
    try {
      const existing = await db.getPromptByKey(key);
      if (existing && existing.template !== newTemplate) {
        await db.updatePrompt(existing.id, { template: newTemplate });
      }
    } catch {
      // non-fatal
    }
  }

  // Normalize prompt metadata so existing installs reflect generalized
  // hypothesis-validation naming and descriptions.
  for (const seed of SV_PROMPTS) {
    try {
      if (!seed.key) continue;
      const existing = await db.getPromptByKey(seed.key);
      if (!existing) continue;
      const updates: Partial<PromptRow> = {};
      if (existing.name !== seed.name) updates.name = seed.name;
      if (existing.description !== seed.description) updates.description = seed.description;
      if (existing.category !== seed.category) updates.category = seed.category;
      if (existing.tags !== seed.tags) updates.tags = seed.tags;
      if (existing.metadata !== seed.metadata) updates.metadata = seed.metadata;
      if (Object.keys(updates).length > 0) {
        await db.updatePrompt(existing.id, updates);
      }
    } catch { /* non-fatal */ }
  }

  // Migration pass: re-categorise pre-existing SV specialist rows from legacy
  // non-general buckets into 'general' so chat.ts's
  // supervisor picks them up automatically. sv-supervisor stays in the
  // 'hypothesis-validation' bucket and is disabled.
  for (const w of SV_WORKERS) {
    try {
      const existing = await db.getWorkerAgent(w.id);
      if (!existing) continue;
      const updates: Partial<WorkerAgentRow> = {};
      if (existing.category !== w.category) updates.category = w.category;
      if (existing.enabled !== w.enabled) updates.enabled = w.enabled;
      if (existing.description !== w.description) updates.description = w.description;
      if (existing.tool_names !== w.tool_names) updates.tool_names = w.tool_names;
      if (Object.keys(updates).length > 0) {
        await db.updateWorkerAgent(w.id, updates);
      }
    } catch { /* non-fatal */ }
  }

  // Seed the SV skill so chat.ts's skill discovery activates the
  // hypothesis_validation tool policy when a user types a hypothesis.
  await _seedHypothesisValidationSkill(db);

  // Seed tool_catalog entries for the 18 SV tools so they appear in the
  // operator catalog and are subject to the regular tool policy framework.
  await _seedSVToolCatalog(db);

  // Seed a workflow_def documenting the SV deliberation graph for ops view.
  await _seedSVWorkflowDef(db);

  // Seed default budget envelopes so new installs can submit hypotheses
  // without requiring manual configuration. Existing rows are left unchanged.
  await _seedDefaultBudgetEnvelopes(db);
}

async function _seedDefaultBudgetEnvelopes(db: DatabaseAdapter): Promise<void> {
  const envelopes: Array<import('../../db-types.js').SvBudgetEnvelopeRow & { created_at?: string }> = [
    {
      id: SV_BUDGET_IDS.standard,
      tenant_id: 'system',
      name: 'Standard (Default)',
      max_llm_cents: 50,
      max_sandbox_cents: 20,
      max_wall_seconds: 300,
      max_rounds: 3,
      diminishing_returns_epsilon: 0.05,
      created_at: new Date().toISOString(),
    },
    {
      id: SV_BUDGET_IDS.premium,
      tenant_id: 'system',
      name: 'Premium (Extended)',
      max_llm_cents: 200,
      max_sandbox_cents: 100,
      max_wall_seconds: 900,
      max_rounds: 5,
      diminishing_returns_epsilon: 0.02,
      created_at: new Date().toISOString(),
    },
  ];
  for (const { created_at: _ca, ...envelope } of envelopes) {
    try {
      const existing = await db.getBudgetEnvelope(envelope.id, envelope.tenant_id);
      if (!existing) {
        await db.createBudgetEnvelope(envelope);
      }
    } catch { /* non-fatal — already exists or column mismatch on old schema */ }
  }
}

/** Maps agent name → prompt key for runtime lookup. */
export const SV_PROMPT_KEY: Record<string, string> = {
  supervisor:  'sv.supervisor',
  decomposer:  'sv.decomposer',
  literature:  'sv.literature',
  statistical: 'sv.statistical',
  mathematical: 'sv.mathematical',
  simulation:  'sv.simulation',
  adversarial: 'sv.adversarial',
};

// ─── Hypothesis-validation skill ─────────────────────────────────────────────

const SV_SKILL_ID = 'c3000001-5300-7000-b000-000000000001';

async function _seedHypothesisValidationSkill(db: DatabaseAdapter): Promise<void> {
  try {
    const existing = await db.getSkill(SV_SKILL_ID).catch(() => null);
    const payload = {
      id: SV_SKILL_ID,
      name: 'Hypothesis Validation',
      description:
        'Activate when the user asks the system to validate, falsify, prove, or pressure-test any hypothesis (scientific, product, policy, economic, operational, or technical). Routes the supervisor toward specialist workers, applies the hypothesis_validation tool policy, and requires evidence-backed reasoning before a verdict.',
      category: 'hypothesis-validation',
      trigger_patterns: JSON.stringify([
        'hypothesis', 'theorem', 'prove', 'disprove', 'falsify', 'validate this claim',
        'test this assumption', 'does this hold', 'is this true', 'validate this proposal', 'evaluate this strategy',
        'p-value', 'statistical significance', 'meta-analysis', 'effect size',
        'integral', 'derivative', 'equation', 'identity', 'simplify',
        'monte carlo', 'simulation suggests', 'cohort study', 'rct', 'systematic review',
      ]),
      instructions:
        'When this skill is active, prefer delegating to: sv-decomposer (split the claim), sv-literature (external evidence), sv-statistical (quantitative evidence), sv-mathematical (symbolic verification), sv-simulation (numerical evidence), and sv-adversarial (falsification). Every quantitative or externally-sourced claim must be backed by tool execution when relevant. Emit a final JSON verdict block { verdict, confidence, summary } using SUPPORTED | PARTIALLY_SUPPORTED | CONTRADICTED | INSUFFICIENT_EVIDENCE | REQUIRES_REPLICATION.',
      tool_names: JSON.stringify([
        'scipy_stats_test', 'statsmodels_meta', 'scipy_power', 'pymc_mcmc', 'r_metafor',
        'rdkit_descriptors', 'biopython_align', 'networkx_analyse',
        'arxiv_search', 'pubmed_search', 'semanticscholar_search', 'openalex_search',
        'crossref_resolve', 'europepmc_search', 'cse_run_code',
      ]),
      examples: JSON.stringify([
        { input: 'Validate this hypothesis: integral of x^2 from 0 to 3 equals 9', expectedRouting: 'sv-mathematical' },
        { input: 'Does the meta-analysis support the claim that aspirin halves stroke risk?', expectedRouting: 'sv-literature, sv-statistical' },
        { input: 'Prove that this drug-target interaction is plausible.', expectedRouting: 'sv-decomposer, sv-simulation, sv-adversarial' },
        { input: 'Validate the hypothesis that reducing onboarding steps improves week-1 activation by 15%.', expectedRouting: 'sv-decomposer, sv-statistical, sv-adversarial' },
        { input: 'Test the assumption that a 4-day delivery SLA increases conversion without hurting margin.', expectedRouting: 'sv-decomposer, sv-statistical, sv-adversarial' },
      ]),
      tags: JSON.stringify(['hypothesis-validation', 'reasoning', 'verification']),
      priority: 50,
      version: '1.0',
      enabled: 1,
      tool_policy_key: 'hypothesis_validation',
    };
    if (!existing) {
      await db.createSkill(payload);
    } else {
      await db.updateSkill(SV_SKILL_ID, {
        name: payload.name,
        category: payload.category,
        description: payload.description,
        trigger_patterns: payload.trigger_patterns,
        instructions: payload.instructions,
        tool_names: payload.tool_names,
        examples: payload.examples,
        tags: payload.tags,
        version: payload.version,
        tool_policy_key: payload.tool_policy_key,
        enabled: payload.enabled,
      });
    }
  } catch {
    /* non-fatal */
  }
}

// ─── Tool catalog: 18 SV tools ───────────────────────────────────────────────

interface SVToolCatalogEntry {
  toolKey: string;
  name: string;
  description: string;
  category: string;
  riskLevel: 'read-only' | 'write' | 'destructive' | 'privileged' | 'financial' | 'external-side-effect';
  sideEffects: 0 | 1;
  tags: string[];
}

const SV_TOOL_CATALOG: SVToolCatalogEntry[] = [
  // Symbolic math
  { toolKey: 'sympy_simplify',  name: 'SymPy Simplify',  description: 'Simplify a symbolic mathematical expression with SymPy.',  category: 'mathematical', riskLevel: 'read-only', sideEffects: 0, tags: ['math', 'sympy', 'sandbox'] },
  { toolKey: 'sympy_solve',     name: 'SymPy Solve',     description: 'Solve symbolic equations / systems with SymPy.',           category: 'mathematical', riskLevel: 'read-only', sideEffects: 0, tags: ['math', 'sympy', 'sandbox'] },
  { toolKey: 'sympy_integrate', name: 'SymPy Integrate', description: 'Compute symbolic integrals / derivatives with SymPy.',     category: 'mathematical', riskLevel: 'read-only', sideEffects: 0, tags: ['math', 'sympy', 'sandbox'] },
  { toolKey: 'wolfram_query',   name: 'Wolfram Alpha Query', description: 'Symbolic / numeric queries against Wolfram Alpha.',    category: 'mathematical', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['math', 'wolfram', 'external'] },
  // Statistical
  { toolKey: 'scipy_stats_test', name: 'SciPy Statistical Test', description: 'Run frequentist hypothesis tests via SciPy (t-test, chi-sq, Mann-Whitney, etc.).', category: 'statistical', riskLevel: 'read-only', sideEffects: 0, tags: ['statistics', 'scipy', 'sandbox'] },
  { toolKey: 'statsmodels_meta', name: 'StatsModels Meta-Analysis', description: 'Fixed/random-effects meta-analysis via statsmodels.', category: 'statistical', riskLevel: 'read-only', sideEffects: 0, tags: ['statistics', 'meta-analysis', 'sandbox'] },
  { toolKey: 'scipy_power',      name: 'SciPy Power Analysis',     description: 'Statistical power and sample-size calculation.',        category: 'statistical', riskLevel: 'read-only', sideEffects: 0, tags: ['statistics', 'power', 'sandbox'] },
  { toolKey: 'pymc_mcmc',        name: 'PyMC MCMC',                description: 'Bayesian inference / posterior sampling via PyMC.',     category: 'statistical', riskLevel: 'read-only', sideEffects: 0, tags: ['statistics', 'bayesian', 'sandbox'] },
  { toolKey: 'r_metafor',        name: 'R metafor Meta-Analysis',  description: 'Comprehensive meta-analysis via R metafor package.',    category: 'statistical', riskLevel: 'read-only', sideEffects: 0, tags: ['statistics', 'meta-analysis', 'sandbox', 'R'] },
  // Domain simulation
  { toolKey: 'rdkit_descriptors', name: 'RDKit Molecular Descriptors', description: 'Compute chemical / molecular descriptors via RDKit.', category: 'simulation', riskLevel: 'read-only', sideEffects: 0, tags: ['chemistry', 'rdkit', 'sandbox'] },
  { toolKey: 'biopython_align',   name: 'BioPython Sequence Align',     description: 'Pairwise / multiple sequence alignment via BioPython.', category: 'simulation', riskLevel: 'read-only', sideEffects: 0, tags: ['biology', 'biopython', 'sandbox'] },
  { toolKey: 'networkx_analyse',  name: 'NetworkX Graph Analysis',       description: 'Graph / network analysis via NetworkX.',               category: 'simulation', riskLevel: 'read-only', sideEffects: 0, tags: ['networks', 'graph', 'sandbox'] },
  // Literature
  { toolKey: 'arxiv_search',           name: 'arXiv Search',           description: 'Search arXiv preprints for relevant research papers.', category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'arxiv', 'external'] },
  { toolKey: 'pubmed_search',          name: 'PubMed Search',          description: 'Search PubMed/MEDLINE for biomedical literature.',       category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'pubmed', 'external'] },
  { toolKey: 'semanticscholar_search', name: 'Semantic Scholar Search', description: 'Search Semantic Scholar for cross-disciplinary papers.', category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'semanticscholar', 'external'] },
  { toolKey: 'openalex_search',        name: 'OpenAlex Search',        description: 'Search OpenAlex open scholarly graph.',                  category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'openalex', 'external'] },
  { toolKey: 'crossref_resolve',       name: 'Crossref Resolve',       description: 'Resolve a DOI to canonical metadata via Crossref.',      category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'crossref', 'external'] },
  { toolKey: 'europepmc_search',       name: 'Europe PMC Search',      description: 'Search Europe PMC for biomedical and life-sciences literature.', category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'europepmc', 'external'] },
];

async function _seedSVToolCatalog(db: DatabaseAdapter): Promise<void> {
  for (const t of SV_TOOL_CATALOG) {
    try {
      const existing = await db.getToolCatalogByKey(t.toolKey);
      if (existing) continue;
      await db.createToolConfig({
        id: newUUIDv7(),
        name: t.name,
        description: t.description,
        category: t.category,
        risk_level: t.riskLevel,
        requires_approval: 0,
        max_execution_ms: 60000,
        rate_limit_per_min: 30,
        enabled: 1,
        tool_key: t.toolKey,
        version: '1.0',
        side_effects: t.sideEffects,
        tags: JSON.stringify(t.tags),
        source: 'builtin',
        credential_id: null,
      });
    } catch { /* non-fatal */ }
  }

  // Disable tools that have no working infrastructure in this deployment so
  // the supervisor never tries them. Math work is routed through cse_run_code
  // (which boots SymPy via pip in the chat sandbox).
  //   - sympy_*: require pre-built sandbox-sym container image (digests.json
  //     currently holds placeholder zeros → docker pull exits 125).
  //   - wolfram_query: requires WOLFRAM_APP_ID env var; not configured.
  const _BROKEN_TOOLS = ['sympy_simplify', 'sympy_solve', 'sympy_integrate', 'wolfram_query'];
  for (const key of _BROKEN_TOOLS) {
    try {
      const row = await db.getToolCatalogByKey(key);
      if (row && row.enabled !== 0) {
        await db.updateToolConfig(row.id, { enabled: 0 });
      }
    } catch { /* non-fatal */ }
  }
}

// ─── Workflow definition (informational / ops visibility) ───────────────────

const SV_WORKFLOW_ID = 'd4000001-5300-7000-b000-000000000001';

async function _seedSVWorkflowDef(db: DatabaseAdapter): Promise<void> {
  try {
    const existing = await db.getWorkflowDef(SV_WORKFLOW_ID).catch(() => null);
    if (existing) return;
    const steps = [
      { id: 'decompose',   agent: 'sv-decomposer',  next: ['parallel'] },
      { id: 'parallel',    parallel: ['literature', 'statistical', 'mathematical', 'simulation'], next: ['adversarial'] },
      { id: 'literature',  agent: 'sv-literature',  next: ['adversarial'] },
      { id: 'statistical', agent: 'sv-statistical', next: ['adversarial'] },
      { id: 'mathematical', agent: 'sv-mathematical', next: ['adversarial'] },
      { id: 'simulation',  agent: 'sv-simulation',  next: ['adversarial'] },
      { id: 'adversarial', agent: 'sv-adversarial', next: ['supervisor'] },
      { id: 'supervisor',  agent: 'chat-supervisor', terminal: true },
    ];
    await db.createWorkflowDef({
      id: SV_WORKFLOW_ID,
      name: 'Hypothesis Validation Deliberation',
      description: 'Decompose → parallel specialist evidence (literature, statistical, mathematical, simulation) → adversarial falsification → supervisor verdict. Documented for ops visibility; runtime orchestration is performed by chat.ts via the SVChatBridge.',
      version: '1.0',
      steps: JSON.stringify(steps),
      entry_step_id: 'decompose',
      metadata: JSON.stringify({ owner: 'hypothesis-validation', triggers: ['hypothesis_validation skill'] }),
      enabled: 1,
    });
  } catch { /* non-fatal */ }
}
