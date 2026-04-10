/**
 * @weaveintel/core — Security & redaction contracts
 *
 * Why: Security is built-in, not bolted on. Redaction runs before logging,
 * memory persistence, and any outbound data flow. Policy engines gate
 * tool use, connector access, and content classification.
 */

import type { ExecutionContext } from './context.js';

// ─── Redaction ───────────────────────────────────────────────

export interface RedactionResult {
  readonly redacted: string;
  readonly detections: readonly Detection[];
  readonly wasModified: boolean;
}

export interface Detection {
  readonly type: string; // e.g., 'email', 'phone', 'ssn', 'credit_card', 'custom'
  readonly start: number;
  readonly end: number;
  readonly original?: string; // only if reversible tokenization is allowed
  readonly token?: string; // replacement token for reversible redaction
}

export interface Redactor {
  redact(ctx: ExecutionContext, text: string): Promise<RedactionResult>;
  restore?(ctx: ExecutionContext, text: string, tokens: Detection[]): Promise<string>;
}

export interface RedactionPolicy {
  readonly patterns: readonly RedactionPattern[];
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly reversible?: boolean;
}

export interface RedactionPattern {
  readonly name: string;
  readonly type: 'regex' | 'builtin' | 'model';
  readonly pattern?: string; // for regex type
  readonly builtinType?: string; // for builtin type (e.g., 'email', 'phone')
  readonly replacement?: string;
}

// ─── Content classification ──────────────────────────────────

export interface ClassificationResult {
  readonly labels: readonly ClassificationLabel[];
  readonly flagged: boolean;
}

export interface ClassificationLabel {
  readonly category: string;
  readonly confidence: number;
  readonly flagged: boolean;
}

export interface ContentClassifier {
  classify(ctx: ExecutionContext, content: string): Promise<ClassificationResult>;
}

// ─── Policy engine ───────────────────────────────────────────

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly policies: readonly string[];
}

export interface PolicyRule {
  readonly name: string;
  readonly description?: string;
  evaluate(ctx: ExecutionContext, input: PolicyInput): Promise<PolicyEvaluation>;
}

export interface PolicyInput {
  readonly action: string;
  readonly resource?: string;
  readonly data?: Record<string, unknown>;
}

export interface PolicyEngine {
  addRule(rule: PolicyRule): void;
  evaluate(ctx: ExecutionContext, input: PolicyInput): Promise<PolicyEvaluation>;
}

// ─── Access evaluation ───────────────────────────────────────

export interface AccessEvaluator {
  canAccess(
    ctx: ExecutionContext,
    resource: string,
    action: string,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

// ─── Audit logging ───────────────────────────────────────────

export interface AuditEntry {
  readonly timestamp: string;
  readonly executionId: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly action: string;
  readonly resource?: string;
  readonly outcome: 'success' | 'failure' | 'denied';
  readonly details?: Record<string, unknown>;
}

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
}

// ─── Secret resolution ───────────────────────────────────────

export interface SecretResolver {
  resolve(key: string): Promise<string | undefined>;
}
