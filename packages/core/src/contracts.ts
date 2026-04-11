/**
 * @weaveintel/core — Completion contracts & validation
 */

// ─── Task Contract ───────────────────────────────────────────

export interface TaskContract {
  id: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  acceptanceCriteria: AcceptanceCriteria[];
  maxAttempts?: number;
  timeoutMs?: number;
  createdAt?: string;
}

export interface AcceptanceCriteria {
  id: string;
  description: string;
  type: 'schema' | 'assertion' | 'model-graded' | 'human-review' | 'custom';
  config?: Record<string, unknown>;
  required: boolean;
  weight?: number;
}

// ─── Completion ──────────────────────────────────────────────

export interface CompletionContract {
  taskContractId: string;
  evidenceRequired: string[];
  minConfidence?: number;
  requireHumanReview?: boolean;
}

export interface CompletionReport {
  taskContractId: string;
  status: 'fulfilled' | 'partial' | 'failed';
  results: ValidationResult[];
  evidence: EvidenceBundle;
  confidence: number;
  completedAt: string;
}

export interface ValidationResult {
  criteriaId: string;
  passed: boolean;
  score?: number;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

// ─── Evidence ────────────────────────────────────────────────

export interface EvidenceBundle {
  items: EvidenceItem[];
}

export interface EvidenceItem {
  type: 'text' | 'file' | 'url' | 'metric' | 'trace';
  label: string;
  value: unknown;
}

// ─── Outcome ─────────────────────────────────────────────────

export type TaskOutcomeStatus = 'success' | 'partial-success' | 'failure' | 'timeout' | 'cancelled';

export interface TaskOutcome {
  contractId: string;
  status: TaskOutcomeStatus;
  output?: unknown;
  failureReason?: FailureReason;
  report?: CompletionReport;
}

export interface FailureReason {
  code: string;
  message: string;
  category: 'validation' | 'timeout' | 'resource' | 'permission' | 'model-error' | 'user-cancelled';
  details?: Record<string, unknown>;
  recoverable: boolean;
}

// ─── Validator ───────────────────────────────────────────────

export interface CompletionValidator {
  validate(output: unknown, contract: TaskContract): Promise<CompletionReport>;
}
