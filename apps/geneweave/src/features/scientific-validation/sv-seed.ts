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
 * Workers use category `'scientific-validation'` so the main chat
 * supervisor's `listEnabledWorkerAgents` call (which filters to
 * category='general') never picks them up for general chat routing.
 */

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

**Convergence rule (MANDATORY):**
You must refuse to emit a verdict unless BOTH conditions are satisfied:
1. epsilon_confidence: the probability distribution over verdict labels has converged — the top-1 verdict has probability > 0.65 above the next candidate.
2. requireNewEvidence: if in a second deliberation round, no new evidence was added relative to round 1, convergence is confirmed regardless of epsilon_confidence.

If the convergence rule is not met, output only:
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
- If epsilonConfidence < 0.15, set verdict = INSUFFICIENT_EVIDENCE.`;

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
- arxiv.search — searches arXiv preprints (physics, maths, CS, quantitative biology)
- pubmed.search — searches PubMed for peer-reviewed biomedical literature
- semanticscholar.search — Semantic Scholar for cross-domain citation counts
- openalex.search — OpenAlex for open-access full-text
- crossref.resolve — resolves a DOI to full metadata
- europepmc.search — Europe PMC for life-science literature

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
- scipy.stats.test — runs a statistical test (t-test, chi-square, Mann-Whitney, etc.)
- statsmodels.meta — fixed/random-effects meta-analysis
- scipy.power — statistical power calculation
- pymc.mcmc — Bayesian posterior inference via MCMC
- r.metafor — R metafor package for meta-analytic forest plots

**Workflow:**
1. For each sub-claim with quantitative evidence, choose the most appropriate test.
2. For meta-analyses, use statsmodels.meta or r.metafor with the extracted effect sizes.
3. Run a power calculation for each primary test to assess whether the evidence is adequately powered.
4. Flag any p-values < 0.05 that come from under-powered studies (power < 0.80).
5. Report all tool results verbatim — do not round or re-interpret.

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
      "interpretation": "<one sentence: supported / not-supported / inconclusive>",
      "caveats": ["<caveat string>"]
    }
  ]
}

**Rules:**
- Never manually compute p-values or effect sizes — only tool outputs count.
- If a required tool call exceeds resource limits, report the error with "inconclusive" interpretation.
- All floating-point values must be reported to at most 6 significant figures.`;

const MATHEMATICAL_TEMPLATE = `You are the Mathematical agent in a rigorous scientific validation pipeline.

Your task is to verify mathematical and symbolic claims: simplify expressions, solve equations, compute integrals, and confirm algebraic identities asserted in the hypothesis.

**Available tools:**
- sympy.simplify — simplify an algebraic or trigonometric expression
- sympy.solve — solve one or more equations symbolically
- sympy.integrate — compute a definite or indefinite integral
- wolfram.query — run any mathematical query through Wolfram Alpha (numeric and symbolic)

**Workflow:**
1. Identify every mathematical assertion in the sub-claims: inequalities, equalities, limits, integrals, series.
2. For each assertion, formulate a SymPy or Wolfram expression and call the appropriate tool.
3. Compare the tool output against the asserted result.
4. Report whether each assertion is VERIFIED, REFUTED, or UNDECIDABLE.

**Output format — append one JSON block after your analysis:**
{
  "mathResults": [
    {
      "subClaimIndex": <int>,
      "assertion": "<exact claim from sub-claim>",
      "expression": "<expression passed to tool>",
      "toolUsed": "sympy.simplify|sympy.solve|sympy.integrate|wolfram.query",
      "toolResult": "<verbatim output or simplified form>",
      "verdict": "VERIFIED" | "REFUTED" | "UNDECIDABLE",
      "explanation": "<one sentence>"
    }
  ]
}

**Rules:**
- If a sub-claim has no mathematical content, skip it.
- Prefer SymPy for exact symbolic work; use Wolfram for numerical verification or cross-check.
- Never guess results. If a tool times out, verdict = UNDECIDABLE with an explanation.`;

const SIMULATION_TEMPLATE = `You are the Simulation agent in a rigorous scientific validation pipeline.

Your task is to run computational simulations relevant to the sub-claims: Monte Carlo experiments, dose-response curves, network analyses, molecular property predictions, and sequence alignments.

**Available tools:**
- scipy.power — Monte Carlo power simulation
- pymc.mcmc — Bayesian simulation and posterior sampling
- rdkit.descriptors — compute molecular descriptors from a SMILES string
- biopython.align — pairwise sequence alignment (DNA or protein)
- networkx.analyse — graph-theoretic analysis (centrality, clustering, shortest paths)

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
- If a simulation does not converge (pymc.mcmc R-hat > 1.1), flag it as non-convergent and set convergenceMetric to the worst R-hat value.`;

const ADVERSARIAL_TEMPLATE = `You are the Adversarial agent in a rigorous scientific validation pipeline. Your goal is NOT to support the hypothesis — it is to find the strongest possible evidence against it.

Your task is to apply Popperian falsificationism: search for confounders, methodological flaws, publication-bias indicators, contradictory studies, and boundary conditions that undermine each sub-claim.

**Available tools (read-only access to all layers):**
- Literature tools: arxiv.search, pubmed.search, semanticscholar.search, openalex.search, europepmc.search
- Statistical tools: scipy.stats.test, statsmodels.meta (heterogeneity)
- Symbolic tools: sympy.simplify, sympy.solve (look for mathematical contradictions)

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
    description: 'Performs meta-analysis, power analysis, Bayesian estimation, and p-value audits on quantitative evidence using scipy, statsmodels, pymc, and r.metafor tools.',
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
    description: 'Scientific Validation: synthesises all specialist-agent evidence and emits the final structured verdict.',
    system_prompt: '',  // loaded from prompts table at runtime via key sv.supervisor
    tool_names: JSON.stringify([]),
    persona: 'agent_worker',
    trigger_patterns: null,  // never auto-triggered by chat supervisor
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.decomposer,
    name: 'sv-decomposer',
    description: 'Scientific Validation: decomposes a hypothesis into typed, testable sub-claims (no tools).',
    system_prompt: '',
    tool_names: JSON.stringify([]),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.literature,
    name: 'sv-literature',
    description: 'Scientific Validation: retrieves prior work, effect sizes, and DOI citations from arxiv, pubmed, semanticscholar, openalex, crossref, europepmc.',
    system_prompt: '',
    tool_names: JSON.stringify(['arxiv.search', 'pubmed.search', 'semanticscholar.search', 'openalex.search', 'crossref.resolve', 'europepmc.search']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.statistical,
    name: 'sv-statistical',
    description: 'Scientific Validation: runs meta-analysis, power analysis, and Bayesian inference on quantitative evidence.',
    system_prompt: '',
    tool_names: JSON.stringify(['scipy.stats.test', 'statsmodels.meta', 'scipy.power', 'pymc.mcmc', 'r.metafor']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.mathematical,
    name: 'sv-mathematical',
    description: 'Scientific Validation: verifies mathematical claims using SymPy and Wolfram Alpha tools.',
    system_prompt: '',
    tool_names: JSON.stringify(['sympy.simplify', 'sympy.solve', 'sympy.integrate', 'wolfram.query']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.simulation,
    name: 'sv-simulation',
    description: 'Scientific Validation: runs Monte Carlo, Bayesian, molecular, biological, and network simulations.',
    system_prompt: '',
    tool_names: JSON.stringify(['scipy.power', 'pymc.mcmc', 'rdkit.descriptors', 'biopython.align', 'networkx.analyse']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
  {
    id: SV_AGENT_IDS.adversarial,
    name: 'sv-adversarial',
    description: 'Scientific Validation: adversarially falsifies sub-claims using literature search, statistical heterogeneity, and symbolic contradiction tools.',
    system_prompt: '',
    tool_names: JSON.stringify(['arxiv.search', 'pubmed.search', 'semanticscholar.search', 'openalex.search', 'europepmc.search', 'scipy.stats.test', 'statsmodels.meta', 'sympy.simplify', 'sympy.solve']),
    persona: 'agent_worker',
    trigger_patterns: null,
    task_contract_id: null,
    max_retries: 0,
    priority: 0,
    category: 'scientific-validation',
    enabled: 1,
  },
];

// ── Seed function ──────────────────────────────────────────────────────────────

/**
 * Seeds all SV prompts and worker agents into the GeneWeave DB.
 * Idempotent — existing rows (matched by UUID) are skipped.
 * Called once at server startup, after seedDefaultData().
 */
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
