import { defineSkill, type SkillDefinition } from './types.js';

export const BUILT_IN_SKILLS: SkillDefinition[] = [
  defineSkill({
    id: 'skill-investigation-brief',
    name: 'Investigation Briefing',
    version: '2.0',
    category: 'analysis',
    summary: 'Turn a complex problem into a concise diagnostic brief with hypotheses, evidence, and clear next checks.',
    purpose: 'Help models reason transparently when debugging incidents, regressions, and architecture tradeoffs.',
    whenToUse: 'Use for bug triage, architecture reviews, and failure analysis where evidence and uncertainty should both be explicit.',
    whenNotToUse: 'Avoid for trivial factual requests where no multi-step reasoning is needed.',
    requiredContext: 'Include observed behavior, expected behavior, constraints, and known signals from logs/tests.',
    reasoningGuidance: 'Generate plausible hypotheses, rank by likelihood, gather confirming/disconfirming evidence, then converge.',
    executionGuidance: 'Keep analysis grounded in observed artifacts. Do not claim certainty without concrete evidence.',
    outputGuidance: 'Return: findings, confidence per finding, gaps, and immediate next actions.',
    completionGuidance: 'Done means top issues are identified, evidence is cited, and ambiguity is explicitly surfaced.',
    ambiguityGuidance: 'If evidence conflicts, mark ambiguous and request additional validation.',
    failureGuidance: 'If blocked, state what data is missing and how to collect it.',
    toolNames: ['text_analysis', 'json_format'],
    policy: {
      allowedTools: ['text_analysis', 'json_format'],
      sideEffectsAllowed: false,
      requiresApproval: false,
      sensitivityHandling: 'Avoid exposing secrets in summaries.',
    },
    completionContract: {
      narrative: 'Identify probable root causes, confidence, and explicit evidence before recommending actions.',
      requiredEvidence: ['evidence', 'confidence'],
      humanReviewWhen: 'When the recommendation could change production behavior.',
    },
    tags: ['debugging', 'investigation', 'analysis'],
    triggerPatterns: [],
    examples: [
      {
        input: 'API suddenly returns 401 in compliance routes after refactor.',
        output: 'Finding: auth middleware path mismatch likely introduced. Evidence: auth tests pass, compliance suite fails with 401. Confidence: medium. Next check: compare route registration + permission guard wiring.',
      },
    ],
  }),
  defineSkill({
    id: 'skill-structured-extraction',
    name: 'Structured Evidence Extraction',
    version: '2.0',
    category: 'extraction',
    summary: 'Extract required entities and evidence from noisy text into a deterministic schema while preserving ambiguity.',
    purpose: 'Support workflows that need machine-consumable outputs and confidence-aware extraction behavior.',
    whenToUse: 'Use for compliance checks, data normalization, and pipeline handoffs that require explicit fields.',
    whenNotToUse: 'Avoid when user only needs conversational summaries.',
    requiredContext: 'Provide schema goals, constraints, and examples of valid outputs.',
    executionGuidance: 'Prefer faithful extraction over inference; if uncertain, flag ambiguity instead of fabricating data.',
    outputGuidance: 'Return structured JSON with extracted values, confidence, and evidence spans.',
    completionGuidance: 'Complete only when required fields are populated or explicitly marked missing with reasons.',
    ambiguityGuidance: 'Use `ambiguous` state when evidence is conflicting or missing.',
    failureGuidance: 'Return blocked state and missing context checklist if input is insufficient.',
    toolNames: ['json_format'],
    policy: {
      allowedTools: ['json_format'],
      sideEffectsAllowed: false,
    },
    completionContract: {
      narrative: 'Populate required fields, include confidence, and cite evidence for each extracted claim.',
      requiredEvidence: ['confidence', 'evidence'],
    },
    triggerPatterns: [],
  }),
  defineSkill({
    id: 'skill-data-analysis-execution',
    name: 'Data Analysis Execution',
    version: '1.0',
    category: 'analysis',
    summary: 'Run dataset analysis and charting workflows in a dedicated Python sandbox with preloaded analytics libraries.',
    purpose: 'Route file analysis, charting, and dataframe-heavy tasks to an execution surface that already has the right libraries installed.',
    whenToUse: 'Use for CSV, Excel, JSON, Parquet, dataframe analysis, chart generation, exploratory statistics, and code-backed data insights.',
    whenNotToUse: 'Avoid for plain prose summaries, lightweight arithmetic, or generic non-analysis scripting.',
    requiredContext: 'Include dataset filenames, expected metrics or chart types, and any output constraints such as grouping, date windows, or dimensions.',
    reasoningGuidance: 'Inspect the available data first, choose the smallest correct analysis plan, then execute and verify with concrete outputs.',
    executionGuidance: 'Use `cse_run_data_analysis` for analysis execution. Reuse the same session when iterating on the script, and only fall back to `cse_run_code` if the task is clearly not a data-analysis workflow.',
    outputGuidance: 'Return executed-code evidence, computed metrics, and concise insights grounded in stdout or structured results.',
    completionGuidance: 'Done means the code ran successfully, requested metrics were computed, and the answer includes concrete analysis or chart-ready data.',
    ambiguityGuidance: 'If required columns, files, or business definitions are missing, state the gap and either inspect the data shape or ask for the exact missing detail.',
    failureGuidance: 'If execution fails, correct the script and rerun. Only stop when the blocker is environmental or the input data is insufficient.',
    toolNames: ['cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format', 'text_analysis'],
    policy: {
      allowedTools: ['cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format', 'text_analysis'],
      disallowedTools: ['cse_run_code'],
      sideEffectsAllowed: false,
      requiresApproval: false,
    },
    completionContract: {
      narrative: 'Produce evidence-backed analysis from executed code and include explicit limitations when the data does not support a stronger conclusion.',
      requiredEvidence: ['evidence', 'confidence'],
    },
    // This skill executes data analysis directly via `cse_run_data_analysis`
    // (it does NOT require delegating to the `code_executor` worker). Declaring
    // an executionContract — even an empty one — is what signals to
    // `buildSupervisorInstructions` to suppress the generic
    // FORCED_WORKER_REQUIREMENT (2-step code_executor→analyst flow), which
    // otherwise conflicts with this skill's direct-execution plan.
    executionContract: {
      minDelegations: 0,
    },
    tags: ['analysis', 'data', 'charting', 'sandbox', 'auto-on-tabular'],
    triggerPatterns: ['analyze this csv', 'analyze this xlsx', 'analyze this spreadsheet', 'plot this data', 'chart this data', 'dataframe analysis', 'exploratory data analysis'],
  }),
  defineSkill({
    id: 'skill-tool-orchestrated-analysis',
    name: 'Tool-Orchestrated Analysis',
    version: '2.0',
    category: 'planning',
    summary: 'Plan and execute multi-step analysis that combines reasoning with governed tool usage.',
    purpose: 'Guide the model to choose tools deliberately, verify outputs, and report completion states safely.',
    whenToUse: 'Use when direct model reasoning is insufficient and tool outputs are required as evidence.',
    whenNotToUse: 'Avoid when policy forbids tool usage for the current context or tenant scope.',
    requiredContext: 'Provide task objective, tool availability, runtime budgets, and sensitivity constraints.',
    reasoningGuidance: 'Decide if tools are needed, sequence calls, verify outputs, then synthesize conclusions.',
    executionGuidance: 'Use the minimum required tool set and retry only with clear corrective intent.',
    outputGuidance: 'Report tool evidence, latency-sensitive caveats, and completion status.',
    completionGuidance: 'Done means output includes evidence-backed conclusion and explicit unresolved gaps.',
    failureGuidance: 'If a required tool is blocked, return blocked_by_policy with exact guard reason.',
    toolNames: ['web_search', 'calculator', 'json_format'],
    policy: {
      allowedTools: ['web_search', 'calculator', 'json_format'],
      disallowedTools: ['cse_run_code'],
      sideEffectsAllowed: false,
      requiresApproval: true,
      runtimeBudgetMs: 20000,
    },
    completionContract: {
      narrative: 'Evidence-backed answer with declared confidence and unresolved unknowns.',
      requiredEvidence: ['evidence', 'confidence'],
      humanReviewWhen: 'Recommendations involve external actions or policy exceptions.',
    },
    triggerPatterns: [],
  }),

  // ── Equity thesis writer ──────────────────────────────────────────────────────
  defineSkill({
    id: 'skill-equity-thesis',
    name: 'Equity Thesis Writer',
    version: '1.0',
    category: 'analysis',
    summary: 'Write a structured investment thesis paragraph from a computed SymbolScore and InputBundle, citing only values present in the data.',
    purpose: 'Turn deterministic factor scores into clear, human-readable investment logic that a portfolio manager can act on.',
    whenToUse: 'Use after scoreSymbol/scoreUniverse produces a SymbolScore to explain the ranking in plain language with concrete numbers.',
    whenNotToUse: 'Do NOT use as a substitute for data collection or scoring — this skill writes prose over already-computed numbers, never invents them.',
    requiredContext: 'Must have: symbol, composite score, decile, confidence, factor scores (with rawInputs), redFlags, greenFlags, strategy name, and key financial metrics from the InputBundle fundamentals.',
    executionGuidance: `
Follow this structure exactly:
1. LEAD LINE — composite score (formatted -1..+1), decile rank, and confidence level.
2. STRATEGY — which ScoringStrategy was used and which factor weights dominated the composite.
3. TOP 3 POSITIVE FACTORS — for each: factor name, score, and the actual numbers that drove it (cite rawInputs values, e.g. "ROIC of 22% vs industry median 9%"). Use peer context where available.
4. BOTTOM 2 NEGATIVE FACTORS — same format, be honest about weaknesses.
5. GREEN FLAGS — list each code and evidence string verbatim.
6. RED FLAGS — list each code, severity, and evidence string verbatim. State the implication.
7. OUTLOOK — one sentence synthesis.
NEVER invent numbers. If a rawInput is null, say "data unavailable". Do not round aggressively — keep 1–2 significant decimals.`,
    outputGuidance: 'Return 200-400 words of prose with a clear structure. No markdown headers inside the paragraph — write as flowing investment memo text.',
    completionGuidance: 'Complete when all 7 sections are addressed and every cited number is present in the provided score/bundle data.',
    ambiguityGuidance: 'If required score fields are missing, state the gap explicitly rather than estimating.',
    failureGuidance: 'If the score data is insufficient (coverage < 0.3), lead with a coverage caveat before the thesis.',
    policy: {
      sideEffectsAllowed: false,
      requiresApproval: false,
      sensitivityHandling: 'Do not speculate about insider knowledge. Cite only data from the score and bundle.',
    },
    completionContract: {
      narrative: 'Thesis covers score, strategy, top/bottom factors with actual numbers, flags, and a synthesis sentence.',
      requiredEvidence: ['composite', 'decile', 'factors', 'redFlags', 'greenFlags'],
    },
    triggerPatterns: ['write.*thesis', 'explain.*score', 'investment.*thesis', 'analyze.*stock', 'why.*ranked'],
    examples: [
      {
        input: 'Write an equity thesis for AAPL with composite=0.62, decile=8, strategy=compounder-quality.',
        output: 'Apple (AAPL) scores 0.62 composite (decile 8/10, confidence 88%) under the Compounder Quality strategy, where quality (35%) and profitability (20%) dominate. The three strongest contributors are: quality (score +0.71), driven by ROIC of 55% vs sector median ~15% and Altman Z of 6.8 well above distress; profitability (+0.65), with gross margin 45.5%, operating margin 30.5%; and capital_allocation (+0.48), with 5-year ROIC slope positive and consistent positive FCF. The weakest factors are size (−0.12) reflecting its mega-cap profile, and value (−0.08) given P/E of 29.8 above sector median. Green flags: COMPOUNDER — 5y ROIC ≥ 15% every year. No red flags detected. Synthesis: Apple remains a high-quality compounder with exceptional capital efficiency; the primary risk is valuation compression if rate expectations shift upward.',
        notes: 'Demonstrates exact-number citation, flag verbatim quoting, and honest weakness disclosure.',
      },
    ],
  }),
];
