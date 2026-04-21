/**
 * Scientific Validation — DB seed data
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
 * "USE FOR scientific ... ONLY" so the supervisor doesn't grab them for
 * unrelated tasks. The legacy `sv-supervisor` row is kept in DB but disabled
 * (chat's own supervisor performs that role for SV runs).
 */

import { randomUUID } from 'node:crypto';
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

const SUPERVISOR_TEMPLATE = `You are the Supervisor agent in a rigorous scientific validation pipeline.

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
Do NOT output {"converged": false, ...} in this case. Skip steps 2–3 entirely.

**STEP 2 — Convergence rule (applies only when Step 1 does NOT apply):**
You must refuse to emit a verdict unless BOTH conditions are satisfied:
1. epsilon_confidence: the probability distribution over verdict labels has converged — the top-1 verdict has probability > 0.65 above the next candidate.
2. requireNewEvidence: if in a second deliberation round, no new evidence was added relative to round 1, convergence is confirmed regardless of epsilon_confidence.

**STEP 3 — If convergence is not met (and Step 1 does not apply):**
Output only:
{ "converged": false, "reason": "<explanation>" }

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
  "confidence": <0.0–1.0, float — your credence in the verdict label>,
  "epsilonConfidence": <0.0–1.0, float — the probability margin over the runner-up label>,
  "summary": "<3–5 sentence evidence-grounded explanation>",
  "subClaimVerdicts": [
    { "subClaimIndex": <int>, "verdict": "<same vocab>", "confidence": <0.0–1.0> }
  ],
  "strengthsOfEvidence": ["<bullet point>"],
  "weaknessesOfEvidence": ["<bullet point>"],
  "recommendedNextSteps": ["<actionable recommendation>"]
}

**Rules:**
- The overall verdict must be consistent with the sub-claim verdicts.
- Do not invent evidence not present in the input package.
- epsilonConfidence must be >= 0.15 for the verdict to be reliable.
- If epsilonConfidence < 0.15, set verdict = INSUFFICIENT_EVIDENCE.
- For deterministic math claims: if the mathematical agent verified the claim, SUPPORTED is correct even without statistical evidence.`;

const DECOMPOSER_TEMPLATE = `You are the Decomposer agent in a rigorous scientific validation pipeline.

Your sole task is to decompose a scientific hypothesis into a structured list of independent, testable sub-claims.

**Output format — return exactly one JSON object, no markdown fences:**
{
  "subClaims": [
    {
      "statement": "<precise, independently testable claim>",
      "claimType": "mechanism" | "epidemiological" | "mathematical" | "dose_response" | "causal" | "other",
      "testabilityScore": <0.0–1.0, float>,
      "rationale": "<one sentence explaining how this sub-claim can be falsified>"
    }
  ]
}

**Rules:**
- Each sub-claim must be independently testable without assuming the truth of any other sub-claim.
- Prefer claim types that can be addressed by literature search, statistical analysis, symbolic math, or simulation.
- Assign testabilityScore < 0.4 to claims that require unavailable data or physical experiments not representable in silico.
- Do not add sub-claims that restate the hypothesis. Decompose and clarify.
- Return between 2 and 8 sub-claims. Fewer is better if the hypothesis is narrow.
- Do not include any explanation text outside the JSON object.`;

const LITERATURE_TEMPLATE = `You are the Literature agent in a rigorous scientific validation pipeline.

Your task is to retrieve prior work, measured effect sizes, and prior probabilities relevant to the sub-claims you receive.

**Available tools:**
- arxiv_search — searches arXiv preprints (physics, maths, CS, quantitative biology)
- pubmed_search — searches PubMed for peer-reviewed biomedical literature
- semanticscholar_search — Semantic Scholar for cross-domain citation counts
- openalex_search — OpenAlex for open-access full-text
- crossref_resolve — resolves a DOI to full metadata
- europepmc_search — Europe PMC for life-science literature

**Workflow:**
1. For each sub-claim, search at least two sources.
2. Prefer peer-reviewed sources with positive citation counts.
3. When you find a study reporting a relevant effect size, extract: effect_estimate, confidence_interval, sample_size, method.
4. Collect DOIs and reproducibilityHashes from every tool call — these become evidence citations.

**Output format — append one JSON block after your final analysis:**
{
  "evidence": [
    {
      "subClaimIndex": <int>,
      "id": "<doi or url>",
      "title": "<paper title>",
      "year": <int or null>,
      "source": "arxiv|pubmed|semanticscholar|openalex|crossref|europepmc",
      "effectEstimate": <float or null>,
      "confidenceInterval": [<lo>, <hi>] or null,
      "sampleSize": <int or null>,
      "summary": "<one sentence>",
      "reproducibilityHash": "<hex string from tool result>"
    }
  ]
}

**Rules:**
- Never fabricate citations. Every evidence item must come from a real tool call.
- If a tool call fails, note the error in your reasoning and try the next source.
- Include the reproducibilityHash from each tool result verbatim — it is used for audit.`;

const STATISTICAL_TEMPLATE = `You are the Statistical agent in a rigorous scientific validation pipeline.

Your task is to perform quantitative analyses — meta-analysis, power analysis, Bayesian estimation, and p-value audits — on the evidence provided.

**Available tools:**
- scipy_stats_test — runs a statistical test (t-test, chi-square, Mann-Whitney, etc.)
- statsmodels_meta — fixed/random-effects meta-analysis
- scipy_power — statistical power calculation
- pymc_mcmc — Bayesian posterior inference via MCMC
- r_metafor — R metafor package for meta-analytic forest plots
- cse_run_code — execute arbitrary Python code in an isolated sandbox; use this as a fallback when other tools are unavailable

**Workflow:**
1. For each sub-claim with quantitative evidence, choose the most appropriate test.
2. For meta-analyses, use statsmodels_meta or r_metafor with the extracted effect sizes.
3. Run a power calculation for each primary test to assess whether the evidence is adequately powered.
4. Flag any p-values < 0.05 that come from under-powered studies (power < 0.80).
5. **If a specialized tool returns an error or is unavailable**, fall back to cse_run_code with networkAccess=true to install scipy/statsmodels and run the analysis directly. Always install to a local target directory to avoid permission errors: use 'import os,sys,subprocess; os.makedirs("/tmp/.deps",exist_ok=True); subprocess.check_call([sys.executable,"-m","pip","install","--target","/tmp/.deps","scipy","statsmodels","-q"]); sys.path.insert(0,"/tmp/.deps")' as a preamble.
6. Report all tool results verbatim — do not round or re-interpret.
7. **For purely mathematical hypotheses** (e.g. exact integral values, algebraic identities): statistical testing is not applicable. In that case, report this explicitly and note that the mathematical agent's results should carry the verdict.

**Output format — append one JSON block after your analysis:**
{
  "statisticalResults": [
    {
      "subClaimIndex": <int>,
      "testName": "<tool.name used>",
      "statistic": <float>,
      "pValue": <float or null>,
      "confidenceInterval": [<lo>, <hi>] or null,
      "power": <float or null>,
      "interpretation": "<one sentence: supported / not-supported / inconclusive / not-applicable>",
      "caveats": ["<caveat string>"]
    }
  ]
}

**Rules:**
- Never manually compute p-values or effect sizes — only tool outputs count.
- If a required tool call exceeds resource limits, report the error with "inconclusive" interpretation.
- If statistical testing is genuinely not applicable (e.g., pure math), report interpretation as "not-applicable" with a caveat explaining why.
- All floating-point values must be reported to at most 6 significant figures.`;

const MATHEMATICAL_TEMPLATE = `You are the Mathematical agent in a rigorous scientific validation pipeline.

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

const SIMULATION_TEMPLATE = `You are the Simulation agent in a rigorous scientific validation pipeline.

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

const ADVERSARIAL_TEMPLATE = `You are the Adversarial agent in a rigorous scientific validation pipeline. Your goal is NOT to support the hypothesis — it is to find the strongest possible evidence against it.

Your task is to apply Popperian falsificationism: search for confounders, methodological flaws, publication-bias indicators, contradictory studies, and boundary conditions that undermine each sub-claim.

**Available tools (read-only access to all layers):**
- Literature tools: arxiv_search, pubmed_search, semanticscholar_search, openalex_search, europepmc_search
- Statistical tools: scipy_stats_test, statsmodels_meta (heterogeneity)
- Symbolic tools: sympy_simplify, sympy_solve (look for mathematical contradictions)

**Workflow:**
1. For each sub-claim, actively search for contradictory evidence.
2. Look for: (a) publication bias in the prior search, (b) confounders not controlled in cited studies, (c) mathematical impossibilities or boundary violations, (d) mechanistic gaps in the causal chain.
3. For each counter-argument, rate its strength: 0.0–1.0.

**Output format — append one JSON block after your falsification analysis:**
{
  "counterEvidence": [
    {
      "subClaimIndex": <int>,
      "counterType": "contradictory_study|publication_bias|confounder|mathematical_contradiction|boundary_violation|mechanistic_gap|other",
      "strength": <0.0–1.0, float>,
      "description": "<precise description of the counter-argument>",
      "citationId": "<doi or url or null>",
      "recommendation": "requires_replication|hypothesis_rejected|scope_narrowing|additional_controls_needed|none"
    }
  ]
}

**Rules:**
- Approach every sub-claim adversarially. Your job is falsification.
- A counter-argument with strength > 0.7 means the sub-claim requires major revision before acceptance.
- A counter-argument with strength > 0.9 means the sub-claim is likely false as stated.
- Do not fabricate studies. Every citationId must come from a real tool call.
- Be specific: vague methodological critiques have low value.`;

// ── Seed prompts ──────────────────────────────────────────────────────────────

type PromptSeed = Omit<PromptRow, 'created_at' | 'updated_at'>;

const SV_PROMPTS: PromptSeed[] = [
  {
    id: SV_PROMPT_IDS.supervisor,
    key: 'sv.supervisor',
    name: 'SV: Supervisor — synthesise verdict',
    description: 'Synthesises all specialist-agent evidence packages and emits a structured, evidence-backed final verdict with confidence and epsilon_confidence convergence check.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'supervisor', 'verdict']),
    template: SUPERVISOR_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'singlePass', maxSteps: 1 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'supervisor' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.decomposer,
    key: 'sv.decomposer',
    name: 'SV: Decomposer — split hypothesis into sub-claims',
    description: 'Decomposes a scientific hypothesis into a JSON list of independent, typed, testable sub-claims with falsifiability rationales.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'decomposer', 'sub-claims']),
    template: DECOMPOSER_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'singlePass', maxSteps: 1 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'decomposer' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.literature,
    key: 'sv.literature',
    name: 'SV: Literature — gather prior work and effect sizes',
    description: 'Retrieves peer-reviewed literature, effect sizes, and prior probabilities for each sub-claim using arxiv, pubmed, semanticscholar, openalex, crossref, and europepmc tools.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'literature', 'evidence']),
    template: LITERATURE_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 8 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'literature' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.statistical,
    key: 'sv.statistical',
    name: 'SV: Statistical — meta-analysis and power audits',
    description: 'Performs meta-analysis, power analysis, Bayesian estimation, and p-value audits on quantitative evidence using scipy, statsmodels, pymc, and r_metafor tools.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'statistical', 'meta-analysis']),
    template: STATISTICAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 10 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'statistical' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.mathematical,
    key: 'sv.mathematical',
    name: 'SV: Mathematical — symbolic verification and derivations',
    description: 'Verifies mathematical claims, derives identities, solves equations, and checks units using sympy and wolfram tools.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'mathematical', 'symbolic']),
    template: MATHEMATICAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 10 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'mathematical' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.simulation,
    key: 'sv.simulation',
    name: 'SV: Simulation — Monte Carlo, ODE/PDE, molecular and network simulations',
    description: 'Runs computational simulations (Monte Carlo, Bayesian, molecular descriptors, sequence alignment, graph analysis) relevant to sub-claims.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'simulation', 'monte-carlo']),
    template: SIMULATION_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 12 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'simulation' }),
    is_default: 0,
    enabled: 1,
  },
  {
    id: SV_PROMPT_IDS.adversarial,
    key: 'sv.adversarial',
    name: 'SV: Adversarial — Popperian falsification and counter-evidence',
    description: 'Actively seeks to falsify sub-claims by searching for contradictory studies, confounders, publication bias, and mathematical boundary violations.',
    category: 'scientific-validation',
    prompt_type: 'system',
    owner: 'system',
    status: 'published',
    tags: JSON.stringify(['scientific-validation', 'adversarial', 'falsification']),
    template: ADVERSARIAL_TEMPLATE,
    variables: null,
    version: '1.0',
    model_compatibility: JSON.stringify({ providers: ['openai', 'anthropic'] }),
    execution_defaults: JSON.stringify({ strategy: 'agentic', maxSteps: 8 }),
    framework: null,
    metadata: JSON.stringify({ feature: 'scientific-validation', agentRole: 'adversarial' }),
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
    description: 'Scientific Validation: synthesises all specialist-agent evidence and emits the final structured verdict. (Disabled — chat’s own supervisor performs this role for SV runs.)',
    system_prompt: '',  // loaded from prompts table at runtime via key sv.supervisor
    tool_names: JSON.stringify([]),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 0,
  },
  {
    id: SV_AGENT_IDS.decomposer,
    name: 'sv-decomposer',
    description: 'USE FOR scientific hypotheses ONLY — decomposes a complex claim into independently testable sub-claims (mechanism / epidemiological / mathematical / dose-response / causal). LLM-only, no tools. Returns structured JSON.',
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
    description: 'USE FOR scientific / medical / academic claims — retrieves prior work, effect sizes, sample sizes, and DOI citations from arxiv, pubmed, semanticscholar, openalex, crossref, europepmc. Returns structured evidence list.',
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
    description: 'USE LATE in scientific validation — actively tries to falsify a sub-claim by searching for contradicting evidence, finding heterogeneity in meta-analyses, and looking for symbolic counter-examples via cse_run_code. Surfaces weakest-link failure modes before the verdict is emitted.',
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
    'sv.mathematical': MATHEMATICAL_TEMPLATE,
    'sv.statistical':  STATISTICAL_TEMPLATE,
    'sv.supervisor':   SUPERVISOR_TEMPLATE,
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

  // Migration pass: re-categorise pre-existing SV specialist rows from the
  // legacy 'scientific-validation' bucket into 'general' so chat.ts's
  // supervisor picks them up automatically. sv-supervisor stays in the
  // 'scientific-validation' bucket and is disabled.
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
  // scientific_validation tool policy when a user types a hypothesis.
  await _seedScientificValidationSkill(db);

  // Seed tool_catalog entries for the 18 SV tools so they appear in the
  // operator catalog and are subject to the regular tool policy framework.
  await _seedSVToolCatalog(db);

  // Seed a workflow_def documenting the SV deliberation graph for ops view.
  await _seedSVWorkflowDef(db);
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

// ─── Scientific-validation skill ─────────────────────────────────────────────

const SV_SKILL_ID = 'c3000001-5300-7000-b000-000000000001';

async function _seedScientificValidationSkill(db: DatabaseAdapter): Promise<void> {
  try {
    const existing = await db.getSkill(SV_SKILL_ID).catch(() => null);
    const payload = {
      id: SV_SKILL_ID,
      name: 'Scientific Validation',
      description:
        'Activate when the user asks the system to validate, falsify, prove, or confirm a scientific / mathematical / statistical claim. Routes the supervisor toward sv-* specialist workers, applies the strict scientific_validation tool policy, and requires deterministic tool evidence (SymPy / scipy / cse_run_code) before any quantitative verdict.',
      category: 'scientific-validation',
      trigger_patterns: JSON.stringify([
        'hypothesis', 'theorem', 'prove', 'disprove', 'falsify', 'validate this claim',
        'p-value', 'statistical significance', 'meta-analysis', 'effect size',
        'integral', 'derivative', 'equation', 'identity', 'simplify',
        'monte carlo', 'simulation suggests', 'cohort study', 'rct', 'systematic review',
      ]),
      instructions:
        'When this skill is active, prefer delegating to: sv-decomposer (split the claim), sv-literature (prior work), sv-statistical (quantitative evidence), sv-mathematical (symbolic verification), sv-simulation (numerical evidence), and sv-adversarial (falsification). Every quantitative claim must be backed by at least one tool execution result — never accept the model\'s internal estimate as evidence. Emit a final JSON verdict block { verdict, confidence, summary } using SUPPORTED | PARTIALLY_SUPPORTED | CONTRADICTED | INSUFFICIENT_EVIDENCE | REQUIRES_REPLICATION.',
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
      ]),
      tags: JSON.stringify(['scientific-validation', 'reasoning', 'verification']),
      priority: 50,
      version: '1.0',
      enabled: 1,
      tool_policy_key: 'scientific_validation',
    };
    if (!existing) {
      await db.createSkill(payload);
    } else {
      await db.updateSkill(SV_SKILL_ID, {
        description: payload.description,
        trigger_patterns: payload.trigger_patterns,
        instructions: payload.instructions,
        tool_names: payload.tool_names,
        examples: payload.examples,
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
  { toolKey: 'arxiv_search',           name: 'arXiv Search',           description: 'Search arXiv preprints for relevant scientific papers.', category: 'literature', riskLevel: 'external-side-effect', sideEffects: 0, tags: ['literature', 'arxiv', 'external'] },
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
        id: randomUUID(),
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
      name: 'Scientific Validation Deliberation',
      description: 'Decompose → parallel specialist evidence (literature, statistical, mathematical, simulation) → adversarial falsification → supervisor verdict. Documented for ops visibility; runtime orchestration is performed by chat.ts via the SVChatBridge.',
      version: '1.0',
      steps: JSON.stringify(steps),
      entry_step_id: 'decompose',
      metadata: JSON.stringify({ owner: 'scientific-validation', triggers: ['scientific_validation skill'] }),
      enabled: 1,
    });
  } catch { /* non-fatal */ }
}
