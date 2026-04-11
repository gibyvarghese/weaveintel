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
