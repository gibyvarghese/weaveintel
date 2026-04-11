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
  };
  fallbackModelId?: string;
  fallbackProviderId?: string;
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
  overallScore: number;
}

// ─── Context ─────────────────────────────────────────────────

export interface RoutingContext {
  taskType?: string;
  requiredCapabilities?: string[];
  budget?: { maxCost: number; remaining: number };
  tenantId?: string;
  previousDecisions?: RoutingDecision[];
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
