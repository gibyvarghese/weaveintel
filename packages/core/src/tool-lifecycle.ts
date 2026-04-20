/**
 * @weaveintel/core — Tool lifecycle contracts
 */

// ─── Risk Classification ─────────────────────────────────────

export type ToolRiskLevel = 'read-only' | 'write' | 'destructive' | 'privileged' | 'financial' | 'external-side-effect';

// ─── Tool Descriptor ─────────────────────────────────────────

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  version: string;
  riskLevel: ToolRiskLevel;
  category?: string;
  tags?: string[];
  sideEffects: boolean;
  requiresApproval: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  deprecated?: boolean;
  deprecationMessage?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ToolVersion {
  id: string;
  toolId: string;
  version: string;
  changelog?: string;
  breaking: boolean;
  createdAt: string;
}

// ─── Lifecycle Policy ────────────────────────────────────────

export interface ToolLifecyclePolicy {
  id: string;
  name: string;
  approvalRequired: boolean;
  allowedRiskLevels: ToolRiskLevel[];
  maxExecutionTimeMs?: number;
  rateLimitPerMinute?: number;
  requireDryRun: boolean;
  enabled: boolean;
}

// ─── Test Harness ────────────────────────────────────────────

export interface ToolTestCase {
  name: string;
  input: Record<string, unknown>;
  expectedOutput?: unknown;
  expectError?: boolean;
}

export interface ToolTestResult {
  testCase: string;
  passed: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface ToolTestHarness {
  run(toolId: string, cases: ToolTestCase[]): Promise<ToolTestResult[]>;
}

// ─── Health ──────────────────────────────────────────────────

export interface ToolHealth {
  toolId: string;
  available: boolean;
  avgDurationMs: number;
  errorRate: number;
  lastUsed?: string;
  totalInvocations: number;
}

// ─── Execution Policy ────────────────────────────────────────

export interface ToolExecutionPolicy {
  id: string;
  toolId: string;
  maxConcurrent?: number;
  timeoutMs?: number;
  retryOnError: boolean;
  maxRetries?: number;
  dryRunFirst?: boolean;
  logInputOutput: boolean;
}

// ─── Phase 2: Effective (merged) runtime policy ───────────────

export type ToolPolicyViolationReason =
  | 'rate_limited'
  | 'approval_required'
  | 'risk_level_blocked'
  | 'circuit_open'
  | 'disabled'
  | 'persona_blocked'
  | 'credential_missing';

export interface EffectiveToolPolicy {
  /** Whether the tool is permitted to be invoked at all. */
  enabled: boolean;
  /** Resolved risk level from catalog or override. */
  riskLevel: ToolRiskLevel;
  /** Whether an approval step is required before execution. */
  requiresApproval: boolean;
  /** Maximum wall-clock time before the invocation is killed. */
  timeoutMs?: number;
  /** Max calls per minute for this tool across the current scope. */
  rateLimitPerMinute?: number;
  /** Max concurrent invocations. */
  maxConcurrent?: number;
  /** Whether to perform a dry run validation before live execution. */
  requireDryRun: boolean;
  /** Whether inputs and outputs should be logged to audit. */
  logInputOutput: boolean;
  /** Allowed risk levels for automatic execution. Higher levels require approval. */
  allowedRiskLevels: ToolRiskLevel[];
  /** Source of this policy (default, global, skill-override, persona-override). */
  source: 'default' | 'global_policy' | 'skill_override' | 'persona_override';
  /** Policy record ID if resolved from DB. */
  policyId?: string;
}

// ─── Phase 2: Audit event ────────────────────────────────────

export type ToolAuditOutcome =
  | 'success'
  | 'error'
  | 'denied_policy'
  | 'denied_persona'
  | 'denied_rate_limit'
  | 'denied_approval'
  | 'timeout'
  | 'circuit_open'
  | 'simulation';

export interface ToolAuditEvent {
  toolName: string;
  chatId?: string;
  userId?: string;
  agentPersona?: string;
  skillKey?: string;
  policyId?: string;
  outcome: ToolAuditOutcome;
  violationReason?: ToolPolicyViolationReason;
  durationMs?: number;
  /** First 500 chars of input JSON, when logInputOutput is true. */
  inputPreview?: string;
  /** First 500 chars of output content, when logInputOutput is true. */
  outputPreview?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
