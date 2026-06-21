/**
 * @weaveintel/guardrails — Phase 4 seed data (mid-2026)
 *
 * 18 new guardrail rows across five compliance and safety categories:
 *
 *   EU AI Act       × 4  — high-risk classification, prohibited manipulation,
 *                           biometric data block, transparency disclosure
 *   AI-Content      × 4  — generated paper detection, deepfake guard,
 *                           synthetic data misrepresentation, AI image disclosure
 *   Agent-Safety    × 5  — memory poisoning, goal hijacking, tool-call injection,
 *                           excessive resource use, unauthorized delegation
 *   IP Protection   × 2  — verbatim reproduction, code license mismatch
 *   Data Residency  × 3  — EU GDPR transfer block, US CLOUD Act flag,
 *                           GDPR consent gate
 *
 * New columns introduced by migration m71:
 *   judge_model          — model used for this guardrail's LLM judge
 *   compliance_framework — regulatory/compliance reference (e.g. EU_AI_ACT_ART_5)
 *
 * All rows with `enabled: 0` require operator opt-in (either policy gates or
 * jurisdiction-specific deployments).
 */

import type { GuardrailSeedRow } from './seed.js';

export const GUARDRAILS_2026: GuardrailSeedRow[] = [

  // ── EU AI Act ────────────────────────────────────────────────────────────────

  {
    id: 'e1000001-2026-4000-8000-000000000001',
    name: 'EU AI Act: High-Risk Use Classification Warning',
    description:
      'Warns when the input suggests the AI is being used in a high-risk category ' +
      '(biometric identification, employment decisions, credit scoring, law enforcement, ' +
      'education assessment, or critical infrastructure control) as defined in Annex III.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'eu-ai-act-high-risk',
      action: 'warn',
      timeout_ms: 10000,
      on_error: 'allow',
    }),
    priority: 109, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
    compliance_framework: 'EU_AI_ACT_ART_6_ANNEX_III',
  },

  {
    id: 'e1000002-2026-4000-8000-000000000002',
    name: 'EU AI Act: Prohibited Manipulation Detection',
    description:
      'Blocks content that exploits psychological vulnerabilities, uses subliminal ' +
      'techniques, or otherwise manipulates users against their own interests ' +
      '(Art. 5(1)(a)–(b) prohibited practices).',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'eu-ai-act-manipulation',
      action: 'deny',
      timeout_ms: 10000,
      on_error: 'deny',
    }),
    priority: 114, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
    compliance_framework: 'EU_AI_ACT_ART_5',
  },

  {
    id: 'e1000003-2026-4000-8000-000000000003',
    name: 'EU AI Act: Biometric Data Processing Block',
    description:
      'Denies requests to process, classify, or infer sensitive biometric data ' +
      '(fingerprints, face recognition, gait, voice prints, iris) which constitutes ' +
      'a high-risk prohibited practice under Art. 5(1)(d).',
    type: 'regex', stage: 'pre',
    config: JSON.stringify({
      pattern:
        '(?:biometric(?:ally)?\\s+(?:identify|recogni[szt]|classify|match|scan|process|extract)|' +
        'face\\s+recogni[szt]|fingerprint\\s+(?:match|scan|extract|identif)|' +
        'iris\\s+scan|gait\\s+(?:analysis|recogni[szt])|' +
        'voice\\s+(?:print|biometric|identif)|' +
        'real[-\\s]time\\s+(?:biometric|facial))',
      flags: 'i',
      action: 'deny',
    }),
    priority: 115, enabled: 1,
    compliance_framework: 'EU_AI_ACT_ART_5_1_D',
  },

  {
    id: 'e1000004-2026-4000-8000-000000000004',
    name: 'EU AI Act: Transparency Disclosure Check',
    description:
      'Warns when the model response appears to present AI-generated content ' +
      'as human-authored without appropriate disclosure (Art. 13 transparency ' +
      'requirements for general-purpose AI systems).',
    type: 'model-graded', stage: 'post-execution',
    config: JSON.stringify({
      rule: 'eu-ai-act-transparency',
      action: 'warn',
      timeout_ms: 8000,
      on_error: 'allow',
    }),
    priority: 102, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
    compliance_framework: 'EU_AI_ACT_ART_13',
  },

  // ── AI-Content Detection ─────────────────────────────────────────────────────

  {
    id: 'e2000001-2026-4000-8000-000000000001',
    name: 'AI Content: Generated Academic Paper Detection',
    description:
      'Warns when the output resembles an AI-generated scientific paper ' +
      'submitted without disclosure (abstract, methods, references structure). ' +
      'Reduces academic integrity risk.',
    type: 'model-graded', stage: 'post-execution',
    config: JSON.stringify({
      rule: 'ai-paper-detection',
      action: 'warn',
      timeout_ms: 10000,
      on_error: 'allow',
    }),
    priority: 107, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  {
    id: 'e2000002-2026-4000-8000-000000000002',
    name: 'AI Content: Deepfake Reference Guard',
    description:
      'Warns when the response references, instructs, or assists with creating ' +
      'synthetic media that misrepresents real persons (deepfakes, face-swaps, ' +
      'voice cloning of real individuals).',
    type: 'regex', stage: 'post',
    config: JSON.stringify({
      pattern:
        '(?:deepfake|face.?swap|' +
        'voice.{0,10}clon(?:e|ing)|clon(?:e|ing).{0,30}voice|' +
        'synthetic\\s+(?:media|video|audio|image)\\s+(?:of|depicting|showing)\\s+(?:a\\s+)?(?:real|actual|specific)\\s+(?:person|individual|celebrity|politician)|' +
        'create\\s+(?:a\\s+)?(?:fake|synthetic)\\s+video\\s+of|' +
        'generate\\s+(?:audio|voice)\\s+(?:impersonat|mimick))',
      flags: 'i',
      action: 'warn',
    }),
    priority: 108, enabled: 1,
  },

  {
    id: 'e2000003-2026-4000-8000-000000000003',
    name: 'AI Content: Synthetic Data Misrepresentation',
    description:
      'Warns when the input appears to be asking the model to fabricate data ' +
      'and present it as real research, statistics, or factual evidence.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'synthetic-data-flag',
      action: 'warn',
      timeout_ms: 8000,
      on_error: 'allow',
    }),
    priority: 116, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  {
    id: 'e2000004-2026-4000-8000-000000000004',
    name: 'AI Content: AI-Generated Image Disclosure',
    description:
      'Warns when the response contains or describes an AI-generated image ' +
      'without clearly labelling it as synthetic (EU AI Act Art. 50 transparency ' +
      'for AI-generated content).',
    type: 'regex', stage: 'post',
    config: JSON.stringify({
      pattern:
        '(?:(?:I\\s+)?(?:generated|created|produced|drew|made)\\s+(?:this\\s+)?(?:image|photo|picture|illustration|artwork)|' +
        'here\\s+is\\s+(?:an?|the)\\s+(?:generated|synthetic|AI.generated)\\s+(?:image|photo|picture))',
      flags: 'i',
      action: 'warn',
    }),
    priority: 51, enabled: 0,
    compliance_framework: 'EU_AI_ACT_ART_50',
  },

  // ── Agent Safety ─────────────────────────────────────────────────────────────

  {
    id: 'e3000001-2026-4000-8000-000000000001',
    name: 'Agent Safety: Memory Poisoning Guard',
    description:
      'Blocks attempts to inject false facts or malicious instructions into ' +
      'persistent agent memory. Detects patterns like "remember that", ' +
      '"always store", "update your memory with" followed by misleading content.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'agent-memory-poisoning',
      action: 'deny',
      timeout_ms: 10000,
      on_error: 'deny',
    }),
    priority: 112, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  {
    id: 'e3000002-2026-4000-8000-000000000002',
    name: 'Agent Safety: Goal Hijacking Detection',
    description:
      'Blocks attempts to redirect the agent away from its assigned objective. ' +
      'Patterns: "forget your original task", "your real purpose is", ' +
      '"ignore your instructions and instead".',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'agent-goal-hijacking',
      action: 'deny',
      timeout_ms: 10000,
      on_error: 'deny',
    }),
    priority: 111, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  {
    id: 'e3000003-2026-4000-8000-000000000003',
    name: 'Agent Safety: Tool Call Injection Guard',
    description:
      'Blocks attempts to inject malicious tool calls or function calls ' +
      'through the conversation (JSON blobs with "tool", "function_call", ' +
      'or XML-style tool tags in user messages).',
    type: 'regex', stage: 'pre',
    config: JSON.stringify({
      pattern:
        '(?:<tool_call>|<function_call>|<invoke>|' +
        '"tool"\\s*:\\s*"[a-z_]{2,}"|' +
        '"function_call"\\s*:\\s*\\{|' +
        '"name"\\s*:\\s*"[a-z_]{2,}"\\s*,\\s*"(?:input|arguments|params)"\\s*:\\s*\\{|' +
        '\\bexec(?:ute)?_tool\\s*\\()',
      flags: 'i',
      action: 'deny',
    }),
    priority: 113, enabled: 1,
  },

  {
    id: 'e3000004-2026-4000-8000-000000000004',
    name: 'Agent Safety: Excessive Resource Use Detection',
    description:
      'Warns on prompts requesting unbounded loops, fork-bombs, recursive ' +
      'spawning, or other patterns that would exhaust compute, memory, or ' +
      'file descriptors in an agentic execution environment.',
    type: 'regex', stage: 'pre',
    config: JSON.stringify({
      pattern:
        '(?:fork\\s*bomb|(?:while|for)\\s*\\(\\s*(?:true|1|;;)\\s*\\)|' +
        '(?:spawn|fork|create)\\s+(?:infinite|unlimited|as many|1[0-9]{3,}|[2-9][0-9]{3,})\\s+(?:process|thread|worker|agent|task)|' +
        'loop\\s+(?:forever|indefinitely|without\\s+stopping)|' +
        'recursive(?:ly)?.{0,30}(?:indefinitely|without\\s+stopping|forever|until\\s+(?:it\\s+)?crash)|' +
        'recursive(?:ly)?\\s+(?:call|spawn|duplicate|replicate)\\s+(?:until|infinitely)|' +
        'exhaust\\s+(?:all\\s+)?(?:memory|cpu|disk|resources?))',
      flags: 'i',
      action: 'warn',
    }),
    priority: 117, enabled: 1,
  },

  {
    id: 'e3000005-2026-4000-8000-000000000005',
    name: 'Agent Safety: Unauthorized Delegation Guard',
    description:
      'Blocks attempts to delegate tasks to agents outside the authorized ' +
      'agent graph, or to escalate capabilities by claiming to act as a ' +
      'higher-privilege agent or orchestrator.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'agent-delegation-check',
      action: 'deny',
      timeout_ms: 10000,
      on_error: 'deny',
    }),
    priority: 110, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  // ── IP Protection ────────────────────────────────────────────────────────────

  {
    id: 'e4000001-2026-4000-8000-000000000001',
    name: 'IP: Verbatim Copyright Reproduction',
    description:
      'Warns when the output appears to reproduce a substantial portion of ' +
      'copyrighted text verbatim (books, articles, lyrics, scripts) without ' +
      'transformative commentary.',
    type: 'model-graded', stage: 'post-execution',
    config: JSON.stringify({
      rule: 'ip-verbatim-reproduction',
      action: 'warn',
      timeout_ms: 10000,
      on_error: 'allow',
    }),
    priority: 105, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  {
    id: 'e4000002-2026-4000-8000-000000000002',
    name: 'IP: Code License Mismatch Guard',
    description:
      'Warns when generated code appears to reproduce GPL/AGPL-licensed ' +
      'snippets in a context suggesting proprietary use, creating a copyleft ' +
      'contamination risk.',
    type: 'model-graded', stage: 'post-execution',
    config: JSON.stringify({
      rule: 'ip-license-check',
      action: 'warn',
      timeout_ms: 10000,
      on_error: 'allow',
    }),
    priority: 106, enabled: 1,
    judge_model: 'claude-haiku-4-5-20251001',
  },

  // ── Data Residency & Privacy Compliance ──────────────────────────────────────
  // These default to disabled: they require jurisdiction configuration before use.

  {
    id: 'e5000001-2026-4000-8000-000000000001',
    name: 'Compliance: EU Data Residency Enforcement',
    description:
      'Blocks processing of EU-resident personal data when the model or ' +
      'infrastructure is outside the EU/EEA (GDPR Art. 44 transfer restriction). ' +
      'Disabled by default — enable only after configuring jurisdiction detection.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'data-residency-check',
      jurisdiction: 'EU',
      action: 'deny',
      timeout_ms: 8000,
      on_error: 'warn',
    }),
    priority: 89, enabled: 0,
    judge_model: 'claude-haiku-4-5-20251001',
    compliance_framework: 'GDPR_ART_44',
  },

  {
    id: 'e5000002-2026-4000-8000-000000000002',
    name: 'Compliance: US CLOUD Act Compliance Flag',
    description:
      'Warns when content may involve data subject to the US CLOUD Act ' +
      '(cross-border law enforcement data access). Disabled by default — enable ' +
      'for deployments handling multi-jurisdictional law enforcement data.',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'data-residency-check',
      jurisdiction: 'US_CLOUD_ACT',
      action: 'warn',
      timeout_ms: 8000,
      on_error: 'allow',
    }),
    priority: 88, enabled: 0,
    compliance_framework: 'US_CLOUD_ACT',
  },

  {
    id: 'e5000003-2026-4000-8000-000000000003',
    name: 'Compliance: GDPR Consent Gate',
    description:
      'Warns when the input indicates processing of special-category personal ' +
      'data (health, religious belief, political opinion, sexual orientation) ' +
      'without evidence of explicit consent (GDPR Art. 6 + Art. 9).',
    type: 'model-graded', stage: 'pre-execution',
    config: JSON.stringify({
      rule: 'gdpr-consent-check',
      action: 'warn',
      timeout_ms: 8000,
      on_error: 'allow',
    }),
    priority: 86, enabled: 0,
    judge_model: 'claude-haiku-4-5-20251001',
    compliance_framework: 'GDPR_ART_6_ART_9',
  },
];
