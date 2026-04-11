/**
 * @weaveintel/core — Replay & evaluation regression contracts
 */

// ─── Replay ──────────────────────────────────────────────────

export interface ReplayScenario {
  id: string;
  name: string;
  description?: string;
  input: unknown;
  expectedOutput?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ReplayEngine {
  replay(scenarioId: string, options?: { modelId?: string; providerId?: string }): Promise<ReplayResult>;
  replayBatch(scenarioIds: string[]): Promise<ReplayResult[]>;
}

export interface ReplayResult {
  scenarioId: string;
  output: unknown;
  matchesExpected: boolean;
  score?: number;
  durationMs: number;
  modelId?: string;
  providerId?: string;
  timestamp: string;
}

// ─── Benchmark ───────────────────────────────────────────────

export interface BenchmarkSuite {
  id: string;
  name: string;
  description?: string;
  scenarios: ReplayScenario[];
  createdAt?: string;
}

export interface EvalScenario {
  id: string;
  name: string;
  input: unknown;
  golden: unknown;
  assertions: string[];
  tags?: string[];
}

// ─── Regression ──────────────────────────────────────────────

export interface EvalRegression {
  id: string;
  suiteId: string;
  baselineRunId: string;
  candidateRunId: string;
  regressions: RegressionItem[];
  improvements: RegressionItem[];
  unchanged: number;
  timestamp: string;
}

export interface RegressionItem {
  scenarioId: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
}

// ─── Comparison ──────────────────────────────────────────────

export interface ComparisonRun {
  id: string;
  name: string;
  suiteId: string;
  configs: Array<{ modelId: string; providerId: string; label: string }>;
  results: Record<string, ReplayResult[]>;
  winner?: string;
  timestamp: string;
}

// ─── Golden Cases ────────────────────────────────────────────

export interface GoldenCase {
  id: string;
  name: string;
  input: unknown;
  goldenOutput: unknown;
  tolerance?: number;
  tags?: string[];
  createdAt?: string;
}

// ─── Artifacts ───────────────────────────────────────────────

export interface RunArtifact {
  id: string;
  runId: string;
  type: 'trace' | 'output' | 'metrics' | 'log';
  data: unknown;
  createdAt: string;
}
