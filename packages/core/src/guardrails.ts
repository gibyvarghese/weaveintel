/**
 * @weaveintel/core — Guardrail & governance contracts
 */
import type { Model, EmbeddingModel } from './models.js';
import type { ModerationModel } from './moderation.js';

// ─── Guardrail ───────────────────────────────────────────────

/**
 * M-8: `'skipped'` is a distinct outcome for guardrails that were bypassed
 * (budget exhausted, condition not met) rather than actively evaluated.
 * Callers with a strict security posture should treat `'skipped'` as `'deny'`
 * via the `budgetExhaustedPolicy` pipeline option; lenient callers can treat it
 * as `'allow'`. Never conflate `'skipped'` with `'allow'` in audit logs — the
 * guardrail did not actually pass, it was never run.
 */
export type GuardrailDecision = 'allow' | 'deny' | 'warn' | 'skipped';
export type GuardrailStage = 'pre-execution' | 'mid-execution' | 'post-execution';
export type GuardrailType = 'regex' | 'blocklist' | 'length' | 'schema' | 'model-graded' | 'custom';

export interface GuardrailResult {
  decision: GuardrailDecision;
  guardrailId: string;
  explanation?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface GuardrailEvaluationContext {
  userInput?: string;
  assistantOutput?: string;
  /** Tool call / delegation results that ground the assistant's response. When present,
   *  the grounding-overlap check uses this as the reference instead of the raw userInput,
   *  since a tool-backed answer is factually grounded regardless of lexical similarity to the query. */
  toolEvidence?: string;
  action?: string;
  previousResults?: GuardrailResult[];
  metadata?: Record<string, unknown>;
}

// ─── Condition system ────────────────────────────────────────

/**
 * JSON-serialisable condition tree that controls when a guardrail fires.
 * null / absent means "always run" (backward-compatible default).
 * Composition nodes short-circuit: `any` stops on first true, `all` stops on first false.
 */
export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode }
  | { chat_mode: string[] }
  | { persona: string[] }
  | { risk_level: string[] }
  | { prior_has_warn: boolean }
  | { prior_has_cognitive_warn: boolean }
  | { prior_has_injection_warn: boolean }
  | { turn_has_tool_calls: boolean }
  | { turn_number_gt: number }
  | { input_length_gt: number }
  | { input_has_code: boolean }
  | { input_has_urls: boolean }
  | { input_has_base64: boolean }
  | { input_has_structured_data: boolean }
  | { input_has_decision_language: boolean }
  | { input_has_validation_seeking: boolean }
  | { input_has_factual_question: boolean }
  | { input_has_instruction_override: boolean }
  | { input_has_sensitive_pattern: boolean }
  | { output_length_gt: number }
  | { output_has_code_blocks: boolean }
  | { output_has_factual_claims: boolean }
  | { output_has_advice: boolean }
  | { output_has_credential_patterns: boolean }
  | { output_has_tool_evidence: boolean }
  | { output_has_urls: boolean }
  | { tool_category_in: string[] };

export interface Guardrail {
  id: string;
  name: string;
  description?: string;
  type: GuardrailType;
  stage: GuardrailStage;
  enabled: boolean;
  config: Record<string, unknown>;
  priority?: number;
  /** JSON condition tree. null/absent = always run. */
  triggerConditions?: ConditionNode | null;
  /** Human-readable summary of the condition shown in the admin panel. */
  triggerDescription?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Pipeline ────────────────────────────────────────────────

export interface GuardrailPipeline {
  id: string;
  name: string;
  guardrails: Guardrail[];
  shortCircuitOnDeny: boolean;
  evaluate(input: unknown, stage: GuardrailStage, context?: GuardrailEvaluationContext): Promise<GuardrailResult[]>;
}

// ─── Risk & Confidence ───────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskClassifier {
  classify(action: string, context?: Record<string, unknown>): Promise<{ level: RiskLevel; explanation: string }>;
}

export interface ConfidenceGate {
  threshold: number;
  action: 'block' | 'escalate' | 'warn' | 'log';
  evaluate(confidence: number): GuardrailDecision;
}

export interface ActionGate {
  allowedActions: string[];
  deniedActions: string[];
  evaluate(action: string): GuardrailDecision;
}

// ─── Governance ──────────────────────────────────────────────

export interface GovernanceRule {
  id: string;
  name: string;
  description?: string;
  condition: string;
  action: GuardrailDecision;
  enabled: boolean;
  priority: number;
}

export interface GovernanceContext {
  tenantId?: string;
  userId?: string;
  agentId?: string;
  rules: GovernanceRule[];
  evaluate(input: unknown): Promise<GuardrailResult[]>;
}

// ─── Runtime Policy ──────────────────────────────────────────

export interface RuntimePolicy {
  id: string;
  name: string;
  type: 'cost-ceiling' | 'token-limit' | 'rate-limit' | 'content-filter' | 'tool-restriction';
  config: Record<string, unknown>;
  enabled: boolean;
}

// ─── Async evaluation context (W1) ───────────────────────────

/** Extended evaluation context that carries optional model references for
 *  async (model-graded) guardrail evaluators. Backward-compatible superset of
 *  `GuardrailEvaluationContext`; sync evaluators ignore the extra fields. */
export interface AsyncGuardrailContext extends GuardrailEvaluationContext {
  /** LLM used for llm-judge and similar verdict-generation evaluators. */
  readonly model?: Model;
  /** Moderation API client for content-safety classification. */
  readonly moderationModel?: ModerationModel;
  /** Embedding model for semantic-grounding similarity checks. */
  readonly embeddingModel?: EmbeddingModel;
}

// ─── Escalation policy (W4) ──────────────────────────────────

export interface EscalationTrigger {
  /** Minimum accumulated warn-decision count to trigger escalation. */
  readonly minWarnCount?: number;
  /** Guardrail category names (e.g. 'cognitive') that count toward the threshold. */
  readonly categories?: readonly string[];
  /** Risk levels that trigger escalation regardless of warn count. */
  readonly riskLevels?: readonly RiskLevel[];
}

export interface EscalationPolicy {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly trigger: EscalationTrigger;
  /** 'block' halts the turn. 'require-approval' blocks pending a human task. */
  readonly onEscalate: 'block' | 'require-approval';
}

export interface EscalationResult {
  readonly escalated: boolean;
  readonly decision: GuardrailDecision;
  readonly policy?: EscalationPolicy;
  readonly taskId?: string;
  readonly reason?: string;
}

// ─── Per-tenant resolver (W6) ────────────────────────────────

export interface GuardrailResolverContext {
  readonly tenantId?: string;
  readonly persona?: string;
  readonly stage: GuardrailStage;
}

export interface GuardrailResolver {
  resolve(ctx: GuardrailResolverContext): Promise<Guardrail[]>;
}

// ─── Revision store (W7) ─────────────────────────────────────

export interface GuardrailRevision {
  readonly id: string;
  readonly guardrailId: string;
  readonly version: number;
  readonly snapshot: Guardrail;
  readonly before?: Guardrail;
  readonly actor: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface GuardrailRevisionStore {
  record(revision: GuardrailRevision): Promise<void>;
  list(guardrailId: string): Promise<GuardrailRevision[]>;
  /** Returns the revision active at or before the given ISO timestamp. */
  atTime(guardrailId: string, timestamp: string): Promise<GuardrailRevision | undefined>;
}
