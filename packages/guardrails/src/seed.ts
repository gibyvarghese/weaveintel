/**
 * @weaveintel/guardrails — Default seed data
 *
 * Export: `DEFAULT_GUARDRAILS` — 12 framework guardrail rows covering PII,
 * toxicity, token budget, cognitive checks, and prompt-injection guards.
 *
 * These are plain typed objects with no DB or runtime dependency.
 * Import in your app seed and call `db.createGuardrail()` for each row.
 *
 * @example
 * ```ts
 * import { DEFAULT_GUARDRAILS } from '@weaveintel/guardrails';
 * const existing = await db.listGuardrails();
 * if (existing.length === 0) {
 *   for (const g of DEFAULT_GUARDRAILS) await db.createGuardrail(g);
 * }
 * ```
 */

export type GuardrailSeedRow = {
  id: string;
  name: string;
  description: string;
  type: string;
  stage: string;
  config: string;
  priority: number;
  enabled: 0 | 1;
};

export const DEFAULT_GUARDRAILS: GuardrailSeedRow[] = [
  {
    id: '0370fa22-5fc8-49a4-bd4c-3e39863da61d',
    name: 'PII Redaction',
    description: 'Redact personal identifiable information before sending to LLM',
    type: 'redaction', stage: 'pre',
    config: JSON.stringify({ patterns: ['email', 'phone', 'ssn', 'credit_card'] }),
    priority: 100, enabled: 1,
  },
  {
    id: '51586988-83b7-4780-a006-b3b86b76713f',
    name: 'Toxicity Filter',
    description: 'Block toxic or harmful content in responses',
    type: 'content_filter', stage: 'post',
    config: JSON.stringify({ threshold: 0.7, categories: ['hate', 'violence', 'self_harm'] }),
    priority: 90, enabled: 1,
  },
  {
    id: '7c8988ba-b7c9-4e52-8139-732e5c922a25',
    name: 'Prompt Injection: Directive Override',
    description: 'Block attempts to override system or developer instructions',
    type: 'content_filter', stage: 'pre',
    config: JSON.stringify({
      words: [
        'ignore previous instructions',
        'disregard previous instructions',
        'forget all prior instructions',
        'override system prompt',
        'ignore system prompt',
        'ignore developer instructions',
        'jailbreak',
        'do anything now',
      ],
      action: 'deny',
    }),
    priority: 95, enabled: 1,
  },
  {
    id: '0eb8ae21-e411-4dae-921f-3f91651619d9',
    name: 'Prompt Injection: Prompt Exfiltration',
    description: 'Block attempts to extract hidden prompts or policies',
    type: 'regex', stage: 'pre',
    config: JSON.stringify({
      pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
      flags: 'i',
      action: 'deny',
    }),
    priority: 94, enabled: 1,
  },
  {
    id: '1a6b5225-07c6-41cc-878f-c0d08930c1de',
    name: 'Token Budget',
    description: 'Enforce maximum token usage per request',
    type: 'budget', stage: 'pre',
    config: JSON.stringify({ max_input_tokens: 8000, max_output_tokens: 4000 }),
    priority: 80, enabled: 1,
  },
  {
    id: '8ae24528-463a-4dfa-9348-a2be5214de9f',
    name: 'Hallucination Check',
    description: 'Flag responses that may contain fabricated information',
    type: 'factuality', stage: 'post',
    config: JSON.stringify({ confidence_threshold: 0.6, require_citations: false }),
    priority: 70, enabled: 0,
  },
  {
    id: '58897b64-39ca-457c-8e8b-8ce4ffc33aa5',
    name: 'Cognitive Pre: Sycophancy Pressure',
    description: 'Detect prompts that push for agreement over truth before generation',
    type: 'cognitive_check', stage: 'pre',
    config: JSON.stringify({ check: 'pre_sycophancy', pattern: "\\b(agree with me|just agree|say yes|validate me|don't challenge|no criticism)\\b", warn_confidence: 0.62, allow_confidence: 0.86 }),
    priority: 65, enabled: 1,
  },
  {
    id: '70469180-6265-47d8-82c6-ee3cec180bc6',
    name: 'Cognitive Pre: Confidence Gate',
    description: 'Apply risk-aware confidence gate before generation',
    type: 'cognitive_check', stage: 'pre',
    config: JSON.stringify({ check: 'pre_confidence', gate_threshold: 0.65, gate_on_fail: 'warn', medium_risk_confidence: 0.72, high_risk_confidence: 0.6, critical_risk_confidence: 0.5, low_risk_confidence: 0.82 }),
    priority: 64, enabled: 1,
  },
  {
    id: 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf',
    name: 'Cognitive Post: Grounding',
    description: 'Check lexical grounding between prompt and response',
    type: 'cognitive_check', stage: 'post',
    config: JSON.stringify({ check: 'post_grounding', min_overlap: 0.06 }),
    priority: 63, enabled: 1,
  },
  {
    id: 'f9e2ec15-8243-4884-9056-a5cf79af9800',
    name: 'Cognitive Post: Sycophancy Phrasing',
    description: 'Detect strong sycophantic phrasing in assistant output',
    type: 'cognitive_check', stage: 'post',
    config: JSON.stringify({ check: 'post_sycophancy', pattern: "\\b(you are absolutely right|exactly right|totally correct|you are 100% right)\\b", warn_confidence: 0.58, allow_confidence: 0.86 }),
    priority: 62, enabled: 1,
  },
  {
    id: 'af3ed9ac-b3ca-4d10-bf80-678e4a750389',
    name: "Cognitive Post: Devil's Advocate",
    description: 'Ensure decision-style queries include counterpoints and trade-offs',
    type: 'cognitive_check', stage: 'post',
    config: JSON.stringify({ check: 'post_devils_advocate', needs_pattern: "\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b", has_pattern: "\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b", warn_confidence: 0.6, allow_confidence: 0.84 }),
    priority: 61, enabled: 1,
  },
  {
    id: '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd',
    name: 'Cognitive Post: Confidence Gate',
    description: 'Apply post-response confidence gate for outcome signaling',
    type: 'cognitive_check', stage: 'post',
    config: JSON.stringify({ check: 'post_confidence', gate_threshold: 0.67, gate_on_fail: 'warn' }),
    priority: 60, enabled: 1,
  },
];
