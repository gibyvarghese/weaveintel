/**
 * @weaveintel/core — Guardrail & governance contracts
 */

// ─── Guardrail ───────────────────────────────────────────────

export type GuardrailDecision = 'allow' | 'deny' | 'warn';
export type GuardrailStage = 'pre-execution' | 'mid-execution' | 'post-execution';
export type GuardrailType = 'regex' | 'blocklist' | 'length' | 'schema' | 'model-graded' | 'custom';

export interface GuardrailResult {
  decision: GuardrailDecision;
  guardrailId: string;
  explanation?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface Guardrail {
  id: string;
  name: string;
  description?: string;
  type: GuardrailType;
  stage: GuardrailStage;
  enabled: boolean;
  config: Record<string, unknown>;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Pipeline ────────────────────────────────────────────────

export interface GuardrailPipeline {
  id: string;
  name: string;
  guardrails: Guardrail[];
  shortCircuitOnDeny: boolean;
  evaluate(input: unknown, stage: GuardrailStage): Promise<GuardrailResult[]>;
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
