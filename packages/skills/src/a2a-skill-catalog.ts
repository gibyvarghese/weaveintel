/**
 * @weaveintel/skills — A2A Skill Catalog (mid-2026)
 *
 * Typed catalog of all A2A protocol skills supported by WeaveIntel.
 * These skills are published in the Agent Card and discoverable by A2A clients
 * per the Google A2A specification (April 2024, v0.2+).
 *
 * Architecture:
 *   - Skills with `enabled: 0` require infrastructure that is not yet wired
 *     (computer-use, browser-automation) or a model not yet configured (image-generation).
 *   - The canonical seed path is the DB migration chain (m60 → m61 → m69).
 *     This catalog is the type-safe reference for those migrations and for tests.
 *   - MIME types follow RFC 2045/7231 and the IANA media type registry.
 *
 * Scope naming convention:
 *   a2a:<resource>           — read/execute (e.g. a2a:chat, a2a:document)
 *   a2a:<resource>:read      — explicit read (e.g. a2a:image:read, a2a:memory:read)
 *   a2a:<resource>:write     — mutation/generation (e.g. a2a:image:write)
 *
 * Reference: https://github.com/google-a2a/A2A/blob/main/docs/specification.md
 */

export interface A2AWorkerDef {
  name: string;
  description: string;
  tools: string[];
  persona: string;
}

export type A2ASkillMode = 'agent' | 'supervisor' | 'ensemble';

export interface A2ASkillDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples: readonly string[];
  readonly input_modes: readonly string[];
  readonly output_modes: readonly string[];
  readonly security_scopes: readonly string[];
  readonly mode: A2ASkillMode;
  readonly required_permission: string | null;
  readonly sort_order: number;
  /** 1 = published in Agent Card; 0 = hidden (requires infra or unconfigured model). */
  readonly enabled: 0 | 1;
  readonly agent_tools: readonly string[] | null;
  readonly agent_workers: readonly A2AWorkerDef[] | null;
}

// ── Shared MIME-type lists ────────────────────────────────────────────────────

const FULL_AUDIO_INPUT = [
  'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/*',
] as const;

const FULL_IMAGE_INPUT = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*',
] as const;

const FULL_VIDEO_INPUT = [
  'video/mp4', 'video/webm', 'video/ogg', 'video/*',
] as const;

const OPENXML_INPUT = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

// Full multimodal input — all 3 existing skills get these MIME types added in m69
const FULL_MULTIMODAL_INPUT = [
  'text/plain',
  ...FULL_AUDIO_INPUT,
  ...FULL_IMAGE_INPUT,
  ...FULL_VIDEO_INPUT,
  'text/html',
  'application/pdf', 'text/csv', 'application/json',
  ...OPENXML_INPUT,
] as const;

// ── Existing skills (seeded in m60 + updated in m69) ─────────────────────────

const GENERAL_CHAT: A2ASkillDef = {
  id: 'general-chat',
  name: 'General Chat (Agent)',
  description:
    'Single ReAct agent with tool-calling, skill routing, and memory. Accepts text, audio (with transcript), images, video, documents, and CSVs as FilePart attachments. Default mode for all authenticated callers.',
  tags: ['chat', 'tool-calling', 'agent', 'voice', 'file', 'multimodal'],
  examples: [
    'Analyse this CSV and summarize the top trends',
    'What is the capital of France?',
    '[FilePart audio/wav + metadata.transcript] Transcribe and respond to my voice note',
    '[FilePart image/png] Describe what you see in this image',
    '[FilePart video/mp4] Summarise this video recording',
  ],
  input_modes: [...FULL_MULTIMODAL_INPUT],
  output_modes: ['text/plain'],
  security_scopes: ['a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 0,
  enabled: 1,
  agent_tools: null,
  agent_workers: null,
};

const SUPERVISOR_ORCHESTRATION: A2ASkillDef = {
  id: 'supervisor-orchestration',
  name: 'Supervisor Orchestration',
  description:
    'Multi-agent supervisor that delegates to specialist workers: code execution, research, document analysis, image understanding, and computer use. Requires agents:delegate permission.',
  tags: ['supervisor', 'multi-agent', 'orchestration', 'voice', 'file', 'multimodal'],
  examples: [
    'Research the market and then write a report',
    'Analyse this CSV dataset and produce a chart',
    'Extract all tables from this PDF and load them into a database',
  ],
  input_modes: [...FULL_MULTIMODAL_INPUT],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:supervisor'],
  mode: 'supervisor',
  required_permission: 'agents:delegate',
  sort_order: 1,
  enabled: 1,
  agent_tools: null,
  agent_workers: [
    {
      name: 'code_executor',
      description:
        'Writes and executes Python code using cse_run_code / cse_run_data_analysis. Handles CSV, JSON, Excel, Parquet files and produces stdout output for downstream analysis.',
      tools: ['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format'],
      persona: 'agent',
    },
    {
      name: 'analyst',
      description:
        'Interprets code_executor output, derives business insights, and produces a clear final answer for the user.',
      tools: ['calculator', 'json_format', 'text_analysis', 'web_search', 'memory_recall'],
      persona: 'agent',
    },
    {
      name: 'researcher',
      description:
        'Searches the web and retrieves factual information to support analysis or answer knowledge questions.',
      tools: ['web_search', 'memory_recall', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'computer_use_worker',
      description:
        'Controls computer GUI via screenshot→action loop using the Computer Use API. Takes screenshots and performs clicks, typing, and scrolling to complete UI-based tasks.',
      tools: ['computer', 'bash', 'text_editor'],
      persona: 'agent',
    },
    {
      name: 'document_worker',
      description:
        'Processes and extracts content from documents: PDF, Word, Excel, and PowerPoint. Returns structured data including tables, text, and metadata for downstream use.',
      tools: ['file_read', 'pdf_extract', 'json_format', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'image_worker',
      description:
        'Understands and analyses images using vision models: object detection, OCR, chart interpretation, scene description, and visual question answering.',
      tools: ['json_format', 'text_analysis'],
      persona: 'agent',
    },
  ],
};

const ENSEMBLE_REASONING: A2ASkillDef = {
  id: 'ensemble-reasoning',
  name: 'Ensemble Reasoning',
  description:
    'Multiple independent agents vote/judge to produce a consensus answer. Best for high-stakes decisions requiring diverse perspectives. Requires agents:delegate permission.',
  tags: ['ensemble', 'multi-agent', 'consensus', 'voting'],
  examples: [
    'What is the best approach to caching in distributed systems?',
    'Evaluate these three architecture proposals and recommend the most scalable one',
  ],
  input_modes: [...FULL_MULTIMODAL_INPUT],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:ensemble'],
  mode: 'ensemble',
  required_permission: 'agents:delegate',
  sort_order: 2,
  enabled: 1,
  agent_tools: null,
  agent_workers: null,
};

// ── New skills added in m69 (mid-2026 taxonomy expansion) ────────────────────

const COMPUTER_USE: A2ASkillDef = {
  id: 'computer-use',
  name: 'Computer Use (CUA)',
  description:
    'Autonomous computer control via a screenshot→action loop using the Anthropic Computer Use API (claude-opus-4-8). Reads the screen, clicks, types, and scrolls to complete desktop GUI tasks without human intervention.',
  tags: ['computer-use', 'cua', 'automation', 'desktop', 'gui', 'rpa'],
  examples: [
    'Click the Submit button on the registration form',
    'Open Chrome and navigate to github.com/org/repo',
    'Fill in this spreadsheet template with the data below',
    'Download my account statement from the bank portal',
  ],
  input_modes: ['text/plain', 'image/png', 'image/jpeg', 'image/*'],
  output_modes: ['text/plain', 'image/png'],
  security_scopes: ['a2a:computer-use'],
  mode: 'agent',
  required_permission: 'computer_use:execute',
  sort_order: 10,
  enabled: 0, // Requires CUA tool infra + approved endpoint — not yet wired
  agent_tools: ['computer', 'bash', 'text_editor'],
  agent_workers: null,
};

const BROWSER_AUTOMATION: A2ASkillDef = {
  id: 'browser-automation',
  name: 'Browser Automation',
  description:
    'Programmatic browser control using Playwright. Navigates URLs, extracts page content, fills forms, captures screenshots, and handles JavaScript-heavy SPAs. Runs in an isolated sandbox container.',
  tags: ['browser', 'playwright', 'scraping', 'automation', 'web', 'spa'],
  examples: [
    'Scrape the pricing table from docs.example.com and return it as JSON',
    'Log in to my SaaS portal and download this month\'s invoice',
    'Take a full-page screenshot of landing page at URL X',
    'Fill and submit this web form with the following field values',
  ],
  input_modes: ['text/plain', 'text/html', 'text/uri-list', 'application/json'],
  output_modes: ['text/plain', 'text/html', 'image/png', 'application/json'],
  security_scopes: ['a2a:browser'],
  mode: 'agent',
  required_permission: 'browser:execute',
  sort_order: 11,
  enabled: 0, // Requires Playwright container/infra — not yet provisioned
  agent_tools: ['playwright_navigate', 'playwright_click', 'playwright_fill', 'playwright_screenshot'],
  agent_workers: null,
};

const CODE_EXECUTION: A2ASkillDef = {
  id: 'code-execution',
  name: 'Code Execution (CSE)',
  description:
    'Executes Python code in a sandboxed Code Sandbox Environment (CSE). Supports data analysis, visualisation, file processing, and package installation. Returns stdout, stderr, and any generated files (images, CSVs).',
  tags: ['code', 'python', 'cse', 'execution', 'sandbox', 'data-science', 'matplotlib'],
  examples: [
    'Run this Python script and return the output',
    'Analyse this CSV file with pandas and plot a histogram',
    'Calculate the Pearson correlation between columns A and B',
    'Install seaborn and generate a heatmap from this matrix',
  ],
  input_modes: [
    'text/plain', 'text/x-python', 'application/json',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
  ],
  output_modes: ['text/plain', 'application/json', 'image/png', 'text/csv'],
  security_scopes: ['a2a:code-execution', 'a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 12,
  enabled: 1,
  agent_tools: ['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format'],
  agent_workers: null,
};

const DOCUMENT_INTELLIGENCE: A2ASkillDef = {
  id: 'document-intelligence',
  name: 'Document Intelligence',
  description:
    'Deep understanding of structured and unstructured documents. Extracts tables, summarises long-form content, answers questions, and converts between formats. Handles PDF, Word, Excel, PowerPoint, HTML, and scanned images.',
  tags: ['document', 'pdf', 'word', 'excel', 'extraction', 'ocr', 'rag', 'summarisation'],
  examples: [
    'Extract all tables from this 80-page PDF contract',
    'Summarise this annual report in 5 executive bullet points',
    'What are the key obligations in clause 12 of this agreement?',
    'Convert this Word document to a structured JSON outline',
  ],
  input_modes: [
    'text/plain', 'text/html',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv', 'application/json',
    'image/png', 'image/jpeg', 'image/webp', 'image/*',
  ],
  output_modes: ['text/plain', 'application/json', 'text/csv'],
  security_scopes: ['a2a:document', 'a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 13,
  enabled: 1,
  agent_tools: ['file_read', 'pdf_extract', 'json_format', 'text_analysis', 'cse_run_code'],
  agent_workers: null,
};

const IMAGE_ANALYSIS: A2ASkillDef = {
  id: 'image-analysis',
  name: 'Image Analysis',
  description:
    'Multimodal image understanding: object detection, scene description, OCR on scanned documents, chart and diagram interpretation, and visual question answering. Powered by vision-capable frontier models.',
  tags: ['vision', 'image', 'ocr', 'multimodal', 'visual-qa', 'chart', 'diagram'],
  examples: [
    'Describe this photo in detail, including all visible objects',
    'Extract the text from this scanned handwritten note',
    'What does this bar chart show? List all values per category',
    'Identify any defects visible in this product inspection photo',
  ],
  input_modes: ['text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/*'],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:image:read', 'a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 14,
  enabled: 1,
  agent_tools: ['json_format', 'text_analysis'],
  agent_workers: null,
};

const IMAGE_GENERATION: A2ASkillDef = {
  id: 'image-generation',
  name: 'Image Generation',
  description:
    'Text-to-image and image-to-image generation using diffusion models. Produces photorealistic, artistic, or diagrammatic images from natural language prompts. Supports style reference images and iterative refinement.',
  tags: ['image-gen', 'text-to-image', 'diffusion', 'dall-e', 'stable-diffusion', 'creative'],
  examples: [
    'Generate a photorealistic image of a mountain lake at sunset',
    'Create a minimalist logo for a company called WeaveIntel, white on dark background',
    'Transform this product photo into a watercolour painting',
    'Generate 4 variations of this sketch in different art styles',
  ],
  input_modes: ['text/plain', 'image/png', 'image/jpeg', 'image/*'],
  output_modes: ['image/png', 'image/jpeg', 'image/webp'],
  security_scopes: ['a2a:image:write'],
  mode: 'agent',
  required_permission: 'image_gen:create',
  sort_order: 15,
  enabled: 0, // No image generation model configured in mid-2026 deployment
  agent_tools: null,
  agent_workers: null,
};

const VOICE_INTERACTION: A2ASkillDef = {
  id: 'voice-interaction',
  name: 'Voice Interaction',
  description:
    'Real-time speech-to-text and text-to-speech interaction. Handles voice notes, live audio transcription, and voice-driven agent sessions via WebRTC or WebSocket. Supports 30+ languages.',
  tags: ['voice', 'audio', 'speech', 'realtime', 'tts', 'stt', 'whisper', 'webrtc'],
  examples: [
    'Transcribe this voice note and draft a response',
    'Have a voice conversation with me — respond in English',
    'Read out this legal document in a calm, professional tone',
    'Translate this French audio clip into English text',
  ],
  input_modes: [
    'text/plain',
    'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/*',
  ],
  output_modes: ['text/plain', 'audio/wav', 'audio/mpeg', 'audio/webm'],
  security_scopes: ['a2a:voice', 'a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 16,
  enabled: 1,
  agent_tools: ['text_analysis', 'json_format'],
  agent_workers: null,
};

const DATA_PIPELINE: A2ASkillDef = {
  id: 'data-pipeline',
  name: 'Data Pipeline',
  description:
    'Supervised multi-agent data pipeline: ingest raw data, clean, transform, validate schemas, and export to a target format or destination. Orchestrates code_executor, data_validator, and analyst workers.',
  tags: ['data', 'etl', 'pipeline', 'transform', 'data-science', 'pandas', 'polars'],
  examples: [
    'Clean and normalise this messy CSV dataset; remove duplicates and fix date formats',
    'Join these two Excel files on customer_id, aggregate by month, and return as CSV',
    'Validate this JSON dataset against this schema and report all violations',
    'Transform raw event logs into a daily summary table',
  ],
  input_modes: [
    'text/plain', 'text/csv', 'application/json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
  ],
  output_modes: ['text/plain', 'text/csv', 'application/json'],
  security_scopes: ['a2a:data-pipeline', 'a2a:supervisor'],
  mode: 'supervisor',
  required_permission: 'agents:delegate',
  sort_order: 17,
  enabled: 1,
  agent_tools: null,
  agent_workers: [
    {
      name: 'code_executor',
      description:
        'Ingests and transforms data using pandas, polars, or SQLAlchemy. Executes Python scripts, handles file I/O, and reports row/column level statistics.',
      tools: ['cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'json_format'],
      persona: 'agent',
    },
    {
      name: 'data_validator',
      description:
        'Validates data quality: checks schema conformance, null rates, type correctness, referential integrity, and distribution anomalies. Reports violations as structured JSON.',
      tools: ['cse_run_code', 'json_format', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'analyst',
      description:
        'Interprets pipeline results, generates data quality reports, and summarises key insights from the transformed dataset.',
      tools: ['calculator', 'json_format', 'text_analysis'],
      persona: 'agent',
    },
  ],
};

const MEMORY_RETRIEVAL: A2ASkillDef = {
  id: 'memory-retrieval',
  name: 'Memory Retrieval',
  description:
    'Semantic memory search and retrieval across episodic, semantic, and procedural memory stores. Recalls past conversations, user facts, decisions, and procedural knowledge using vector similarity search.',
  tags: ['memory', 'rag', 'retrieval', 'semantic-search', 'episodic', 'vector'],
  examples: [
    'What did I tell you about my AWS migration project last week?',
    'Find all past decisions related to the database architecture',
    'Recall my writing style preferences',
    'List all tasks I assigned to the team in the last sprint',
  ],
  input_modes: ['text/plain', 'application/json'],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:memory:read', 'a2a:chat'],
  mode: 'agent',
  required_permission: null,
  sort_order: 18,
  enabled: 1,
  agent_tools: ['memory_recall', 'memory_list_episodes', 'memory_get_profile', 'text_analysis', 'json_format'],
  agent_workers: null,
};

const WORKFLOW_ORCHESTRATION: A2ASkillDef = {
  id: 'workflow-orchestration',
  name: 'Workflow Orchestration',
  description:
    'Triggers and monitors multi-step durable workflows. Coordinates dependent steps, handles retries with exponential backoff, and reports progress in real time. Integrates with the native durable workflow engine.',
  tags: ['workflow', 'orchestration', 'automation', 'durable', 'multi-step', 'cron'],
  examples: [
    'Run the monthly financial report generation workflow',
    'Start an onboarding workflow for new user alice@example.com',
    'Check the status of workflow run WF-2026-001 and resume it if paused',
    'Schedule a weekly data sync workflow to run every Monday at 08:00 UTC',
  ],
  input_modes: ['text/plain', 'application/json'],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:workflow', 'a2a:supervisor'],
  mode: 'supervisor',
  required_permission: 'workflows:execute',
  sort_order: 19,
  enabled: 1,
  agent_tools: null,
  agent_workers: [
    {
      name: 'orchestrator',
      description:
        'Manages workflow execution lifecycle: triggers steps, monitors completion status, handles retries, and aggregates results into a final progress report.',
      tools: ['json_format', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'executor',
      description:
        'Executes individual workflow steps using the appropriate tool set and reports outcomes back to the orchestrator.',
      tools: ['cse_run_code', 'web_search', 'json_format', 'memory_recall'],
      persona: 'agent',
    },
  ],
};

const RESEARCH_SYNTHESIS: A2ASkillDef = {
  id: 'research-synthesis',
  name: 'Research & Synthesis',
  description:
    'Deep multi-agent research across web, documents, and internal knowledge bases. A supervisor delegates to researcher, analyst, and writer workers to produce a structured, cited report with executive summary and recommendations.',
  tags: ['research', 'synthesis', 'report', 'web-search', 'multi-agent', 'literature'],
  examples: [
    'Research the competitive landscape of enterprise AI orchestration platforms in 2026',
    'Write a 5-page analysis of quantum computing hardware trends with citations',
    'Analyse this market and identify the top 3 growth opportunities',
    'Summarise the academic literature on transformer attention mechanisms published since 2024',
  ],
  input_modes: ['text/plain', 'application/pdf', 'application/json', 'text/html'],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:research', 'a2a:supervisor'],
  mode: 'supervisor',
  required_permission: 'agents:delegate',
  sort_order: 20,
  enabled: 1,
  agent_tools: null,
  agent_workers: [
    {
      name: 'researcher',
      description:
        'Searches the web, academic databases, and internal knowledge bases for primary sources, evidence, and supporting data.',
      tools: ['web_search', 'memory_recall', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'analyst',
      description:
        'Critically evaluates research findings: identifies contradictions, data quality issues, key themes, and statistical significance.',
      tools: ['calculator', 'json_format', 'text_analysis', 'web_search'],
      persona: 'agent',
    },
    {
      name: 'writer',
      description:
        'Synthesises research into a structured, well-cited report with executive summary, detailed findings, and actionable recommendations.',
      tools: ['json_format', 'text_analysis'],
      persona: 'agent',
    },
  ],
};

const HYPOTHESIS_VALIDATION: A2ASkillDef = {
  id: 'hypothesis-validation',
  name: 'Hypothesis Validation',
  description:
    'Scientific hypothesis validation using ensemble consensus. Multiple independent agents (statistician, domain expert, critic) evaluate evidence, run statistical tests, and vote on the hypothesis verdict with explicit confidence levels.',
  tags: ['science', 'validation', 'hypothesis', 'ensemble', 'statistics', 'research', 'p-value'],
  examples: [
    'Is there a statistically significant correlation between X and Y in this dataset?',
    'Validate the null hypothesis that treatment A causes no improvement in outcome B',
    'Evaluate this clinical trial claim against the provided evidence and literature',
    'Check whether this A/B test result is statistically significant (p < 0.05)',
  ],
  input_modes: ['text/plain', 'application/json', 'text/csv', 'application/pdf'],
  output_modes: ['text/plain', 'application/json'],
  security_scopes: ['a2a:science', 'a2a:ensemble'],
  mode: 'ensemble',
  required_permission: 'agents:delegate',
  sort_order: 21,
  enabled: 1,
  agent_tools: null,
  agent_workers: [
    {
      name: 'statistician',
      description:
        'Evaluates statistical evidence: checks p-values, effect sizes, confidence intervals, sample size adequacy, and study design validity.',
      tools: ['cse_run_code', 'calculator', 'json_format'],
      persona: 'agent',
    },
    {
      name: 'domain_expert',
      description:
        'Assesses scientific plausibility from the domain perspective: checks for confounders, prior literature support, and mechanistic plausibility.',
      tools: ['web_search', 'memory_recall', 'text_analysis'],
      persona: 'agent',
    },
    {
      name: 'critic',
      description:
        'Plays devil\'s advocate: searches for disconfirming evidence, alternative hypotheses, replication failures, and methodological flaws.',
      tools: ['web_search', 'text_analysis'],
      persona: 'agent',
    },
  ],
};

// ── Public catalog ────────────────────────────────────────────────────────────

/**
 * All 15 A2A skills — 3 original (m60) + 12 new (m69).
 * The 3 existing skills reflect their post-m69 state (updated MIME types and agent_workers).
 */
export const A2A_SKILL_CATALOG: readonly A2ASkillDef[] = [
  // Existing (m60 origin, m69 updated)
  GENERAL_CHAT,
  SUPERVISOR_ORCHESTRATION,
  ENSEMBLE_REASONING,
  // New in m69
  COMPUTER_USE,
  BROWSER_AUTOMATION,
  CODE_EXECUTION,
  DOCUMENT_INTELLIGENCE,
  IMAGE_ANALYSIS,
  IMAGE_GENERATION,
  VOICE_INTERACTION,
  DATA_PIPELINE,
  MEMORY_RETRIEVAL,
  WORKFLOW_ORCHESTRATION,
  RESEARCH_SYNTHESIS,
  HYPOTHESIS_VALIDATION,
];

/** The 12 skills first introduced in m69 (new in mid-2026 taxonomy expansion). */
export const A2A_NEW_SKILLS_V2: readonly A2ASkillDef[] = [
  COMPUTER_USE,
  BROWSER_AUTOMATION,
  CODE_EXECUTION,
  DOCUMENT_INTELLIGENCE,
  IMAGE_ANALYSIS,
  IMAGE_GENERATION,
  VOICE_INTERACTION,
  DATA_PIPELINE,
  MEMORY_RETRIEVAL,
  WORKFLOW_ORCHESTRATION,
  RESEARCH_SYNTHESIS,
  HYPOTHESIS_VALIDATION,
];

/**
 * The 3 new workers added to supervisor-orchestration in m69.
 * Exported for use in the migration and tests.
 */
export const SUPERVISOR_V2_WORKERS: readonly A2AWorkerDef[] = [
  {
    name: 'computer_use_worker',
    description:
      'Controls computer GUI via screenshot→action loop using the Computer Use API. Takes screenshots and performs clicks, typing, and scrolling to complete UI-based tasks.',
    tools: ['computer', 'bash', 'text_editor'],
    persona: 'agent',
  },
  {
    name: 'document_worker',
    description:
      'Processes and extracts content from documents: PDF, Word, Excel, and PowerPoint. Returns structured data including tables, text, and metadata for downstream use.',
    tools: ['file_read', 'pdf_extract', 'json_format', 'text_analysis'],
    persona: 'agent',
  },
  {
    name: 'image_worker',
    description:
      'Understands and analyses images using vision models: object detection, OCR, chart interpretation, scene description, and visual question answering.',
    tools: ['json_format', 'text_analysis'],
    persona: 'agent',
  },
];

/** New MIME types added to existing skills' input_modes in m69. */
export const M69_NEW_INPUT_MIME_TYPES: readonly string[] = [
  'video/mp4', 'video/webm', 'video/ogg', 'video/*',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/**
 * Convert an A2ASkillDef to the DB row shape expected by the a2a_skills table.
 * All array fields are JSON-serialised to strings.
 */
export function mapA2ASkillToRow(s: A2ASkillDef): {
  id: string; name: string; description: string;
  tags: string; examples: string;
  input_modes: string; output_modes: string;
  security_scopes: string; mode: string;
  required_permission: string | null;
  sort_order: number; enabled: number;
  agent_tools: string | null; agent_workers: string | null;
} {
  return {
    id:                 s.id,
    name:               s.name,
    description:        s.description,
    tags:               JSON.stringify(s.tags),
    examples:           JSON.stringify(s.examples),
    input_modes:        JSON.stringify(s.input_modes),
    output_modes:       JSON.stringify(s.output_modes),
    security_scopes:    JSON.stringify(s.security_scopes),
    mode:               s.mode,
    required_permission: s.required_permission,
    sort_order:         s.sort_order,
    enabled:            s.enabled,
    agent_tools:        s.agent_tools ? JSON.stringify(s.agent_tools) : null,
    agent_workers:      s.agent_workers ? JSON.stringify(s.agent_workers) : null,
  };
}
