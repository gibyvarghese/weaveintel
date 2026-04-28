/**
 * @weaveintel/core — Model routing contracts
 */

// ─── Routing Decision ────────────────────────────────────────

export interface RoutingDecision {
  modelId: string;
  providerId: string;
  reason: string;
  scores: Record<string, number>;
  alternatives: Array<{ modelId: string; providerId: string; score: number }>;
  timestamp: string;
  /** Phase 2: task-aware routing metadata (optional, populated by SmartModelRouter). */
  taskMeta?: {
    taskKey: string;
    inferredTaskKey: string;
    inferenceSource: TaskTypeInferenceSource;
    exclusionReasons?: Array<{ modelId: string; providerId: string; reason: string }>;
    capabilityScoreUsed?: boolean;
  };
}

// ─── Routing Policy ──────────────────────────────────────────

export type RoutingStrategy = 'cost-optimized' | 'latency-optimized' | 'quality-optimized' | 'balanced' | 'canary' | 'round-robin' | 'custom';

export interface RoutingPolicy {
  id: string;
  name: string;
  description?: string;
  strategy: RoutingStrategy;
  constraints?: RoutingConstraints;
  weights?: {
    cost?: number;
    latency?: number;
    quality?: number;
    reliability?: number;
    /** Task-aware capability dimension (Phase 2 anyWeave routing). */
    capability?: number;
  };
  fallbackModelId?: string;
  fallbackProviderId?: string;
  /**
   * Multi-hop fallback chain (anyWeave Phase 1). When present, supersedes the
   * single fallbackModelId/fallbackProviderId pair. Ordered by descending priority.
   */
  fallbackChain?: Array<{ modelId: string; providerId: string; priority?: number }>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RoutingConstraints {
  maxCostPerRequest?: number;
  maxLatencyMs?: number;
  minQualityScore?: number;
  requiredCapabilities?: string[];
  excludeProviders?: string[];
  excludeModels?: string[];
}

// ─── Model Health ────────────────────────────────────────────

export interface ModelHealth {
  modelId: string;
  providerId: string;
  available: boolean;
  avgLatencyMs: number;
  errorRate: number;
  lastChecked: string;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  requestsPerMinute?: number;
}

export interface ModelScore {
  modelId: string;
  providerId: string;
  costScore: number;
  latencyScore: number;
  qualityScore: number;
  reliabilityScore: number;
  /** Task-aware capability score (0..1 normalised). 0 when no capability data. */
  capabilityScore: number;
  overallScore: number;
}

// ─── Context ─────────────────────────────────────────────────

// ─── Task-aware routing (anyWeave Phase 2) ──────────────────

export type OutputModality = 'text' | 'image' | 'audio' | 'video' | 'embedding' | 'structured';

export type OptimisationStrategy = 'cheapest' | 'fastest' | 'balanced' | 'quality';

export type TaskTypeInferenceSource =
  | 'explicit'
  | 'agent_default'
  | 'tool_inference'
  | 'skill_metadata'
  | 'prompt_inference'
  | 'default';

/** Hints used by `inferTaskType` to map a request to a task key. */
export interface TaskTypeInferenceHints {
  toolPatterns?: string[];
  promptKeywords?: string[];
  skillCategories?: string[];
  skillTags?: string[];
}

/** Compact tool descriptor used during task-type inference. */
export interface RoutingToolDescriptor {
  name: string;
  description?: string;
}
/** @deprecated alias kept for transition; use RoutingToolDescriptor. */
export type ToolDescriptor = RoutingToolDescriptor;

/** Per-(model, task) capability row delivered to the router. */
export interface ModelCapabilityRow {
  modelId: string;
  providerId: string;
  taskKey: string;
  qualityScore: number; // 0..100
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsThinking?: boolean;
  supportsJsonMode?: boolean;
  supportsVision?: boolean;
  outputModality?: OutputModality;
  isActive?: boolean;
  tenantId?: string | null;
}

export interface RoutingContext {
  taskType?: string;
  requiredCapabilities?: string[];
  budget?: { maxCost: number; remaining: number };
  tenantId?: string;
  previousDecisions?: RoutingDecision[];
  /** Phase 2: required output modality for filtering (image/audio/etc). */
  outputModality?: OutputModality;
  /** Phase 2: tools the agent will pass — used both for inference and capability filter. */
  tools?: RoutingToolDescriptor[];
  /** Phase 2: per-call optimisation override (honours task default if absent). */
  optimisationStrategy?: OptimisationStrategy;
  /** Phase 2: hard ceiling on per-call cost in USD; candidates above are excluded. */
  maxCostPerCall?: number;
  /** Phase 2: agent context for default task-type lookup. */
  agentId?: string;
  /** Phase 2: skill metadata for inference. */
  skill?: { key?: string; category?: string; tags?: string[] };
  /** Phase 2: prompt text used during keyword-based inference. */
  prompt?: string;
}

// ─── Router ──────────────────────────────────────────────────

export interface ModelRouter {
  route(request: { prompt: string; context?: RoutingContext }, policy: RoutingPolicy): Promise<RoutingDecision>;
  getHealth(modelId: string, providerId: string): Promise<ModelHealth | null>;
  listHealth(): Promise<ModelHealth[]>;
  recordOutcome(decision: RoutingDecision, outcome: { latencyMs: number; success: boolean; cost?: number }): Promise<void>;
}

// ─── Fallback ────────────────────────────────────────────────

export interface FallbackPlan {
  id: string;
  name: string;
  chain: Array<{ modelId: string; providerId: string; priority: number }>;
  maxAttempts: number;
}
